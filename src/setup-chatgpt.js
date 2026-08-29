import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Workspace } from "./core.js";
import { ToolError } from "./errors.js";
import { McpHttpServer } from "./mcp-http.js";
import { WorkspaceRegistry } from "./registry.js";
import { LocalEditorService } from "./service.js";
import { SessionManager } from "./sessions.js";

const TRANSCRIPT_LIMIT = 16 * 1024;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function extractQuickTunnelOrigin(value) {
  const match = String(value ?? "").match(/https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com\b/i);
  return match ? new URL(match[0]).origin : null;
}

export async function ensureOwnerToken(filePath, { random = randomBytes } = {}) {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  let created = false;
  try {
    await fs.writeFile(resolved, `${random(32).toString("hex")}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw new ToolError("OWNER_TOKEN_WRITE_FAILED", "could not create the owner token file", { cause: String(error) });
    }
  }

  const token = (await fs.readFile(resolved, "utf8")).trim();
  if (token.length < 32 || /[\r\n]/.test(token)) {
    throw new ToolError("INVALID_OWNER_TOKEN", "owner token must be at least 32 characters and contain no line breaks");
  }
  if (process.platform !== "win32") await fs.chmod(resolved, 0o600);
  return { token, filePath: resolved, created };
}

export async function ensureRegisteredWorkspace(registry, {
  root,
  displayName = undefined,
  commandsConfig = undefined
}) {
  const workspace = await Workspace.open(root);
  const existing = (await registry.list()).find((entry) => entry.root === workspace.root);
  if (existing) {
    if (displayName === undefined && commandsConfig === undefined) return existing;
    return await registry.add({
      id: existing.id,
      root: workspace.root,
      displayName,
      commandsConfig,
      replace: true
    });
  }
  return await registry.addFolder({
    root: workspace.root,
    displayName,
    commandsConfig: commandsConfig ?? null
  });
}

async function stopChild(child, exitPromise) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([exitPromise, delay(1500)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exitPromise, delay(500)]);
  }
}

export async function startQuickTunnel({
  host,
  port,
  command = "cloudflared",
  timeoutMs = 45_000,
  env = process.env,
  spawnProcess = spawn
}) {
  const target = `http://${host}:${port}`;
  const child = spawnProcess(command, ["tunnel", "--no-autoupdate", "--url", target], {
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  let transcript = "";
  let readySettled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const exitPromise = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  const append = (chunk) => {
    transcript = `${transcript}${String(chunk)}`.slice(-TRANSCRIPT_LIMIT);
    const publicOrigin = extractQuickTunnelOrigin(transcript);
    if (publicOrigin && !readySettled) {
      readySettled = true;
      resolveReady(publicOrigin);
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.once("error", (error) => {
    if (readySettled) return;
    readySettled = true;
    const code = error?.code === "ENOENT" ? "CLOUDFLARED_NOT_FOUND" : "QUICK_TUNNEL_START_FAILED";
    const message = error?.code === "ENOENT"
      ? `could not find ${command}; install cloudflared and try again`
      : `could not start ${command}: ${error.message}`;
    rejectReady(new ToolError(code, message));
  });
  exitPromise.then(({ code, signal }) => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(new ToolError("QUICK_TUNNEL_EXITED", "cloudflared exited before publishing a tunnel URL", {
      code,
      signal,
      output: transcript.trim()
    }));
  });

  const timer = setTimeout(() => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(new ToolError("QUICK_TUNNEL_TIMEOUT", `cloudflared did not publish a tunnel URL within ${timeoutMs} ms`, {
      output: transcript.trim()
    }));
  }, timeoutMs);

  let publicOrigin;
  try {
    publicOrigin = await ready;
  } catch (error) {
    await stopChild(child, exitPromise);
    throw error;
  } finally {
    clearTimeout(timer);
  }

  return {
    child,
    publicOrigin,
    exitPromise,
    output: () => transcript,
    stop: async () => await stopChild(child, exitPromise)
  };
}

export async function startChatGptSetup({
  root,
  registry: registryPath,
  displayName = undefined,
  commands = undefined,
  profile = "full",
  host = "127.0.0.1",
  port = 8790,
  sessionTtlSec = 1800,
  ownerTokenFile = path.join(path.dirname(path.resolve(registryPath)), ".mcp-local-editor-owner-token"),
  oauthStore = `${path.resolve(registryPath)}.oauth.json`,
  tunnelCommand = "cloudflared",
  tunnelTimeoutMs = 45_000
}, dependencies = {}) {
  const registry = new WorkspaceRegistry(registryPath);
  const workspace = await ensureRegisteredWorkspace(registry, {
    root,
    displayName,
    commandsConfig: commands
  });
  const ownerToken = await ensureOwnerToken(ownerTokenFile, dependencies);
  const tunnel = await startQuickTunnel({
    host,
    port,
    command: tunnelCommand,
    timeoutMs: tunnelTimeoutMs,
    env: dependencies.env ?? process.env,
    spawnProcess: dependencies.spawnProcess ?? spawn
  });

  let server;
  let address;
  try {
    const sessions = new SessionManager(registry, {
      defaultTtlSec: sessionTtlSec,
      maxTtlSec: sessionTtlSec
    });
    const service = new LocalEditorService(registry, sessions, { profile });
    server = new McpHttpServer(service, {
      host,
      port,
      publicUrl: tunnel.publicOrigin,
      auth: {
        mode: "oauth",
        ownerToken: ownerToken.token,
        storePath: oauthStore
      }
    });
    address = await server.start();
  } catch (error) {
    await tunnel.stop();
    throw error;
  }

  let stopping = false;
  const serverClosed = server.waitUntilClosed();
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await Promise.allSettled([server.stop(), tunnel.stop()]);
  };
  const wait = async () => {
    const result = await Promise.race([
      serverClosed.then(() => ({ source: "server" })),
      tunnel.exitPromise.then((exit) => ({ source: "tunnel", ...exit }))
    ]);
    if (!stopping) {
      throw new ToolError("SETUP_CONNECTION_STOPPED", `${result.source} stopped unexpectedly`, result);
    }
    return result;
  };

  return {
    workspace,
    registryPath: registry.filePath,
    ownerTokenFile: ownerToken.filePath,
    ownerTokenCreated: ownerToken.created,
    oauthStore: path.resolve(oauthStore),
    profile,
    publicOrigin: tunnel.publicOrigin,
    mcpUrl: `${tunnel.publicOrigin}/mcp`,
    localOrigin: `http://${address.host}:${address.port}`,
    stop,
    wait
  };
}

function readyMessage(handle) {
  return `
MCP Local Editor is ready for ChatGPT.

Workspace:      ${handle.workspace.id} (${handle.workspace.displayName})
MCP URL:        ${handle.mcpUrl}
Authentication: OAuth
Profile:        ${handle.profile}
Owner token:    ${handle.ownerTokenFile}

In ChatGPT web:
1. Enable Developer mode in Settings > Security and login.
2. Open Plugins, create a developer-mode app, and use the MCP URL above.
3. Select OAuth. When the approval page opens, paste the owner token from the local file above.
4. Add the app to a normal Chat conversation.

Keep this command running while ChatGPT uses the local workspace. Press Ctrl-C to stop.
The temporary trycloudflare.com URL changes after every restart and must then be reconnected.
ChatGPT plan, model availability, and usage limits still apply.
`;
}

export async function runChatGptSetup(options, dependencies = {}) {
  const output = dependencies.output ?? process.stdout;
  const errorOutput = dependencies.errorOutput ?? process.stderr;
  const handle = await startChatGptSetup(options, dependencies);
  output.write(readyMessage(handle));

  const onSignal = () => {
    handle.stop().catch((error) => {
      errorOutput.write(`[mcp-local-editor] setup shutdown failed: ${error.message}\n`);
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await handle.wait();
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await handle.stop();
  }
}
