import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, Workspace } from "./core.js";
import { ToolError } from "./errors.js";

const VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOCK_RETRIES = 80;
const LOCK_RETRY_MS = 25;
const STALE_LOCK_MS = 30_000;
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function defaultRegistryPath({ env = process.env, packageRoot = PACKAGE_ROOT } = {}) {
  if (env.MCP_LOCAL_EDITOR_REGISTRY) return path.resolve(env.MCP_LOCAL_EDITOR_REGISTRY);
  if (env.MCP_LOCAL_EDITOR_HOME) return path.join(path.resolve(env.MCP_LOCAL_EDITOR_HOME), "workspaces.json");
  if (env.XDG_CONFIG_HOME) return path.join(path.resolve(env.XDG_CONFIG_HOME), "mcp-local-editor", "workspaces.json");
  return path.join(path.resolve(packageRoot), "workspaces.local.json");
}

export function validateWorkspaceId(id) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new ToolError("INVALID_WORKSPACE_ID", "workspace id must be 1-64 safe characters");
  }
  return id;
}

function validateEntry(id, value) {
  validateWorkspaceId(id);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ToolError("INVALID_REGISTRY", `workspaces.${id} must be an object`);
  if (typeof value.root !== "string" || !path.isAbsolute(value.root) || value.root.includes("\0")) throw new ToolError("INVALID_REGISTRY", `workspaces.${id}.root must be absolute`);
  if (typeof value.displayName !== "string" || !value.displayName.trim() || value.displayName.length > 120) throw new ToolError("INVALID_REGISTRY", `workspaces.${id}.displayName is invalid`);
  if (value.commandsConfig !== null && value.commandsConfig !== undefined && (typeof value.commandsConfig !== "string" || !path.isAbsolute(value.commandsConfig))) {
    throw new ToolError("INVALID_REGISTRY", `workspaces.${id}.commandsConfig must be null or absolute`);
  }
  return {
    id,
    displayName: value.displayName.trim(),
    root: path.normalize(value.root),
    commandsConfig: value.commandsConfig ? path.normalize(value.commandsConfig) : null
  };
}

function normalizeDocument(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value.version !== VERSION || value.workspaces === null || typeof value.workspaces !== "object" || Array.isArray(value.workspaces)) {
    throw new ToolError("INVALID_REGISTRY", `registry must have version ${VERSION} and an object workspaces field`);
  }
  const workspaces = {};
  for (const [id, raw] of Object.entries(value.workspaces)) {
    const entry = validateEntry(id, raw);
    workspaces[id] = { displayName: entry.displayName, root: entry.root, commandsConfig: entry.commandsConfig };
  }
  return { version: VERSION, workspaces };
}

function emptyDocument() {
  return { version: VERSION, workspaces: {} };
}

export class WorkspaceRegistry {
  constructor(filePath = defaultRegistryPath()) {
    if (typeof filePath !== "string" || !filePath.trim()) throw new ToolError("INVALID_REGISTRY_PATH", "registry path is required");
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
  }

  async readDocument() {
    let text;
    try {
      text = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return emptyDocument();
      throw new ToolError("REGISTRY_READ_FAILED", "could not read workspace registry", { cause: String(error) });
    }
    try {
      return normalizeDocument(JSON.parse(text));
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError("INVALID_REGISTRY", "workspace registry is not valid JSON", { cause: String(error) });
    }
  }

  async writeDocument(document) {
    const normalized = normalizeDocument(document);
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const ordered = {};
    for (const id of Object.keys(normalized.workspaces).sort()) ordered[id] = normalized.workspaces[id];
    const output = `${JSON.stringify({ version: VERSION, workspaces: ordered }, null, 2)}\n`;
    const temp = `${this.filePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      await fs.writeFile(temp, output, { encoding: "utf8", mode: 0o600 });
      await fs.chmod(temp, 0o600);
      await fs.rename(temp, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {});
      throw new ToolError("REGISTRY_WRITE_FAILED", "could not update workspace registry", { cause: String(error) });
    }
  }

  async acquireLock() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
      try {
        const handle = await fs.open(this.lockPath, "wx", 0o600);
        await handle.writeFile(`${process.pid} ${Date.now()}\n`);
        return handle;
      } catch (error) {
        if (error?.code !== "EEXIST") throw new ToolError("REGISTRY_LOCK_FAILED", "could not lock workspace registry", { cause: String(error) });
        const stat = await fs.stat(this.lockPath).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          await fs.rm(this.lockPath, { force: true }).catch(() => {});
          continue;
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
    throw new ToolError("REGISTRY_BUSY", "workspace registry is busy");
  }

  async mutate(operation) {
    const lock = await this.acquireLock();
    try {
      const document = await this.readDocument();
      const result = await operation(document);
      await this.writeDocument(document);
      return result;
    } finally {
      await lock.close().catch(() => {});
      await fs.rm(this.lockPath, { force: true }).catch(() => {});
    }
  }

  async list() {
    const document = await this.readDocument();
    return Object.entries(document.workspaces).map(([id, value]) => validateEntry(id, value)).sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(id) {
    validateWorkspaceId(id);
    const document = await this.readDocument();
    if (!document.workspaces[id]) throw new ToolError("WORKSPACE_NOT_FOUND", `workspace is not registered: ${id}`, { workspace_id: id });
    return validateEntry(id, document.workspaces[id]);
  }

  async listStatus() {
    return await Promise.all((await this.list()).map(async (entry) => {
      try {
        const workspace = await Workspace.open(entry.root);
        if (workspace.root !== entry.root) throw new ToolError("WORKSPACE_ROOT_CHANGED", "workspace root canonical path changed");
        if (entry.commandsConfig) await loadConfig(entry.commandsConfig, workspace.root);
        return { workspace_id: entry.id, display_name: entry.displayName, available: true, commands_configured: Boolean(entry.commandsConfig) };
      } catch (error) {
        return {
          workspace_id: entry.id,
          display_name: entry.displayName,
          available: false,
          commands_configured: Boolean(entry.commandsConfig),
          unavailable_reason: error instanceof ToolError ? error.code : "WORKSPACE_UNAVAILABLE"
        };
      }
    }));
  }

  async resolveCommandsConfig(workspace, value) {
    if (value === undefined || value === null) return value;
    const candidate = path.isAbsolute(value) ? value : path.resolve(workspace.root, value);
    let real;
    try { real = await fs.realpath(candidate); } catch (error) {
      throw new ToolError("CONFIG_NOT_FOUND", `could not resolve command config: ${value}`, { cause: String(error) });
    }
    if (!(await fs.stat(real)).isFile()) throw new ToolError("CONFIG_NOT_FOUND", "command config is not a regular file");
    await loadConfig(real, workspace.root);
    return real;
  }

  async add({ id, root, displayName, commandsConfig = undefined, replace = false }) {
    validateWorkspaceId(id);
    const workspace = await Workspace.open(root);
    const suppliedName = displayName === undefined ? undefined : String(displayName).trim();
    if (suppliedName !== undefined && (!suppliedName || suppliedName.length > 120)) throw new ToolError("INVALID_DISPLAY_NAME", "display name is invalid");
    const suppliedConfig = await this.resolveCommandsConfig(workspace, commandsConfig);

    return await this.mutate(async (document) => {
      const existing = document.workspaces[id];
      if (existing && !replace) throw new ToolError("WORKSPACE_ALREADY_EXISTS", `workspace already exists: ${id}`);
      for (const [otherId, value] of Object.entries(document.workspaces)) {
        if (otherId !== id && path.normalize(value.root) === workspace.root) {
          throw new ToolError("WORKSPACE_ROOT_ALREADY_REGISTERED", `workspace root is already registered as ${otherId}`);
        }
      }
      const finalConfig = suppliedConfig === undefined ? existing?.commandsConfig ?? null : suppliedConfig;
      if (finalConfig) await loadConfig(finalConfig, workspace.root);
      document.workspaces[id] = {
        displayName: suppliedName ?? existing?.displayName ?? id,
        root: workspace.root,
        commandsConfig: finalConfig
      };
      return validateEntry(id, document.workspaces[id]);
    });
  }

  async remove(id) {
    validateWorkspaceId(id);
    return await this.mutate(async (document) => {
      if (!document.workspaces[id]) throw new ToolError("WORKSPACE_NOT_FOUND", `workspace is not registered: ${id}`);
      const entry = validateEntry(id, document.workspaces[id]);
      delete document.workspaces[id];
      return entry;
    });
  }
}
