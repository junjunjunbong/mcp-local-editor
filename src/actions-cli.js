#!/usr/bin/env node

import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asToolError } from "./errors.js";
import { ACTIONS_DEFAULTS, ActionsHttpServer } from "./http-actions.js";
import { defaultRegistryPath, WorkspaceRegistry } from "./registry.js";
import { LocalEditorService, TOOL_DEFINITIONS } from "./service.js";
import { SessionManager } from "./sessions.js";

const VERSION = "0.2.0";
const DEFAULT_TTL = 1800;

function usage() {
  return `mcp-local-editor-actions ${VERSION}

Usage:
  mcp-local-editor-actions [--host 127.0.0.1] [--port 8787] [--public-url https://editor.example.com] [--token-file token.txt]

Options:
  --registry <path>          Registry path. Default: user config directory.
  --session-ttl-sec <value>  Session lifetime, 60-3600 seconds.
  --host <host>              Listener host. Default: 127.0.0.1
  --port <port>              Listener port. Default: 8787
  --public-url <url>         Stable public HTTP(S) origin for generated OpenAPI. Optional.
  --token-file <path>        Read the bearer token from a local file.
  --help                     Show help.
  --version                  Show version.

Authentication:
  Set MCP_LOCAL_EDITOR_ACTIONS_TOKEN or MCP_LOCAL_EDITOR_ACTIONS_TOKEN_FILE.
  The token must be at least ${ACTIONS_DEFAULTS.minTokenLength} characters. It is never printed.
`;
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseTtl(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 60 || parsed > 3600) throw new Error("session TTL must be 60-3600 seconds");
  return parsed;
}

function parsePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("port must be 1-65535");
  return parsed;
}

export function parseArgs(argv, env = process.env) {
  const parsed = {
    registry: env.MCP_LOCAL_EDITOR_REGISTRY || defaultRegistryPath({ env }),
    sessionTtlSec: env.MCP_LOCAL_EDITOR_SESSION_TTL_SEC ? parseTtl(env.MCP_LOCAL_EDITOR_SESSION_TTL_SEC) : DEFAULT_TTL,
    host: env.MCP_LOCAL_EDITOR_ACTIONS_HOST || ACTIONS_DEFAULTS.host,
    port: env.MCP_LOCAL_EDITOR_ACTIONS_PORT ? parsePort(env.MCP_LOCAL_EDITOR_ACTIONS_PORT) : ACTIONS_DEFAULTS.port,
    publicUrl: env.MCP_LOCAL_EDITOR_ACTIONS_PUBLIC_URL,
    token: env.MCP_LOCAL_EDITOR_ACTIONS_TOKEN,
    tokenFile: env.MCP_LOCAL_EDITOR_ACTIONS_TOKEN_FILE
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--help", "-h"].includes(arg)) return { ...parsed, help: true };
    if (["--version", "-v"].includes(arg)) return { ...parsed, version: true };
    if (arg === "--registry") { parsed.registry = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--session-ttl-sec") { parsed.sessionTtlSec = parseTtl(valueAfter(argv, index, arg)); index += 1; continue; }
    if (arg === "--host") { parsed.host = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--port") { parsed.port = parsePort(valueAfter(argv, index, arg)); index += 1; continue; }
    if (arg === "--public-url") { parsed.publicUrl = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--token-file") { parsed.tokenFile = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--token") {
      throw new Error("--token is not supported because command-line secrets leak through process listings; use an environment variable or --token-file");
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

export async function readActionsToken(args) {
  if (args.token && args.tokenFile) {
    throw new Error("Set either MCP_LOCAL_EDITOR_ACTIONS_TOKEN or a token file, not both");
  }
  if (args.token) return args.token;
  if (!args.tokenFile) {
    throw new Error("MCP_LOCAL_EDITOR_ACTIONS_TOKEN or MCP_LOCAL_EDITOR_ACTIONS_TOKEN_FILE/--token-file is required");
  }
  const token = (await fs.readFile(path.resolve(args.tokenFile), "utf8")).trim();
  if (!token) throw new Error("Actions token file is empty");
  return token;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv, env);
  if (args.help) { process.stdout.write(usage()); return; }
  if (args.version) { process.stdout.write(`${VERSION}\n`); return; }

  const registry = new WorkspaceRegistry(args.registry);
  const sessions = new SessionManager(registry, {
    defaultTtlSec: args.sessionTtlSec,
    maxTtlSec: args.sessionTtlSec
  });
  const service = new LocalEditorService(registry, sessions);
  const token = await readActionsToken(args);
  const server = new ActionsHttpServer(service, {
    token,
    toolDefinitions: TOOL_DEFINITIONS,
    host: args.host,
    port: args.port,
    publicUrl: args.publicUrl
  });
  const address = await server.start();
  const localOrigin = `http://${address.host}:${address.port}`;

  process.stderr.write(`[mcp-local-editor] actions=${localOrigin}\n`);
  process.stderr.write(`[mcp-local-editor] registry=${registry.filePath}\n`);
  process.stderr.write(`[mcp-local-editor] registered_workspaces=${(await registry.list()).length}\n`);
  process.stderr.write(`[mcp-local-editor] openapi=${args.publicUrl ? `${args.publicUrl}/openapi.json` : `${localOrigin}/openapi.json`}\n`);
  process.stderr.write("[mcp-local-editor] bearer_token=required (value hidden)\n");

  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    server.stop().catch((error) => {
      const normalized = asToolError(error);
      process.stderr.write(`[mcp-local-editor] ${normalized.code}: ${normalized.message}\n`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await server.waitUntilClosed();
}

const isEntry = (() => {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();
if (isEntry) {
  main().catch((error) => {
    const normalized = asToolError(error);
    process.stderr.write(`[mcp-local-editor] ${normalized.code}: ${normalized.message}\n`);
    process.exitCode = 1;
  });
}
