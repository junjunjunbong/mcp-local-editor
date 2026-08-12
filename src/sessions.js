import { createHash, randomBytes } from "node:crypto";
import { loadConfig, listCommands, Workspace } from "./core.js";
import { ToolError } from "./errors.js";

const DEFAULT_TTL_SEC = 30 * 60;
const MAX_TTL_SEC = 60 * 60;

function entrySignature(entry) {
  return createHash("sha256")
    .update(JSON.stringify([entry.id, entry.displayName, entry.root, entry.commandsConfig]))
    .digest("hex");
}

function validateAccess(value) {
  const access = value ?? "read";
  if (access !== "read" && access !== "write") {
    throw new ToolError("INVALID_ACCESS", "access must be read or write");
  }
  return access;
}

function validateTtl(value, fallback, maximum) {
  const ttl = value ?? fallback;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > maximum) {
    throw new ToolError("INVALID_SESSION_TTL", `ttl_sec must be an integer between 60 and ${maximum}`);
  }
  return ttl;
}

export class SessionManager {
  constructor(registry, { defaultTtlSec = DEFAULT_TTL_SEC, maxTtlSec = MAX_TTL_SEC, now = () => Date.now() } = {}) {
    if (!Number.isInteger(defaultTtlSec) || defaultTtlSec < 60 || defaultTtlSec > maxTtlSec) {
      throw new ToolError("INVALID_SESSION_TTL", "default session TTL is invalid");
    }
    this.registry = registry;
    this.defaultTtlSec = defaultTtlSec;
    this.maxTtlSec = maxTtlSec;
    this.now = now;
    this.sessions = new Map();
  }

  async open(input) {
    if (typeof input.workspace_id !== "string" || !input.workspace_id) {
      throw new ToolError("INVALID_ARGUMENT", "workspace_id is required");
    }
    const access = validateAccess(input.access);
    const ttlSec = validateTtl(input.ttl_sec, this.defaultTtlSec, this.maxTtlSec);
    const entry = await this.registry.get(input.workspace_id);
    const workspace = await Workspace.open(entry.root);
    if (workspace.root !== entry.root) throw new ToolError("WORKSPACE_ROOT_CHANGED", "workspace canonical path changed");
    const config = await loadConfig(entry.commandsConfig, workspace.root);
    const createdAt = this.now();
    const expiresAt = createdAt + ttlSec * 1000;
    const sessionId = `ses_${randomBytes(24).toString("base64url")}`;
    this.sessions.set(sessionId, {
      sessionId,
      workspaceId: entry.id,
      displayName: entry.displayName,
      access,
      workspace,
      config,
      signature: entrySignature(entry),
      createdAt,
      expiresAt
    });
    return {
      session_id: sessionId,
      workspace_id: entry.id,
      display_name: entry.displayName,
      access,
      expires_at: new Date(expiresAt).toISOString(),
      commands: listCommands(config)
    };
  }

  async resolve(sessionId, { write = false, refreshConfig = false } = {}) {
    if (typeof sessionId !== "string" || !sessionId) throw new ToolError("SESSION_REQUIRED", "session_id is required");
    const session = this.sessions.get(sessionId);
    if (!session) throw new ToolError("SESSION_NOT_FOUND", "session was not found; call workspace_open again");
    if (this.now() >= session.expiresAt) {
      this.sessions.delete(sessionId);
      throw new ToolError("SESSION_EXPIRED", "session expired; call workspace_open again");
    }

    let entry;
    try {
      entry = await this.registry.get(session.workspaceId);
    } catch (error) {
      this.sessions.delete(sessionId);
      if (error instanceof ToolError && error.code === "WORKSPACE_NOT_FOUND") {
        throw new ToolError("SESSION_REVOKED", "workspace registration was removed; open a new session");
      }
      throw error;
    }
    if (entrySignature(entry) !== session.signature) {
      this.sessions.delete(sessionId);
      throw new ToolError("SESSION_REVOKED", "workspace registration changed; open a new session");
    }
    const currentWorkspace = await Workspace.open(entry.root);
    if (currentWorkspace.root !== session.workspace.root) {
      this.sessions.delete(sessionId);
      throw new ToolError("SESSION_REVOKED", "workspace canonical path changed; open a new session");
    }
    if (write && session.access !== "write") throw new ToolError("PERMISSION_DENIED", "this operation requires a write session");
    if (refreshConfig) session.config = await loadConfig(entry.commandsConfig, session.workspace.root);
    return session;
  }

  close(sessionId) {
    return this.sessions.delete(sessionId);
  }
}
