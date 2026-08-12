#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { asToolError } from "./errors.js";
import { loadConfig, LocalEditor, Workspace } from "./core.js";
import { McpStdioServer } from "./mcp-stdio.js";

const VERSION = "0.1.0";

function usage() {
  return `mcp-local-editor ${VERSION}

Usage:
  mcp-local-editor --root /absolute/path/to/repository [--config commands.json]

Options:
  --root <path>    Fixed repository root. Can also use MCP_LOCAL_EDITOR_ROOT.
  --config <path>  JSON command allowlist. Can also use MCP_LOCAL_EDITOR_CONFIG.
  --help           Show this help.
  --version        Show the version.
`;
}

export function parseArgs(argv) {
  const result = { root: process.env.MCP_LOCAL_EDITOR_ROOT, config: process.env.MCP_LOCAL_EDITOR_CONFIG };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { ...result, help: true };
    if (arg === "--version" || arg === "-v") return { ...result, version: true };
    if (arg === "--root") {
      if (argv[index + 1] === undefined) throw new Error("--root requires a value");
      result.root = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--config") {
      if (argv[index + 1] === undefined) throw new Error("--config requires a value");
      result.config = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (!args.root) {
    throw new Error("--root or MCP_LOCAL_EDITOR_ROOT is required");
  }

  const workspace = await Workspace.open(args.root);
  const config = await loadConfig(args.config, workspace.root);
  const editor = new LocalEditor(workspace, config);
  const server = new McpStdioServer(editor);

  process.stderr.write(`[mcp-local-editor] root=${workspace.root}\n`);
  process.stderr.write(`[mcp-local-editor] commands=${[...config.commands.keys()].join(",") || "none"}\n`);
  await server.start();
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  process.stdout.on("error", (error) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });

  main().catch((error) => {
    const normalized = asToolError(error);
    process.stderr.write(`[mcp-local-editor] ${normalized.code}: ${normalized.message}\n`);
    process.exitCode = 1;
  });
}
