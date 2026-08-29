import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureOwnerToken,
  extractQuickTunnelOrigin,
  startChatGptSetup
} from "../src/setup-chatgpt.js";

async function tempDir(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "setup-chatgpt-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test("extractQuickTunnelOrigin finds a Cloudflare quick tunnel URL", () => {
  assert.equal(
    extractQuickTunnelOrigin("INF Visit https://quiet-river-42.trycloudflare.com to connect"),
    "https://quiet-river-42.trycloudflare.com"
  );
  assert.equal(extractQuickTunnelOrigin("no URL yet"), null);
});

test("ensureOwnerToken creates a private token and reuses it", async (t) => {
  const directory = await tempDir(t);
  const tokenPath = path.join(directory, "secrets", "owner-token");
  const first = await ensureOwnerToken(tokenPath);
  const second = await ensureOwnerToken(tokenPath);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.token, second.token);
  assert.ok(first.token.length >= 32);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(tokenPath)).mode & 0o777, 0o600);
  }
});

test("startChatGptSetup registers a workspace and serves OAuth MCP", async (t) => {
  const directory = await tempDir(t);
  const root = path.join(directory, "demo-project");
  const tunnelFixture = path.join(directory, "fake-cloudflared");
  const registry = path.join(directory, "config", "workspaces.json");
  const ownerTokenFile = path.join(directory, "config", "owner-token");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "README.md"), "demo\n");
  await fs.writeFile(tunnelFixture, `#!/usr/bin/env node
process.stderr.write("INF https://fixture-tunnel.trycloudflare.com\\n");
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  await fs.chmod(tunnelFixture, 0o755);

  const handle = await startChatGptSetup({
    root,
    registry,
    ownerTokenFile,
    port: await freePort(),
    tunnelCommand: tunnelFixture,
    tunnelTimeoutMs: 5_000
  });
  t.after(() => handle.stop());

  assert.equal(handle.workspace.id, "demo-project");
  assert.equal(handle.mcpUrl, "https://fixture-tunnel.trycloudflare.com/mcp");
  assert.equal(handle.profile, "full");
  const health = await fetch(`${handle.localOrigin}/healthz`);
  assert.deepEqual(await health.json(), {
    ok: true,
    service: "mcp-local-editor",
    transport: "streamable-http",
    auth: "oauth"
  });
  const registryDocument = JSON.parse(await fs.readFile(registry, "utf8"));
  assert.equal(registryDocument.workspaces["demo-project"].root, await fs.realpath(root));
  assert.ok((await fs.readFile(ownerTokenFile, "utf8")).trim().length >= 32);
});
