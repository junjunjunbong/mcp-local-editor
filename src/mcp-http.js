import http from "node:http";
import { asToolError, ToolError } from "./errors.js";
import {
  DEFAULT_BODY_LIMIT_BYTES,
  errorBody,
  isLoopbackHostname,
  isPlainObject,
  readJson,
  sendJson,
  sendText,
  statusForToolError,
  validatePublicUrl
} from "./http-utils.js";
import { McpStdioServer } from "./mcp-stdio.js";
import { OAUTH_DEFAULTS, SingleUserOAuth } from "./oauth.js";
import { OAuthStateStore } from "./oauth-store.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8790;
const AUTH_MODES = new Set(["none", "oauth"]);
const OAUTH_ROUTE_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
  "/register",
  "/authorize",
  "/token",
  "/revoke"
]);

function normalizeHost(value) {
  if (typeof value !== "string" || !value.trim() || /[\r\n/]/.test(value)) {
    throw new ToolError("INVALID_HOST", "host must be a hostname or IP address");
  }
  return value.trim();
}

function normalizePort(value, { allowZero = true } = {}) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 65535) {
    throw new ToolError("INVALID_PORT", `port must be ${allowZero ? "0-65535" : "1-65535"}`);
  }
  return value;
}

function decorateToolDefinitions(definitions, authMode, scope) {
  return definitions.map((definition) => {
    const cloned = structuredClone(definition);
    const meta = { ...(cloned._meta ?? {}), "openai/visibility": "public" };
    if (authMode === "oauth") {
      const securitySchemes = [{ type: "oauth2", scopes: [scope] }];
      cloned.securitySchemes = securitySchemes;
      meta.securitySchemes = securitySchemes;
    }
    cloned._meta = meta;
    return cloned;
  });
}

function parseHostHeader(hostHeader) {
  if (typeof hostHeader !== "string" || !hostHeader || /[\r\n/]/.test(hostHeader)) return null;
  try { return new URL(`http://${hostHeader}`); } catch { return null; }
}

function hostAllowed(request, publicUrl) {
  const parsed = parseHostHeader(request.headers.host);
  if (!parsed) return false;
  if (parsed.host.toLowerCase() === publicUrl.host.toLowerCase()) return true;
  return isLoopbackHostname(parsed.hostname) && isLoopbackHostname(request.socket.remoteAddress);
}

function originAllowed(request, publicUrl) {
  const raw = request.headers.origin;
  if (raw === undefined) return true;
  if (typeof raw !== "string") return false;
  let parsed;
  try { parsed = new URL(raw); } catch { return false; }
  if (parsed.origin === publicUrl.origin) return true;
  if (parsed.origin === "https://chatgpt.com" || parsed.origin === "https://chat.openai.com") return true;
  return isLoopbackHostname(parsed.hostname) && isLoopbackHostname(request.socket.remoteAddress);
}

function requestOrigin(request, publicUrl) {
  const raw = request.headers.origin;
  if (typeof raw !== "string") return publicUrl.origin;
  try { return new URL(raw).origin; } catch { return publicUrl.origin; }
}

function responseProtocolVersion(message, request) {
  if (isPlainObject(message) && isPlainObject(message.result) && typeof message.result.protocolVersion === "string") {
    return message.result.protocolVersion;
  }
  return String(request.headers["mcp-protocol-version"] ?? "2026-07-28");
}

export class McpHttpServer {
  constructor(service, {
    host = DEFAULT_HOST,
    port = DEFAULT_PORT,
    publicUrl,
    auth = { mode: "none" },
    bodyLimitBytes = DEFAULT_BODY_LIMIT_BYTES,
    toolDefinitions = undefined,
    now = () => Date.now()
  } = {}) {
    if (!service || typeof service.call !== "function" || typeof service.instructions !== "function") {
      throw new ToolError("INVALID_SERVICE", "service must provide call() and instructions()");
    }
    if (!Number.isInteger(bodyLimitBytes) || bodyLimitBytes < 1024 || bodyLimitBytes > 10 * 1024 * 1024) {
      throw new ToolError("INVALID_BODY_LIMIT", "body limit must be between 1024 and 10485760 bytes");
    }

    this.service = service;
    this.host = normalizeHost(host);
    this.port = normalizePort(port);
    this.publicUrl = validatePublicUrl(publicUrl ?? `http://${this.host}:${this.port || DEFAULT_PORT}`);
    this.bodyLimitBytes = bodyLimitBytes;
    this.authMode = auth?.mode ?? "none";
    if (!AUTH_MODES.has(this.authMode)) throw new ToolError("INVALID_AUTH_MODE", "auth mode must be none or oauth");
    this.scope = auth?.scope ?? OAUTH_DEFAULTS.scope;
    this.oauth = null;

    if (this.authMode === "oauth") {
      const store = auth.store ?? new OAuthStateStore(auth.storePath, { now });
      this.oauth = new SingleUserOAuth({
        publicUrl: this.publicUrl,
        ownerToken: auth.ownerToken,
        store,
        scope: this.scope,
        accessTokenTtlSec: auth.accessTokenTtlSec ?? OAUTH_DEFAULTS.accessTokenTtlSec,
        refreshTokenTtlSec: auth.refreshTokenTtlSec ?? OAUTH_DEFAULTS.refreshTokenTtlSec,
        allowedRedirectHosts: auth.allowedRedirectHosts ?? OAUTH_DEFAULTS.redirectHosts,
        now
      });
    }

    const definitions = toolDefinitions ?? service.toolDefinitions ?? [];
    this.protocol = new McpStdioServer(service, {
      toolDefinitions: decorateToolDefinitions(definitions, this.authMode, this.scope)
    });
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        const normalized = asToolError(error);
        if (!response.headersSent) sendJson(response, statusForToolError(normalized), errorBody(normalized));
        else response.destroy();
      });
    });
  }

  applySecurityHeaders(response) {
    response.setHeader(
      "content-security-policy",
      "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://chatgpt.com https://chat.openai.com; style-src 'unsafe-inline'"
    );
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (this.publicUrl.protocol === "https:") response.setHeader("strict-transport-security", "max-age=31536000");
  }

  async handle(request, response) {
    this.applySecurityHeaders(response);
    if (!hostAllowed(request, this.publicUrl)) {
      sendJson(response, 400, errorBody(new ToolError("INVALID_HOST_HEADER", "Host header is not allowed")));
      return;
    }
    const url = new URL(request.url ?? "/", this.publicUrl);
    const oauthBrowserFlow = this.oauth && OAUTH_ROUTE_PATHS.has(url.pathname);
    if (!oauthBrowserFlow && !originAllowed(request, this.publicUrl)) {
      sendJson(response, 403, errorBody(new ToolError("FORBIDDEN", "Origin is not allowed")));
      return;
    }
    if (!oauthBrowserFlow && typeof request.headers.origin === "string") {
      response.setHeader("access-control-allow-origin", requestOrigin(request, this.publicUrl));
      response.setHeader("access-control-expose-headers", "MCP-Protocol-Version, WWW-Authenticate");
      response.setHeader("vary", "Origin");
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": requestOrigin(request, this.publicUrl),
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type, MCP-Protocol-Version",
        "access-control-expose-headers": "MCP-Protocol-Version, WWW-Authenticate",
        "access-control-max-age": "600",
        vary: "Origin"
      });
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, {
        ok: true,
        service: "mcp-local-editor",
        transport: "streamable-http",
        auth: this.authMode
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/") {
      sendText(response, 200, "mcp-local-editor remote MCP server\nEndpoint: /mcp\n");
      return;
    }
    if (this.oauth && await this.oauth.handle(request, response, url, this.bodyLimitBytes)) return;
    if (url.pathname === "/mcp") {
      await this.handleMcp(request, response);
      return;
    }
    sendJson(response, 404, errorBody(new ToolError("ROUTE_NOT_FOUND", "route was not found")));
  }

  async handleMcp(request, response) {
    if (request.method !== "POST") {
      sendJson(response, 405, errorBody(new ToolError("METHOD_NOT_ALLOWED", "stateless MCP accepts POST requests only")), { allow: "POST" });
      return;
    }
    if (this.oauth && !(await this.oauth.authenticate(request, response))) return;

    const accept = String(request.headers.accept ?? "*/*").toLowerCase();
    if (!accept.includes("*/*") && !accept.includes("application/json") && !accept.includes("text/event-stream")) {
      sendJson(response, 406, errorBody(new ToolError("NOT_ACCEPTABLE", "Accept must allow application/json or text/event-stream")));
      return;
    }

    const result = await this.protocol.handleMessage(await readJson(request, this.bodyLimitBytes));
    if (result === null) {
      response.writeHead(202, {
        "cache-control": "no-store",
        "access-control-expose-headers": "MCP-Protocol-Version"
      });
      response.end();
      return;
    }
    sendJson(response, 200, result, {
      "mcp-protocol-version": responseProtocolVersion(result, request),
      "access-control-expose-headers": "MCP-Protocol-Version"
    });
  }

  async start() {
    if (this.server.listening) throw new ToolError("SERVER_ALREADY_RUNNING", "MCP HTTP server is already running");
    await new Promise((resolve, reject) => {
      const onError = (error) => { this.server.off("listening", onListening); reject(error); };
      const onListening = () => { this.server.off("error", onError); resolve(); };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.port, this.host);
    });
    const address = this.server.address();
    return {
      host: this.host,
      port: typeof address === "object" && address ? address.port : this.port,
      public_url: this.publicUrl.origin
    };
  }

  async waitUntilClosed() {
    if (!this.server.listening) return;
    await new Promise((resolve) => this.server.once("close", resolve));
  }

  async stop() {
    if (!this.server.listening) return;
    await new Promise((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }
}

export const MCP_HTTP_DEFAULTS = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  bodyLimitBytes: DEFAULT_BODY_LIMIT_BYTES,
  scope: OAUTH_DEFAULTS.scope,
  accessTokenTtlSec: OAUTH_DEFAULTS.accessTokenTtlSec,
  refreshTokenTtlSec: OAUTH_DEFAULTS.refreshTokenTtlSec,
  redirectHosts: [...OAUTH_DEFAULTS.redirectHosts]
};
