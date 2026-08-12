import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseArgs, readActionsToken } from "../src/actions-cli.js";

test("parseArgs supports Actions settings and environment defaults", () => {
  const result = parseArgs(
    ["--host", "127.0.0.1", "--port", "9000", "--public-url", "https://editor.example.com"],
    { MCP_LOCAL_EDITOR_ACTIONS_TOKEN: "x".repeat(32) }
  );
  assert.equal(result.host, "127.0.0.1");
  assert.equal(result.port, 9000);
  assert.equal(result.publicUrl, "https://editor.example.com");
  assert.equal(result.token, "x".repeat(32));
});

test("parseArgs rejects command-line bearer tokens", () => {
  assert.throws(
    () => parseArgs(["--token", "secret"], {}),
    /process listings/
  );
});

test("readActionsToken reads a token file and rejects ambiguous sources", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-actions-token-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, "token.txt");
  await fs.writeFile(tokenFile, `${"a".repeat(32)}\n`);
  assert.equal(await readActionsToken({ tokenFile }), "a".repeat(32));
  await assert.rejects(readActionsToken({ token: "b".repeat(32), tokenFile }), /either/);
});
