import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseArgs } from "../src/cli.js";
import { DashboardServer } from "../src/dashboard.js";
import { ToolError } from "../src/errors.js";
import { WorkspaceRegistry } from "../src/registry.js";

async function tempDir(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function request(port, pathname, { method = "GET", body } = {}) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return await new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode,
          type: res.headers["content-type"],
          body: (res.headers["content-type"] || "").includes("json") ? JSON.parse(text) : text
        });
      });
    });
    req.once("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("parseArgs supports dashboard", () => {
  const parsed = parseArgs(["dashboard", "--port", "8799"], {});
  assert.equal(parsed.command, "dashboard");
  assert.equal(parsed.port, 8799);
});

test("dashboard lists, adds, and removes workspaces on one status page", async (t) => {
  const root = path.join(await tempDir(t), "notes");
  await fs.mkdir(root);
  const port = await freePort();
  const registry = new WorkspaceRegistry(path.join(await tempDir(t), "registry.json"));
  const server = new DashboardServer(registry, {
    port,
    pickFolder: async () => root,
    fetchImpl: async () => ({ ok: true, text: async () => "ready" })
  });
  await server.start();
  t.after(() => server.stop());

  const page = await request(port, "/");
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.body, /파인더에서 폴더 추가/);

  const empty = await request(port, "/api/state");
  assert.equal(empty.body.tunnel.ready, true);
  assert.deepEqual(empty.body.workspaces, []);

  const added = await request(port, "/api/workspaces/pick", { method: "POST", body: {} });
  assert.equal(added.body.workspace.workspace_id, "notes");

  const listed = await request(port, "/api/state");
  assert.equal(listed.body.workspaces.length, 1);
  assert.equal(listed.body.workspaces[0].display_name, "notes");

  const removed = await request(port, "/api/workspaces/notes", { method: "DELETE" });
  assert.equal(removed.body.removed.workspace_id, "notes");
  assert.equal((await request(port, "/api/state")).body.workspaces.length, 0);
});

test("dashboard exposes watchdog recovery on the status page", async (t) => {
  const port = await freePort();
  const registry = new WorkspaceRegistry(path.join(await tempDir(t), "registry.json"));
  const watchdog = {
    started: 0,
    stopped: 0,
    start() { this.started += 1; },
    stop() { this.stopped += 1; },
    status() { return { enabled: true, last_recovery: { at: "2026-08-29T13:35:56.000+09:00", reason: "deadline_without_later_forward" } }; }
  };
  const server = new DashboardServer(registry, {
    port,
    fetchImpl: async () => ({ ok: true, text: async () => "ready" }),
    watchdog
  });
  await server.start();
  t.after(() => server.stop());

  assert.equal(watchdog.started, 1);
  const state = await request(port, "/api/state");
  assert.equal(state.body.watchdog.last_recovery.reason, "deadline_without_later_forward");
  const page = await request(port, "/");
  assert.match(page.body, /세션 복구됨/);
});

test("dashboard pick cancel stays a client error", async () => {
  const server = new DashboardServer(new WorkspaceRegistry("/tmp/unused.json"), {
    pickFolder: async () => {
      throw new ToolError("FOLDER_PICK_CANCELLED", "folder picker was cancelled");
    }
  });
  await assert.rejects(server.pickFolder(), (error) => error.code === "FOLDER_PICK_CANCELLED");
});
