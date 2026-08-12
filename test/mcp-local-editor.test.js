import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { parseArgs } from "../src/cli.js";
import { commandRun, fileEdit, fileRead, gitDiff, loadConfig, normalizeConfig, repoSearch, Workspace } from "../src/core.js";
import { ToolError } from "../src/errors.js";
import { McpStdioServer } from "../src/mcp-stdio.js";
import { defaultRegistryPath, WorkspaceRegistry } from "../src/registry.js";
import { LocalEditorService, TOOL_DEFINITIONS } from "../src/service.js";
import { SessionManager } from "../src/sessions.js";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("src/cli.js");

async function tempDir(t, prefix = "mcp-local-editor-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function git(cwd, args) {
  return await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function makeRepo(t, name, content = "hello\n") {
  const parent = await tempDir(t, `${name}-`);
  const root = path.join(parent, "repo");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "file.txt"), content);
  return root;
}

function makeService(registry, options = {}) {
  const sessions = new SessionManager(registry, options);
  return { sessions, service: new LocalEditorService(registry, sessions) };
}

async function register(registry, id, root, commandsConfig = undefined) {
  return await registry.add({ id, root, commandsConfig, displayName: id.toUpperCase() });
}

async function mcpSession(service, requests) {
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { text += chunk; });
  const server = new McpStdioServer(service, { input, output, errorOutput });
  const running = server.start();
  for (const request of requests) input.write(`${JSON.stringify(request)}\n`);
  input.end();
  await running;
  return text.trim().split("\n").filter(Boolean).map(JSON.parse);
}

async function cli(args, options = {}) {
  return await execFileAsync(process.execPath, [CLI, ...args], { encoding: "utf8", ...options });
}

test("parseArgs defaults to serve and supports registry configuration", () => {
  const parsed = parseArgs(["--registry", "/tmp/workspaces.json", "--session-ttl-sec", "600"], {});
  assert.equal(parsed.command, "serve");
  assert.equal(parsed.registry, "/tmp/workspaces.json");
  assert.equal(parsed.sessionTtlSec, 600);
});

test("parseArgs supports workspace add, list, and remove", () => {
  assert.equal(parseArgs(["workspace", "add", "repo", "/tmp/repo", "--replace"], {}).replace, true);
  assert.equal(parseArgs(["workspace", "list", "--json"], {}).json, true);
  assert.equal(parseArgs(["workspace", "remove", "repo"], {}).id, "repo");
});

test("parseArgs gives a migration error for removed single-root mode", () => {
  assert.throws(() => parseArgs(["--root", "/tmp/repo"], {}), /removed in v0\.2/);
});

test("defaultRegistryPath honors XDG_CONFIG_HOME", () => {
  assert.equal(defaultRegistryPath({ env: { XDG_CONFIG_HOME: "/tmp/x" } }), "/tmp/x/mcp-local-editor/workspaces.json");
});

test("defaultRegistryPath stores the registry next to the package", () => {
  assert.equal(defaultRegistryPath({ env: {}, packageRoot: "/Users/example/mcp-local-editor" }), "/Users/example/mcp-local-editor/workspaces.local.json");
});

test("Workspace rejects lexical path escapes", async (t) => {
  const root = await makeRepo(t, "lexical");
  const workspace = await Workspace.open(root);
  await assert.rejects(workspace.resolveExistingFile("../outside"), (error) => error.code === "PATH_OUTSIDE_ROOT");
});

test("Workspace rejects symlinks that resolve outside the root", async (t) => {
  const root = await makeRepo(t, "symlink");
  const outside = path.join(path.dirname(root), "outside.txt");
  await fs.writeFile(outside, "secret");
  await fs.symlink(outside, path.join(root, "escape.txt"));
  await assert.rejects((await Workspace.open(root)).resolveExistingFile("escape.txt"), (error) => error.code === "PATH_OUTSIDE_ROOT");
});

test("file_read returns a full-file hash and bounded line slice", async (t) => {
  const root = await makeRepo(t, "read", "one\ntwo\nthree\n");
  const result = await fileRead(await Workspace.open(root), { path: "file.txt", start_line: 2, end_line: 3 });
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.content, "two\nthree");
});

test("file_edit applies exact replacements and rejects stale hashes", async (t) => {
  const root = await makeRepo(t, "edit", "alpha\nbeta\n");
  const workspace = await Workspace.open(root);
  const read = await fileRead(workspace, { path: "file.txt" });
  await fileEdit(workspace, { path: "file.txt", expected_sha256: read.sha256, replacements: [{ old_text: "beta", new_text: "gamma" }] });
  assert.equal(await fs.readFile(path.join(root, "file.txt"), "utf8"), "alpha\ngamma\n");
  await assert.rejects(fileEdit(workspace, { path: "file.txt", expected_sha256: read.sha256, replacements: [{ old_text: "gamma", new_text: "delta" }] }), (error) => error.code === "STALE_FILE");
});

test("file_edit validates every replacement before writing", async (t) => {
  const root = await makeRepo(t, "atomic", "first\nsecond\n");
  const workspace = await Workspace.open(root);
  const read = await fileRead(workspace, { path: "file.txt" });
  await assert.rejects(fileEdit(workspace, {
    path: "file.txt",
    expected_sha256: read.sha256,
    replacements: [{ old_text: "first", new_text: "changed" }, { old_text: "missing", new_text: "never" }]
  }), (error) => error.code === "TEXT_NOT_FOUND");
  assert.equal(await fs.readFile(path.join(root, "file.txt"), "utf8"), "first\nsecond\n");
});

test("command_run executes only configured argv", async (t) => {
  const root = await makeRepo(t, "command");
  const config = normalizeConfig({ commands: { verify: { argv: [process.execPath, "-e", "process.stdout.write('ok')"], timeoutSec: 5 } } });
  const result = await commandRun(await Workspace.open(root), config, { command_id: "verify" });
  assert.equal(result.stdout, "ok");
  await assert.rejects(commandRun(await Workspace.open(root), config, { command_id: "unknown" }), (error) => error.code === "COMMAND_NOT_ALLOWED");
});

test("command_run reloads the current workspace command config", async (t) => {
  const root = await makeRepo(t, "reload");
  const configPath = path.join(root, "commands.json");
  await fs.writeFile(configPath, JSON.stringify({ commands: { verify: { argv: [process.execPath, "-e", "process.stdout.write('one')"] } } }));
  const registry = new WorkspaceRegistry(path.join(await tempDir(t), "registry.json"));
  await register(registry, "repo", root, configPath);
  const { service } = makeService(registry);
  const opened = await service.call("workspace_open", { workspace_id: "repo", access: "write" });
  assert.equal((await service.call("command_run", { session_id: opened.session_id, command_id: "verify" })).stdout, "one");
  await fs.writeFile(configPath, JSON.stringify({ commands: { verify: { argv: [process.execPath, "-e", "process.stdout.write('two')"] } } }));
  assert.equal((await service.call("command_run", { session_id: opened.session_id, command_id: "verify" })).stdout, "two");
});

test("repo_search returns repository-relative matches", async (t) => {
  const root = await makeRepo(t, "search");
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "a.js"), "const needle = 1;\n");
  const result = await repoSearch(await Workspace.open(root), { query: "needle", glob: "**/*.js" });
  assert.equal(result.matches[0].path, "src/a.js");
});

test("git_diff returns changes without mutating Git", async (t) => {
  const root = await makeRepo(t, "git");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await git(root, ["add", "file.txt"]);
  await git(root, ["commit", "-m", "initial"]);
  await fs.appendFile(path.join(root, "file.txt"), "change\n");
  const result = await gitDiff(await Workspace.open(root));
  assert.match(result.unstaged_diff, /\+change/);
});

test("WorkspaceRegistry persists add, replace, list, and remove operations", async (t) => {
  const registry = new WorkspaceRegistry(path.join(await tempDir(t), "registry.json"));
  const a = await makeRepo(t, "rega");
  const b = await makeRepo(t, "regb");
  await registry.add({ id: "repo", root: a, displayName: "Original" });
  assert.equal((await registry.list())[0].displayName, "Original");
  await registry.add({ id: "repo", root: b, replace: true });
  assert.equal((await registry.get("repo")).root, await fs.realpath(b));
  await registry.remove("repo");
  assert.equal((await registry.list()).length, 0);
});

test("WorkspaceRegistry serializes concurrent mutations", async (t) => {
  const registry = new WorkspaceRegistry(path.join(await tempDir(t), "registry.json"));
  const roots = await Promise.all(["a", "b", "c"].map((name) => makeRepo(t, `concurrent-${name}`)));
  await Promise.all(roots.map((root, index) => registry.add({ id: `repo${index}`, root })));
  assert.deepEqual((await registry.list()).map((entry) => entry.id), ["repo0", "repo1", "repo2"]);
});

test("WorkspaceRegistry rejects duplicate roots under different ids", async (t) => {
  const registry = new WorkspaceRegistry(path.join(await tempDir(t), "registry.json"));
  const root = await makeRepo(t, "duplicate");
  await registry.add({ id: "a", root });
  await assert.rejects(registry.add({ id: "b", root }), (error) => error.code === "WORKSPACE_ROOT_ALREADY_REGISTERED");
});

test("WorkspaceRegistry writes private registry files on POSIX", async (t) => {
  const registry = new WorkspaceRegistry(path.join(await tempDir(t), "registry.json"));
  await registry.add({ id: "repo", root: await makeRepo(t, "mode") });
  if (process.platform !== "win32") assert.equal((await fs.stat(registry.filePath)).mode & 0o777, 0o600);
});

test("workspace_list reports unavailable roots without exposing absolute paths", async (t) => {
  const registry = new WorkspaceRegistry(path.join(await tempDir(t), "registry.json"));
  const root = await makeRepo(t, "unavailable");
  await registry.add({ id: "repo", root, displayName: "Repo" });
  await fs.rm(root, { recursive: true, force: true });
  const { service } = makeService(registry);
  const result = await service.call("workspace_list", {});
  assert.equal(result.workspaces[0].available, false);
  assert.equal(JSON.stringify(result).includes(path.dirname(root)), false);
});

test("a running service sees workspaces added later without restart", async (t) => {
  const registry = new WorkspaceRegistry(path.join(await tempDir(t), "registry.json"));
  const { service } = makeService(registry);
  assert.equal((await service.call("workspace_list", {})).workspaces.length, 0);
  await register(registry, "later", await makeRepo(t, "later"));
  assert.equal((await service.call("workspace_list", {})).workspaces[0].workspace_id, "later");
});

test("workspace_open creates a short-lived workspace-bound session with per-workspace commands", async (t) => {
  const root = await makeRepo(t, "open");
  const config = path.join(root, "commands.json");
  await fs.writeFile(config, JSON.stringify({ commands: { verify: { argv: [process.execPath, "-e", "void 0"] } } }));
  const registry = new WorkspaceRegistry(path.join(await tempDir(t), "registry.json"));
  await register(registry, "repo", root, config);
  const { service } = makeService(registry);
  const opened = await service.call("workspace_open", { workspace_id: "repo", access: "write" });
  assert.match(opened.session_id, /^ses_/);
  assert.equal(opened.commands[0].command_id, "verify");
  assert.equal("root" in opened, false);
});

test("read sessions cannot edit files or execute commands", async (t) => {
  const root = await makeRepo(t, "readonly");
  const config = path.join(root, "commands.json");
  await fs.writeFile(config, JSON.stringify({ commands: { verify: { argv: [process.execPath, "-e", "void 0"] } } }));
  const registry = new WorkspaceRegistry(path.join(await tempDir(t), "registry.json"));
  await register(registry, "repo", root, config);
  const { service } = makeService(registry);
  const opened = await service.call("workspace_open", { workspace_id: "repo", access: "read" });
  const read = await service.call("file_read", { session_id: opened.session_id, path: "file.txt" });
  await assert.rejects(service.call("file_edit", { session_id: opened.session_id, path: "file.txt", expected_sha256: read.sha256, replacements: [{ old_text: "hello", new_text: "bye" }] }), (error) => error.code === "PERMISSION_DENIED");
  await assert.rejects(service.call("command_run", { session_id: opened.session_id, command_id: "verify" }), (error) => error.code === "PERMISSION_DENIED");
});

test("expired sessions must be reopened", async (t) => {
  let now = 1_000_000;
  const registry = new WorkspaceRegistry(path.join(await tempDir(t), "registry.json"));
  await register(registry, "repo", await makeRepo(t, "expiry"));
  const { service } = makeService(registry, { defaultTtlSec: 60, maxTtlSec: 60, now: () => now });
  const opened = await service.call("workspace_open", { workspace_id: "repo" });
  now += 60_000;
  await assert.rejects(service.call("file_read", { session_id: opened.session_id, path: "file.txt" }), (error) => error.code === "SESSION_EXPIRED");
});

test("registry removal or replacement revokes existing sessions", async (t) => {
  const registry = new WorkspaceRegistry(path.join(await tempDir(t), "registry.json"));
  const root = await makeRepo(t, "revoke");
  await register(registry, "repo", root);
  const { service } = makeService(registry);
  const opened = await service.call("workspace_open", { workspace_id: "repo" });
  await registry.remove("repo");
  await assert.rejects(service.call("file_read", { session_id: opened.session_id, path: "file.txt" }), (error) => error.code === "SESSION_REVOKED");
});

test("concurrent sessions remain isolated across registered workspaces", async (t) => {
  const registry = new WorkspaceRegistry(path.join(await tempDir(t), "registry.json"));
  const a = await makeRepo(t, "isolate-a", "alpha\n");
  const b = await makeRepo(t, "isolate-b", "beta\n");
  await register(registry, "a", a);
  await register(registry, "b", b);
  const { service } = makeService(registry);
  const [sa, sb] = await Promise.all([
    service.call("workspace_open", { workspace_id: "a" }),
    service.call("workspace_open", { workspace_id: "b" })
  ]);
  const [ra, rb] = await Promise.all([
    service.call("file_read", { session_id: sa.session_id, path: "file.txt" }),
    service.call("file_read", { session_id: sb.session_id, path: "file.txt" })
  ]);
  assert.equal(ra.content, "alpha\n");
  assert.equal(rb.content, "beta\n");
});

test("all repository tools require a session_id", async (t) => {
  const registry = new WorkspaceRegistry(path.join(await tempDir(t), "registry.json"));
  const { service } = makeService(registry);
  for (const [name, args] of [["repo_search", { query: "x" }], ["file_read", { path: "x" }], ["file_edit", {}], ["command_run", { command_id: "x" }], ["git_diff", {}]]) {
    await assert.rejects(service.call(name, args), (error) => error.code === "SESSION_REQUIRED");
  }
});

test("MCP lists seven tools and supports list, open, and read without exposing roots", async (t) => {
  const registry = new WorkspaceRegistry(path.join(await tempDir(t), "registry.json"));
  const root = await makeRepo(t, "mcp");
  await register(registry, "repo", root);
  const { service } = makeService(registry);
  const responses = await mcpSession(service, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "workspace_list", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "workspace_open", arguments: { workspace_id: "repo" } } }
  ]);
  assert.equal(responses[1].result.tools.length, 7);
  assert.equal(JSON.stringify(responses[2]).includes(root), false);
  const sessionId = responses[3].result.structuredContent.session_id;
  const read = await service.call("file_read", { session_id: sessionId, path: "file.txt" });
  assert.equal(read.content, "hello\n");
});

test("MCP returns session failures as tool errors", async (t) => {
  const registry = new WorkspaceRegistry(path.join(await tempDir(t), "registry.json"));
  const { service } = makeService(registry);
  const responses = await mcpSession(service, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "file_read", arguments: { session_id: "missing", path: "x" } } }]);
  assert.equal(responses[0].result.isError, true);
  assert.equal(responses[0].result.structuredContent.error.code, "SESSION_NOT_FOUND");
});

test("modern discovery advertises version 0.2.0 and session workflow", async (t) => {
  const registry = new WorkspaceRegistry(path.join(await tempDir(t), "registry.json"));
  const { service } = makeService(registry);
  const responses = await mcpSession(service, [{ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }]);
  assert.equal(responses[0].result._meta["io.modelcontextprotocol/serverInfo"].version, "0.2.0");
  assert.match(responses[0].result.instructions, /workspace_open/);
});

test("tool definitions require session_id only for repository-scoped tools", () => {
  const map = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
  assert.deepEqual(map.get("workspace_list").inputSchema.required, undefined);
  assert.deepEqual(map.get("workspace_open").inputSchema.required, ["workspace_id"]);
  for (const name of ["repo_search", "file_read", "file_edit", "command_run", "git_diff"]) {
    assert.ok(map.get(name).inputSchema.required.includes("session_id"));
  }
});

test("relative command config paths resolve from the workspace root", async (t) => {
  const root = await makeRepo(t, "relative");
  await fs.writeFile(path.join(root, "commands.json"), JSON.stringify({ commands: { verify: { argv: [process.execPath, "-e", "process.stdout.write('relative')"] } } }));
  const registry = new WorkspaceRegistry(path.join(await tempDir(t), "registry.json"));
  await registry.add({ id: "repo", root, commandsConfig: "commands.json" });
  const entry = await registry.get("repo");
  assert.equal(path.basename(entry.commandsConfig), "commands.json");
  assert.equal((await loadConfig(entry.commandsConfig, root)).commands.has("verify"), true);
});

test("workspace CLI persists add, list, and remove operations", async (t) => {
  const home = await tempDir(t, "cli-home-");
  const registry = path.join(home, "workspaces.json");
  const root = await makeRepo(t, "cli-repo");
  await cli(["workspace", "add", "repo", root, "--registry", registry, "--display-name", "Repo"]);
  const listed = JSON.parse((await cli(["workspace", "list", "--json", "--registry", registry])).stdout);
  assert.equal(listed.workspaces[0].workspace_id, "repo");
  await cli(["workspace", "remove", "repo", "--registry", registry]);
  assert.equal(JSON.parse((await cli(["workspace", "list", "--json", "--registry", registry])).stdout).workspaces.length, 0);
});
