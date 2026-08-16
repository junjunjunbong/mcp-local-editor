import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ToolError } from "./errors.js";
import { isPlainObject } from "./http-utils.js";

const VERSION = 1;
const LOCK_RETRIES = 80;
const LOCK_RETRY_MS = 25;
const STALE_LOCK_MS = 30_000;
const DEFAULT_MAX_CLIENTS = 1_000;
const DEFAULT_MAX_TOKENS_PER_KIND = 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function hashToken(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function randomOAuthToken(prefix) {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function emptyDocument() {
  return { version: VERSION, clients: {}, accessTokens: {}, refreshTokens: {} };
}

function normalizeClient(clientId, value) {
  if (!isPlainObject(value) || value.client_id !== clientId) {
    throw new ToolError("INVALID_OAUTH_STORE", `clients.${clientId} is invalid`);
  }
  if (!Array.isArray(value.redirect_uris) || value.redirect_uris.some((uri) => typeof uri !== "string" || !uri)) {
    throw new ToolError("INVALID_OAUTH_STORE", `clients.${clientId}.redirect_uris is invalid`);
  }
  return {
    client_id: clientId,
    client_id_issued_at: Number.isInteger(value.client_id_issued_at) ? value.client_id_issued_at : 0,
    redirect_uris: [...value.redirect_uris],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: typeof value.client_name === "string" ? value.client_name : "MCP client"
  };
}

function normalizeTokenRecord(kind, digest, value) {
  if (!/^[a-f0-9]{64}$/.test(digest) || !isPlainObject(value)) {
    throw new ToolError("INVALID_OAUTH_STORE", `${kind}.${digest} is invalid`);
  }
  if (
    typeof value.clientId !== "string" || !value.clientId ||
    typeof value.scope !== "string" || !value.scope ||
    typeof value.resource !== "string" || !value.resource ||
    !Number.isFinite(value.issuedAt) || !Number.isFinite(value.expiresAt)
  ) {
    throw new ToolError("INVALID_OAUTH_STORE", `${kind}.${digest} has an invalid token record`);
  }
  return {
    clientId: value.clientId,
    scope: value.scope,
    resource: value.resource,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt
  };
}

function normalizeDocument(value) {
  if (!isPlainObject(value) || value.version !== VERSION) {
    throw new ToolError("INVALID_OAUTH_STORE", `OAuth store must use version ${VERSION}`);
  }
  const clients = {};
  const rawClients = isPlainObject(value.clients) ? value.clients : {};
  for (const [clientId, raw] of Object.entries(rawClients)) clients[clientId] = normalizeClient(clientId, raw);

  const normalizeTokens = (kind, raw) => {
    const output = {};
    const object = isPlainObject(raw) ? raw : {};
    for (const [digest, record] of Object.entries(object)) output[digest] = normalizeTokenRecord(kind, digest, record);
    return output;
  };

  return {
    version: VERSION,
    clients,
    accessTokens: normalizeTokens("accessTokens", value.accessTokens),
    refreshTokens: normalizeTokens("refreshTokens", value.refreshTokens)
  };
}

function pruneExpired(document, now) {
  for (const collection of [document.accessTokens, document.refreshTokens]) {
    for (const [digest, record] of Object.entries(collection)) {
      if (record.expiresAt <= now) delete collection[digest];
    }
  }
}

function trimOldest(collection, maximum) {
  const entries = Object.entries(collection);
  if (entries.length <= maximum) return;
  entries.sort((a, b) => a[1].issuedAt - b[1].issuedAt);
  for (const [digest] of entries.slice(0, entries.length - maximum)) delete collection[digest];
}

function clientFingerprint(metadata) {
  return JSON.stringify([
    [...metadata.redirect_uris].sort(),
    metadata.token_endpoint_auth_method,
    metadata.grant_types,
    metadata.response_types,
    metadata.client_name
  ]);
}

export class OAuthStateStore {
  constructor(filePath, {
    now = () => Date.now(),
    maxClients = DEFAULT_MAX_CLIENTS,
    maxTokensPerKind = DEFAULT_MAX_TOKENS_PER_KIND
  } = {}) {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new ToolError("INVALID_OAUTH_STORE_PATH", "OAuth store path is required");
    }
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.now = now;
    this.maxClients = maxClients;
    this.maxTokensPerKind = maxTokensPerKind;
    this.queue = Promise.resolve();
  }

  async readDocument() {
    let text;
    try {
      text = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return emptyDocument();
      throw new ToolError("OAUTH_STORE_READ_FAILED", "could not read OAuth state", { cause: String(error) });
    }
    try {
      return normalizeDocument(JSON.parse(text));
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError("INVALID_OAUTH_STORE", "OAuth state is not valid JSON", { cause: String(error) });
    }
  }

  async writeDocument(document) {
    const normalized = normalizeDocument(document);
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      await fs.writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.chmod(temp, 0o600);
      await fs.rename(temp, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {});
      throw new ToolError("OAUTH_STORE_WRITE_FAILED", "could not update OAuth state", { cause: String(error) });
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
        if (error?.code !== "EEXIST") {
          throw new ToolError("OAUTH_STORE_LOCK_FAILED", "could not lock OAuth state", { cause: String(error) });
        }
        const stat = await fs.stat(this.lockPath).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          await fs.rm(this.lockPath, { force: true }).catch(() => {});
          continue;
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
    throw new ToolError("OAUTH_STORE_BUSY", "OAuth state is busy");
  }

  async mutate(operation) {
    const run = this.queue.then(async () => {
      const lock = await this.acquireLock();
      try {
        const document = await this.readDocument();
        pruneExpired(document, this.now());
        const result = await operation(document);
        trimOldest(document.accessTokens, this.maxTokensPerKind);
        trimOldest(document.refreshTokens, this.maxTokensPerKind);
        await this.writeDocument(document);
        return result;
      } finally {
        await lock.close().catch(() => {});
        await fs.rm(this.lockPath, { force: true }).catch(() => {});
      }
    });
    this.queue = run.catch(() => {});
    return await run;
  }

  async registerClient(metadata) {
    return await this.mutate(async (document) => {
      const fingerprint = clientFingerprint(metadata);
      for (const client of Object.values(document.clients)) {
        if (clientFingerprint(client) === fingerprint) return structuredClone(client);
      }
      if (Object.keys(document.clients).length >= this.maxClients) {
        throw new ToolError("OAUTH_CLIENT_LIMIT_REACHED", "OAuth client registration limit reached");
      }
      const clientId = randomOAuthToken("client_");
      const record = {
        ...metadata,
        client_id: clientId,
        client_id_issued_at: Math.floor(this.now() / 1000)
      };
      document.clients[clientId] = record;
      return structuredClone(record);
    });
  }

  async getClient(clientId) {
    if (typeof clientId !== "string" || !clientId) return null;
    const document = await this.readDocument();
    const record = document.clients[clientId];
    return record ? structuredClone(record) : null;
  }

  issueTokenPairInDocument(document, {
    clientId,
    scope,
    resource,
    accessTokenTtlSec,
    refreshTokenTtlSec
  }) {
    if (!document.clients[clientId]) throw new ToolError("OAUTH_CLIENT_NOT_FOUND", "OAuth client is not registered");
    const now = this.now();
    const accessToken = randomOAuthToken("atk_");
    const refreshToken = randomOAuthToken("rtk_");
    document.accessTokens[hashToken(accessToken)] = {
      clientId,
      scope,
      resource,
      issuedAt: now,
      expiresAt: now + accessTokenTtlSec * 1000
    };
    document.refreshTokens[hashToken(refreshToken)] = {
      clientId,
      scope,
      resource,
      issuedAt: now,
      expiresAt: now + refreshTokenTtlSec * 1000
    };
    return { accessToken, refreshToken, expiresIn: accessTokenTtlSec, scope };
  }

  async issueTokenPair(options) {
    return await this.mutate(async (document) => this.issueTokenPairInDocument(document, options));
  }

  async verifyAccessToken(token, { scope, resource }) {
    if (typeof token !== "string" || !token) return null;
    const document = await this.readDocument();
    const record = document.accessTokens[hashToken(token)];
    if (!record || record.expiresAt <= this.now() || record.resource !== resource) return null;
    const scopes = new Set(record.scope.split(/\s+/).filter(Boolean));
    if (scope && !scopes.has(scope)) return null;
    return structuredClone(record);
  }

  async rotateRefreshToken(token, {
    clientId,
    resource,
    accessTokenTtlSec,
    refreshTokenTtlSec
  }) {
    if (typeof token !== "string" || !token) return null;
    return await this.mutate(async (document) => {
      const digest = hashToken(token);
      const record = document.refreshTokens[digest];
      if (!record || record.expiresAt <= this.now() || record.clientId !== clientId || record.resource !== resource) return null;
      delete document.refreshTokens[digest];
      return this.issueTokenPairInDocument(document, {
        clientId,
        scope: record.scope,
        resource,
        accessTokenTtlSec,
        refreshTokenTtlSec
      });
    });
  }

  async revokeToken(token) {
    if (typeof token !== "string" || !token) return;
    await this.mutate(async (document) => {
      const digest = hashToken(token);
      delete document.accessTokens[digest];
      delete document.refreshTokens[digest];
    });
  }
}
