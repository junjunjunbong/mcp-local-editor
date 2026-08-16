#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { asToolError } from "./errors.js";
import { McpStdioServer } from "./mcp-stdio.js";
import { defaultRegistryPath, WorkspaceRegistry } from "./registry.js";
import { LocalEditorService, normalizeToolProfile } from "./service.js";
import { SessionManager } from "./sessions.js";

const VERSION = "0.2.0";
const DEFAULT_TTL = 1800;

function usage() {
  return `mcp-local-editor ${VERSION}

Usage:
  mcp-local-editor serve [--registry workspaces.json] [--session-ttl-sec 1800] [--profile full|read]
  mcp-local-editor workspace add <id> <root> [--display-name <name>] [--commands <file> | --no-commands] [--replace]
  mcp-local-editor workspace list [--json]
  mcp-local-editor workspace remove <id>

Options:
  --registry <path>          Registry path. Default: package-local workspaces.local.json
  --session-ttl-sec <value>  Session lifetime, 60-3600 seconds.
  --profile <full|read>      MCP tool profile. Default: full
  --help                     Show help.
  --version                  Show version.
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

function parseProfile(value) {
  try { return normalizeToolProfile(value); } catch { throw new Error("profile must be full or read"); }
}

function defaults(env) {
  return {
    registry: env.MCP_LOCAL_EDITOR_REGISTRY || defaultRegistryPath({ env }),
    sessionTtlSec: env.MCP_LOCAL_EDITOR_SESSION_TTL_SEC ? parseTtl(env.MCP_LOCAL_EDITOR_SESSION_TTL_SEC) : DEFAULT_TTL,
    profile: parseProfile(env.MCP_LOCAL_EDITOR_PROFILE || "full")
  };
}

function parseServe(argv, env) {
  const parsed = { command: "serve", ...defaults(env) };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (["--help", "-h"].includes(arg)) return { ...parsed, help: true };
    if (arg === "--registry") { parsed.registry = valueAfter(argv, i, arg); i += 1; continue; }
    if (arg === "--session-ttl-sec") { parsed.sessionTtlSec = parseTtl(valueAfter(argv, i, arg)); i += 1; continue; }
    if (arg === "--profile") { parsed.profile = parseProfile(valueAfter(argv, i, arg)); i += 1; continue; }
    if (arg === "--root") throw new Error("--root was removed in v0.2; use `workspace add` and `serve`");
    throw new Error(`Unknown serve argument: ${arg}`);
  }
  return parsed;
}

function parseWorkspace(argv, env) {
  const action = argv[0];
  const base = { command: "workspace", action, ...defaults(env) };
  if (!action || ["--help", "-h"].includes(action)) return { ...base, help: true };
  if (action === "add") {
    if (!argv[1]) throw new Error("workspace add requires <id>");
    if (!argv[2]) throw new Error("workspace add requires <root>");
    const parsed = { ...base, id: argv[1], root: argv[2], displayName: undefined, commands: undefined, replace: false };
    for (let i = 3; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === "--registry") { parsed.registry = valueAfter(argv, i, arg); i += 1; continue; }
      if (arg === "--display-name") { parsed.displayName = valueAfter(argv, i, arg); i += 1; continue; }
      if (arg === "--commands") { if (parsed.commands === null) throw new Error("--commands conflicts with --no-commands"); parsed.commands = valueAfter(argv, i, arg); i += 1; continue; }
      if (arg === "--no-commands") { if (typeof parsed.commands === "string") throw new Error("--no-commands conflicts with --commands"); parsed.commands = null; continue; }
      if (arg === "--replace") { parsed.replace = true; continue; }
      throw new Error(`Unknown workspace add argument: ${arg}`);
    }
    return parsed;
  }
  if (action === "list") {
    const parsed = { ...base, json: false };
    for (let i = 1; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === "--registry") { parsed.registry = valueAfter(argv, i, arg); i += 1; continue; }
      if (arg === "--json") { parsed.json = true; continue; }
      throw new Error(`Unknown workspace list argument: ${arg}`);
    }
    return parsed;
  }
  if (action === "remove") {
    if (!argv[1]) throw new Error("workspace remove requires <id>");
    const parsed = { ...base, id: argv[1] };
    for (let i = 2; i < argv.length; i += 1) {
      if (argv[i] === "--registry") { parsed.registry = valueAfter(argv, i, argv[i]); i += 1; continue; }
      throw new Error(`Unknown workspace remove argument: ${argv[i]}`);
    }
    return parsed;
  }
  throw new Error(`Unknown workspace action: ${action}`);
}

export function parseArgs(argv, env = process.env) {
  if (!argv.length) return parseServe([], env);
  if (["--help", "-h"].includes(argv[0])) return { help: true };
  if (["--version", "-v"].includes(argv[0])) return { version: true };
  if (argv[0] === "serve") return parseServe(argv.slice(1), env);
  if (argv[0] === "workspace") return parseWorkspace(argv.slice(1), env);
  if (argv[0].startsWith("--")) return parseServe(argv, env);
  throw new Error(`Unknown command: ${argv[0]}`);
}

const publicEntry = (entry) => ({ workspace_id: entry.id, display_name: entry.displayName, root: entry.root, commands_config: entry.commandsConfig });

async function runServe(args) {
  const registry = new WorkspaceRegistry(args.registry);
  const sessions = new SessionManager(registry, { defaultTtlSec: args.sessionTtlSec, maxTtlSec: args.sessionTtlSec });
  const service = new LocalEditorService(registry, sessions, { profile: args.profile });
  const server = new McpStdioServer(service);
  process.stderr.write(`[mcp-local-editor] registry=${registry.filePath}\n`);
  process.stderr.write(`[mcp-local-editor] registered_workspaces=${(await registry.list()).length}\n`);
  process.stderr.write(`[mcp-local-editor] profile=${args.profile}\n`);
  await server.start();
}

async function runWorkspace(args) {
  const registry = new WorkspaceRegistry(args.registry);
  if (args.action === "add") {
    const entry = await registry.add({ id: args.id, root: args.root, displayName: args.displayName, commandsConfig: args.commands, replace: args.replace });
    process.stdout.write(`${JSON.stringify({ ok: true, workspace: publicEntry(entry) }, null, 2)}\n`);
    return;
  }
  if (args.action === "remove") {
    const entry = await registry.remove(args.id);
    process.stdout.write(`${JSON.stringify({ ok: true, removed: publicEntry(entry) }, null, 2)}\n`);
    return;
  }
  const entries = await registry.list();
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ registry: registry.filePath, workspaces: entries.map(publicEntry) }, null, 2)}\n`);
    return;
  }
  if (!entries.length) { process.stdout.write(`No workspaces registered in ${registry.filePath}\n`); return; }
  process.stdout.write(`Registry: ${registry.filePath}\nID\tDISPLAY NAME\tROOT\tCOMMANDS\n`);
  for (const entry of entries) process.stdout.write(`${entry.id}\t${entry.displayName}\t${entry.root}\t${entry.commandsConfig ?? "none"}\n`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv, env);
  if (args.help) { process.stdout.write(usage()); return; }
  if (args.version) { process.stdout.write(`${VERSION}\n`); return; }
  if (args.command === "serve") return await runServe(args);
  if (args.command === "workspace") return await runWorkspace(args);
  throw new Error("No command selected");
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  process.stdout.on("error", (error) => { if (error.code === "EPIPE") process.exit(0); throw error; });
  main().catch((error) => {
    const normalized = asToolError(error);
    process.stderr.write(`[mcp-local-editor] ${normalized.code}: ${normalized.message}\n`);
    process.exitCode = 1;
  });
}
