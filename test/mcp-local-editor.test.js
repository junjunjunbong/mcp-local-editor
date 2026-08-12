import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { parseArgs } from "../src/cli.js";
import {
  commandRun,
  fileEdit,
  fileRead,
  gitDiff,
  LocalEditor,
  normalizeConfig,
  repoSearch,
  Workspace
} from "../src/core.js";
import { ToolError } from "../src/errors.js";
import { McpStdioServer } from "../src/mcp-stdio.js";

const execFileAsync = promisify(execFile);

async function makeTempDir(t, prefix = "mcp-local-editor-") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function git(cwd, args) {
  return await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function runSession(editor, requests) {
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  let outputText = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => {
    outputText += chunk;
  });

  const server = new McpStdioServer(editor, { input, output, errorOutput });
  const running = server.start();
  for (const request of requests) input.write(`${JSON.stringify(request)}\n`);
  input.end();
  await running;

  return outputText
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("parseArgs requires values for flag arguments", () => {
  assert.throws(() => parseArgs(["--root"]), /--root requires a value/);
  assert.throws(() => parseArgs(["--config"]), /--config requires a value/);
});

test("parseArgs accepts explicit root and config", () => {
  const result = parseArgs(["--root", "/tmp/repo", "--config", "/tmp/config.json"]);
  assert.equal(result.root, "/tmp/repo");
  assert.equal(result.config, "/tmp/config.json");
});

test("Workspace rejects lexical path escapes", async (t) => {
  const parent = await makeTempDir(t);
  const root = path.join(parent, "repo");
  await fs.mkdir(root);
  await fs.writeFile(path.join(parent, "outside.txt"), "secret");
  const workspace = await Workspace.open(root);

  await assert.rejects(
    workspace.resolveExistingFile("../outside.txt"),
    (error) => error instanceof ToolError && error.code === "PATH_OUTSIDE_ROOT"
  );
});

test("Workspace rejects symlinks that resolve outside the root", async (t) => {
  const parent = await makeTempDir(t);
  const root = path.join(parent, "repo");
  await fs.mkdir(root);
  const outside = path.join(parent, "outside.txt");
  await fs.writeFile(outside, "secret");
  await fs.symlink(outside, path.join(root, "escape.txt"));
  const workspace = await Workspace.open(root);

  await assert.rejects(
    workspace.resolveExistingFile("escape.txt"),
    (error) => error instanceof ToolError && error.code === "PATH_OUTSIDE_ROOT"
  );
});

test("Workspace resolves ordinary files inside the root", async (t) => {
  const root = await makeTempDir(t);
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "a.txt"), "ok");
  const workspace = await Workspace.open(root);

  const resolved = await workspace.resolveExistingFile("src/a.txt");
  assert.equal(await fs.readFile(resolved.absolutePath, "utf8"), "ok");
});

test("file_read returns a full-file hash and bounded line slice", async (t) => {
  const root = await makeTempDir(t);
  await fs.writeFile(path.join(root, "note.txt"), "one\ntwo\nthree\n");
  const workspace = await Workspace.open(root);

  const result = await fileRead(workspace, { path: "note.txt", start_line: 2, end_line: 3 });
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.content, "two\nthree");
  assert.equal(result.start_line, 2);
  assert.equal(result.end_line, 3);
});

test("file_edit applies one exact replacement atomically", async (t) => {
  const root = await makeTempDir(t);
  const target = path.join(root, "note.txt");
  await fs.writeFile(target, "alpha\nbeta\ngamma\n");
  const workspace = await Workspace.open(root);
  const read = await fileRead(workspace, { path: "note.txt" });

  const result = await fileEdit(workspace, {
    path: "note.txt",
    expected_sha256: read.sha256,
    replacements: [{ old_text: "beta", new_text: "delta" }]
  });

  assert.equal(await fs.readFile(target, "utf8"), "alpha\ndelta\ngamma\n");
  assert.notEqual(result.sha256, read.sha256);
  assert.equal(result.replacements_applied.length, 1);
});

test("file_edit rejects stale hashes", async (t) => {
  const root = await makeTempDir(t);
  const target = path.join(root, "note.txt");
  await fs.writeFile(target, "before\n");
  const workspace = await Workspace.open(root);
  const read = await fileRead(workspace, { path: "note.txt" });
  await fs.writeFile(target, "changed elsewhere\n");

  await assert.rejects(
    fileEdit(workspace, {
      path: "note.txt",
      expected_sha256: read.sha256,
      replacements: [{ old_text: "before", new_text: "after" }]
    }),
    (error) => error instanceof ToolError && error.code === "STALE_FILE"
  );
});

test("file_edit rejects ambiguous replacements without changing the file", async (t) => {
  const root = await makeTempDir(t);
  const target = path.join(root, "note.txt");
  const original = "same\nsame\n";
  await fs.writeFile(target, original);
  const workspace = await Workspace.open(root);
  const read = await fileRead(workspace, { path: "note.txt" });

  await assert.rejects(
    fileEdit(workspace, {
      path: "note.txt",
      expected_sha256: read.sha256,
      replacements: [{ old_text: "same", new_text: "different" }]
    }),
    (error) => error instanceof ToolError && error.code === "AMBIGUOUS_REPLACEMENT"
  );
  assert.equal(await fs.readFile(target, "utf8"), original);
});

test("file_edit validates all replacements before writing", async (t) => {
  const root = await makeTempDir(t);
  const target = path.join(root, "note.txt");
  const original = "first\nsecond\n";
  await fs.writeFile(target, original);
  const workspace = await Workspace.open(root);
  const read = await fileRead(workspace, { path: "note.txt" });

  await assert.rejects(
    fileEdit(workspace, {
      path: "note.txt",
      expected_sha256: read.sha256,
      replacements: [
        { old_text: "first", new_text: "changed" },
        { old_text: "missing", new_text: "never" }
      ]
    }),
    (error) => error instanceof ToolError && error.code === "TEXT_NOT_FOUND"
  );
  assert.equal(await fs.readFile(target, "utf8"), original);
});

test("file_edit rejects edits that would exceed the file size limit", async (t) => {
  const root = await makeTempDir(t);
  const target = path.join(root, "note.txt");
  await fs.writeFile(target, "small");
  const workspace = await Workspace.open(root);
  const read = await fileRead(workspace, { path: "note.txt" });

  await assert.rejects(
    fileEdit(workspace, {
      path: "note.txt",
      expected_sha256: read.sha256,
      replacements: [{ old_text: "small", new_text: "x".repeat(5 * 1024 * 1024 + 1) }]
    }),
    (error) => error instanceof ToolError && error.code === "FILE_TOO_LARGE"
  );
  assert.equal(await fs.readFile(target, "utf8"), "small");
});

test("command_run executes only configured argv without a shell", async (t) => {
  const root = await makeTempDir(t);
  const workspace = await Workspace.open(root);
  const config = normalizeConfig({
    commands: {
      verify: {
        argv: [process.execPath, "-e", "process.stdout.write('verified')"],
        timeoutSec: 5
      }
    }
  });

  const result = await commandRun(workspace, config, { command_id: "verify" });
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, "verified");
  assert.equal("argv" in result, false);
});

test("command_run rejects unknown command ids", async (t) => {
  const root = await makeTempDir(t);
  const workspace = await Workspace.open(root);
  const config = normalizeConfig({ commands: {} });

  await assert.rejects(
    commandRun(workspace, config, { command_id: "rm-everything" }),
    (error) => error instanceof ToolError && error.code === "COMMAND_NOT_ALLOWED"
  );
});

test("command_run terminates commands that exceed the configured timeout", async (t) => {
  const root = await makeTempDir(t);
  const workspace = await Workspace.open(root);
  const config = normalizeConfig({
    commands: {
      slow: {
        argv: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
        timeoutSec: 0.05
      }
    }
  });

  await assert.rejects(
    commandRun(workspace, config, { command_id: "slow" }),
    (error) => error instanceof ToolError && error.code === "COMMAND_TIMEOUT"
  );
});

test("repo_search returns repository-relative matches and honors globs", async (t) => {
  const root = await makeTempDir(t);
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "a.js"), "const needle = 1;\n");
  await fs.writeFile(path.join(root, "src", "b.txt"), "needle\n");
  const workspace = await Workspace.open(root);

  const result = await repoSearch(workspace, { query: "needle", glob: "**/*.js", max_results: 10 });
  assert.equal(result.match_count, 1);
  assert.equal(result.matches[0].path, "src/a.js");
  assert.equal(result.matches[0].line, 1);
});

test("git_diff returns unstaged and staged changes without mutating git", async (t) => {
  const root = await makeTempDir(t);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await fs.writeFile(path.join(root, "file.txt"), "one\n");
  await git(root, ["add", "file.txt"]);
  await git(root, ["commit", "-m", "initial"]);

  await fs.writeFile(path.join(root, "file.txt"), "one\ntwo\n");
  await fs.writeFile(path.join(root, "new.txt"), "untracked\n");
  const workspace = await Workspace.open(root);

  const result = await gitDiff(workspace);
  assert.match(result.status, / M file\.txt/);
  assert.match(result.status, /\?\? new\.txt/);
  assert.match(result.unstaged_diff, /\+two/);
  assert.equal(result.staged_diff, "");
});

test("stdio MCP supports initialize, tool listing, and file reads", async (t) => {
  const root = await makeTempDir(t);
  await fs.writeFile(path.join(root, "hello.txt"), "hello\n");
  const workspace = await Workspace.open(root);
  const editor = new LocalEditor(workspace, normalizeConfig({ commands: {} }));

  const responses = await runSession(editor, [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } }
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "file_read", arguments: { path: "hello.txt" } }
    }
  ]);

  assert.equal(responses.length, 3);
  assert.equal(responses[0].result.protocolVersion, "2025-11-25");
  assert.equal(responses[1].result.tools.length, 5);
  assert.equal(responses[2].result.structuredContent.content, "hello\n");
});

test("stdio MCP exposes modern server discovery without requiring initialization", async (t) => {
  const root = await makeTempDir(t);
  const workspace = await Workspace.open(root);
  const editor = new LocalEditor(workspace, normalizeConfig({ commands: {} }));

  const responses = await runSession(editor, [
    { jsonrpc: "2.0", id: 1, method: "server/discover", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
  ]);

  assert.deepEqual(responses[0].result.supportedVersions, ["2026-07-28"]);
  assert.deepEqual(responses[0].result._meta["io.modelcontextprotocol/serverInfo"], {
    name: "mcp-local-editor",
    version: "0.1.0"
  });
  assert.equal(responses[1].result.tools.length, 5);
});

test("tool failures are returned as MCP tool errors rather than server crashes", async (t) => {
  const root = await makeTempDir(t);
  const workspace = await Workspace.open(root);
  const editor = new LocalEditor(workspace, normalizeConfig({ commands: {} }));

  const responses = await runSession(editor, [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "file_read", arguments: { path: "missing.txt" } }
    }
  ]);

  assert.equal(responses[0].result.isError, true);
  assert.equal(responses[0].result.structuredContent.error.code, "FILE_NOT_FOUND");
});
