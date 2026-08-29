#!/usr/bin/env node

import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asToolError } from "./errors.js";
import { MCP_HTTP_DEFAULTS, McpHttpServer } from "./mcp-http.js";
import { defaultRegistryPath, WorkspaceRegistry } from "./registry.js";
import { LocalEditorService, normalizeToolProfile } from "./service.js";
import { SessionManager } from "./sessions.js";

const VERSION = "0.2.1";
const DEFAULT_TTL = 1800;

function usage() {
  return `mcp-local-editor-mcp ${VERSION}

Run a remote Streamable HTTP MCP server for ChatGPT custom apps.

Usage:
  mcp-local-editor-mcp \\
    --public-url https://editor.example.com \\
    --owner-token-file .mcp-local-editor-token

Options:
  --registry <path>              Workspace registry path.
  --session-ttl-sec <value>      Workspace session lifetime, 60-3600 seconds.
  --profile <read|full>          Exposed tool profile. Default: read
  --host <host>                  Listener host. Default: 127.0.0.1
  --port <port>                  Listener port. Default: 8790
  --public-url <origin>          Public HTTPS origin, without /mcp.
  --auth <oauth|none>            Authentication mode. Default: oauth
  --owner-token-file <path>      Local owner token file for OAuth approval.
  --oauth-store <path>           Persistent OAuth state file.
  --allow-unauthenticated        Required acknowledgement for --auth none.
  --redirect-host <hostname>     Additional HTTPS OAuth redirect host. Repeatable.
  --help                         Show help.
  --version                      Show version.

Environment:
  MCP_LOCAL_EDITOR_REGISTRY
  MCP_LOCAL_EDITOR_SESSION_TTL_SEC
  MCP_LOCAL_EDITOR_MCP_PROFILE
  MCP_LOCAL_EDITOR_MCP_HOST
  MCP_LOCAL_EDITOR_MCP_PORT
  MCP_LOCAL_EDITOR_MCP_PUBLIC_URL
  MCP_LOCAL_EDITOR_MCP_AUTH
  MCP_LOCAL_EDITOR_OWNER_TOKEN_FILE
  MCP_LOCAL_EDITOR_OAUTH_STORE
  MCP_LOCAL_EDITOR_ALLOW_UNAUTHENTICATED
`;
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be ${minimum}-${maximum}`);
  return parsed;
}

function parseAuth(value) {
  if (!new Set(["oauth", "none"]).has(value)) throw new Error("auth must be oauth or none");
  return value;
}

function parseProfile(value) {
  try { return normalizeToolProfile(value); } catch { throw new Error("profile must be read or full"); }
}

function envBoolean(value) {
  return new Set(["1", "true", "yes", "on"]).has(String(value ?? "").toLowerCase());
}

export function parseArgs(argv, env = process.env) {
  const registry = env.MCP_LOCAL_EDITOR_REGISTRY || defaultRegistryPath({ env });
  let oauthStoreExplicit = Boolean(env.MCP_LOCAL_EDITOR_OAUTH_STORE);
  const parsed = {
    registry,
    sessionTtlSec: env.MCP_LOCAL_EDITOR_SESSION_TTL_SEC
      ? parseInteger(env.MCP_LOCAL_EDITOR_SESSION_TTL_SEC, "session TTL", 60, 3600)
      : DEFAULT_TTL,
    profile: parseProfile(env.MCP_LOCAL_EDITOR_MCP_PROFILE || "read"),
    host: env.MCP_LOCAL_EDITOR_MCP_HOST || MCP_HTTP_DEFAULTS.host,
    port: env.MCP_LOCAL_EDITOR_MCP_PORT
      ? parseInteger(env.MCP_LOCAL_EDITOR_MCP_PORT, "port", 1, 65535)
      : MCP_HTTP_DEFAULTS.port,
    publicUrl: env.MCP_LOCAL_EDITOR_MCP_PUBLIC_URL,
    auth: parseAuth(env.MCP_LOCAL_EDITOR_MCP_AUTH || "oauth"),
    ownerTokenFile: env.MCP_LOCAL_EDITOR_OWNER_TOKEN_FILE,
    oauthStore: env.MCP_LOCAL_EDITOR_OAUTH_STORE || `${registry}.oauth.json`,
    allowUnauthenticated: envBoolean(env.MCP_LOCAL_EDITOR_ALLOW_UNAUTHENTICATED),
    redirectHosts: [...MCP_HTTP_DEFAULTS.redirectHosts]
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--help", "-h"].includes(arg)) return { ...parsed, help: true };
    if (["--version", "-v"].includes(arg)) return { ...parsed, version: true };
    if (arg === "--registry") { parsed.registry = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--session-ttl-sec") { parsed.sessionTtlSec = parseInteger(valueAfter(argv, index, arg), "session TTL", 60, 3600); index += 1; continue; }
    if (arg === "--profile") { parsed.profile = parseProfile(valueAfter(argv, index, arg)); index += 1; continue; }
    if (arg === "--host") { parsed.host = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--port") { parsed.port = parseInteger(valueAfter(argv, index, arg), "port", 1, 65535); index += 1; continue; }
    if (arg === "--public-url") { parsed.publicUrl = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--auth") { parsed.auth = parseAuth(valueAfter(argv, index, arg)); index += 1; continue; }
    if (arg === "--owner-token-file") { parsed.ownerTokenFile = valueAfter(argv, index, arg); index += 1; continue; }
    if (arg === "--oauth-store") { parsed.oauthStore = valueAfter(argv, index, arg); oauthStoreExplicit = true; index += 1; continue; }
    if (arg === "--allow-unauthenticated") { parsed.allowUnauthenticated = true; continue; }
    if (arg === "--redirect-host") { parsed.redirectHosts.push(valueAfter(argv, index, arg)); index += 1; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!oauthStoreExplicit) parsed.oauthStore = `${parsed.registry}.oauth.json`;
  if (!parsed.publicUrl) parsed.publicUrl = `http://${parsed.host}:${parsed.port}`;
  if (parsed.auth === "oauth" && !parsed.ownerTokenFile) {
    throw new Error("--owner-token-file or MCP_LOCAL_EDITOR_OWNER_TOKEN_FILE is required for OAuth");
  }
  if (parsed.auth === "none" && !parsed.allowUnauthenticated) {
    throw new Error("--auth none requires --allow-unauthenticated");
  }
  return parsed;
}

export async function readOwnerToken(filePath) {
  const token = (await fs.readFile(path.resolve(filePath), "utf8")).trim();
  if (token.length < 32 || /[\r\n]/.test(token)) {
    throw new Error("owner token must be at least 32 characters and contain no line breaks");
  }
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
  const service = new LocalEditorService(registry, sessions, { profile: args.profile });
  const auth = args.auth === "oauth"
    ? {
        mode: "oauth",
        ownerToken: await readOwnerToken(args.ownerTokenFile),
        storePath: args.oauthStore,
        allowedRedirectHosts: [...new Set(args.redirectHosts)]
      }
    : { mode: "none" };

  const server = new McpHttpServer(service, {
    host: args.host,
    port: args.port,
    publicUrl: args.publicUrl,
    auth
  });
  const address = await server.start();
  const publicOrigin = new URL(args.publicUrl).origin;

  process.stderr.write(`[mcp-local-editor] mcp=${publicOrigin}/mcp\n`);
  process.stderr.write(`[mcp-local-editor] local=http://${address.host}:${address.port}\n`);
  process.stderr.write(`[mcp-local-editor] registry=${registry.filePath}\n`);
  process.stderr.write(`[mcp-local-editor] registered_workspaces=${(await registry.list()).length}\n`);
  process.stderr.write(`[mcp-local-editor] profile=${args.profile}\n`);
  process.stderr.write(`[mcp-local-editor] auth=${args.auth}\n`);
  if (args.auth === "oauth") process.stderr.write(`[mcp-local-editor] oauth_store=${path.resolve(args.oauthStore)}\n`);

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
