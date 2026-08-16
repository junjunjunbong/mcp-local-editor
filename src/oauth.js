import { createHash, timingSafeEqual } from "node:crypto";
import { asToolError, ToolError } from "./errors.js";
import {
  escapeHtml,
  isLoopbackHostname,
  isPlainObject,
  readForm,
  readJson,
  sendHtml,
  sendJson
} from "./http-utils.js";
import { hashToken, randomOAuthToken } from "./oauth-store.js";

const DEFAULT_SCOPE = "mcp-local-editor";
const DEFAULT_ACCESS_TOKEN_TTL_SEC = 60 * 60;
const DEFAULT_REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;
const DEFAULT_REDIRECT_HOSTS = ["chatgpt.com", "openai.com"];
const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const MAX_AUTH_REQUESTS = 1_000;
const MAX_AUTH_CODES = 1_000;
const OWNER_ATTEMPT_LIMIT = 5;
const OWNER_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const REGISTRATION_LIMIT = 30;
const REGISTRATION_WINDOW_MS = 15 * 60 * 1000;
const MAX_RATE_LIMIT_KEYS = 1_000;

function safeEqual(expected, actual) {
  if (typeof expected !== "string" || typeof actual !== "string") return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function pkceChallenge(verifier) {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function validateOwnerToken(value) {
  if (typeof value !== "string" || value.length < 32 || /[\r\n]/.test(value)) {
    throw new ToolError("INVALID_OWNER_TOKEN", "owner token must be at least 32 characters and contain no line breaks");
  }
  return value;
}

class OAuthRequestError extends Error {
  constructor(code, description, status = 400) {
    super(description);
    this.name = "OAuthRequestError";
    this.code = code;
    this.status = status;
  }
}

function sendOAuthError(response, error, headers = {}) {
  sendJson(response, error.status ?? 400, {
    error: error.code ?? "invalid_request",
    error_description: error.message
  }, headers);
}

function formValue(params, name, { required = false } = {}) {
  const raw = params.get(name);
  const value = raw?.trim() || undefined;
  if (required && !value) throw new OAuthRequestError("invalid_request", `${name} is required`);
  return value;
}

function normalizeScope(value, requiredScope) {
  const scopes = new Set(String(value || requiredScope).split(/\s+/).filter(Boolean));
  if (scopes.size !== 1 || !scopes.has(requiredScope)) {
    throw new OAuthRequestError("invalid_scope", `scope must be ${requiredScope}`);
  }
  return requiredScope;
}

function redirectHostAllowed(uri, allowedHosts) {
  let parsed;
  try { parsed = new URL(uri); } catch { return false; }
  if (parsed.hash || parsed.username || parsed.password) return false;
  if (parsed.protocol === "http:") return isLoopbackHostname(parsed.hostname);
  if (parsed.protocol !== "https:") return false;
  const hostname = parsed.hostname.toLowerCase();
  return [...allowedHosts].some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
}

function validateClientMetadata(raw, allowedHosts) {
  if (!isPlainObject(raw)) throw new OAuthRequestError("invalid_client_metadata", "client metadata must be a JSON object");
  if (!Array.isArray(raw.redirect_uris) || raw.redirect_uris.length < 1 || raw.redirect_uris.length > 20) {
    throw new OAuthRequestError("invalid_redirect_uri", "redirect_uris must contain 1-20 URLs");
  }
  const redirectUris = [...new Set(raw.redirect_uris)];
  if (redirectUris.some((uri) => typeof uri !== "string" || !redirectHostAllowed(uri, allowedHosts))) {
    throw new OAuthRequestError("invalid_redirect_uri", "redirect URI must use an approved HTTPS host or a loopback HTTP host");
  }
  if (raw.token_endpoint_auth_method !== undefined && raw.token_endpoint_auth_method !== "none") {
    throw new OAuthRequestError("invalid_client_metadata", "only token_endpoint_auth_method=none is supported");
  }
  if (raw.response_types !== undefined && (!Array.isArray(raw.response_types) || raw.response_types.some((value) => value !== "code"))) {
    throw new OAuthRequestError("invalid_client_metadata", "only response_type=code is supported");
  }
  const supportedGrants = new Set(["authorization_code", "refresh_token"]);
  if (raw.grant_types !== undefined && (!Array.isArray(raw.grant_types) || raw.grant_types.some((value) => !supportedGrants.has(value)))) {
    throw new OAuthRequestError("invalid_client_metadata", "only authorization_code and refresh_token grants are supported");
  }
  return {
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: typeof raw.client_name === "string" && raw.client_name.trim()
      ? raw.client_name.trim().slice(0, 200)
      : "ChatGPT MCP client"
  };
}

class FixedWindowLimiter {
  constructor(limit, windowMs, { now = () => Date.now(), maxKeys = MAX_RATE_LIMIT_KEYS } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.maxKeys = maxKeys;
    this.records = new Map();
  }

  prune() {
    const now = this.now();
    for (const [key, record] of this.records) if (record.resetAt <= now) this.records.delete(key);
    if (this.records.size <= this.maxKeys) return;
    const sorted = [...this.records.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (const [key] of sorted.slice(0, this.records.size - this.maxKeys)) this.records.delete(key);
  }

  status(key) {
    this.prune();
    const record = this.records.get(key);
    if (!record) return { allowed: true, retryAfterSec: 0 };
    return {
      allowed: record.count < this.limit,
      retryAfterSec: Math.max(1, Math.ceil((record.resetAt - this.now()) / 1000))
    };
  }

  record(key) {
    this.prune();
    const now = this.now();
    const existing = this.records.get(key);
    if (!existing || existing.resetAt <= now) this.records.set(key, { count: 1, resetAt: now + this.windowMs });
    else existing.count += 1;
    return this.status(key);
  }

  clear(key) {
    this.records.delete(key);
  }
}

function insertBounded(map, key, value, maximum) {
  if (map.size >= maximum) {
    const oldest = [...map.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) map.delete(oldest[0]);
  }
  map.set(key, value);
}

function parseBasicClient(request) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Basic ")) return null;
  let decoded;
  try { decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8"); } catch { return null; }
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  const clientId = decodeURIComponent(decoded.slice(0, separator));
  const secret = decodeURIComponent(decoded.slice(separator + 1));
  if (secret) throw new OAuthRequestError("invalid_client", "public clients must not send a client secret", 401);
  return clientId;
}

function clientIdFromTokenRequest(request, form) {
  const bodyClientId = formValue(form, "client_id");
  const basicClientId = parseBasicClient(request);
  if (bodyClientId && basicClientId && bodyClientId !== basicClientId) {
    throw new OAuthRequestError("invalid_client", "client_id does not match HTTP authorization", 401);
  }
  const clientId = bodyClientId || basicClientId;
  if (!clientId) throw new OAuthRequestError("invalid_client", "client_id is required", 401);
  return clientId;
}

export class SingleUserOAuth {
  constructor({
    publicUrl,
    ownerToken,
    store,
    scope = DEFAULT_SCOPE,
    accessTokenTtlSec = DEFAULT_ACCESS_TOKEN_TTL_SEC,
    refreshTokenTtlSec = DEFAULT_REFRESH_TOKEN_TTL_SEC,
    allowedRedirectHosts = DEFAULT_REDIRECT_HOSTS,
    now = () => Date.now()
  }) {
    this.publicUrl = publicUrl;
    this.ownerToken = validateOwnerToken(ownerToken);
    this.store = store;
    this.scope = scope;
    this.accessTokenTtlSec = accessTokenTtlSec;
    this.refreshTokenTtlSec = refreshTokenTtlSec;
    this.allowedRedirectHosts = new Set(allowedRedirectHosts.map((host) => String(host).toLowerCase()));
    this.now = now;
    this.authRequests = new Map();
    this.authCodes = new Map();
    this.ownerLimiter = new FixedWindowLimiter(OWNER_ATTEMPT_LIMIT, OWNER_ATTEMPT_WINDOW_MS, { now });
    this.registrationLimiter = new FixedWindowLimiter(REGISTRATION_LIMIT, REGISTRATION_WINDOW_MS, { now });
    this.resourceUrl = new URL("/mcp", publicUrl).href;
    this.resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", publicUrl).href;
  }

  authorizationMetadata() {
    const origin = this.publicUrl.origin;
    return {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      revocation_endpoint: `${origin}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [this.scope]
    };
  }

  protectedResourceMetadata() {
    return {
      resource: this.resourceUrl,
      authorization_servers: [this.publicUrl.origin],
      scopes_supported: [this.scope],
      bearer_methods_supported: ["header"]
    };
  }

  clientIp(request) {
    const remote = request.socket.remoteAddress ?? "unknown";
    if (isLoopbackHostname(remote)) {
      const forwarded = String(request.headers["x-forwarded-for"] ?? "").split(",", 1)[0].trim();
      if (forwarded) return forwarded;
    }
    return remote;
  }

  challenge(response, description = "Authorization required") {
    const safeDescription = description.replaceAll('"', "'");
    const challenge = `Bearer resource_metadata="${this.resourceMetadataUrl}", scope="${this.scope}", error="invalid_token", error_description="${safeDescription}"`;
    sendJson(response, 401, { error: "unauthorized", error_description: description }, { "www-authenticate": challenge });
  }

  async authenticate(request, response) {
    const authorization = request.headers.authorization;
    const match = typeof authorization === "string" ? authorization.match(/^Bearer\s+(.+)$/i) : null;
    if (!match) {
      this.challenge(response, "Missing bearer token");
      return null;
    }
    const record = await this.store.verifyAccessToken(match[1].trim(), { scope: this.scope, resource: this.resourceUrl });
    if (!record) {
      this.challenge(response, "Invalid or expired bearer token");
      return null;
    }
    return record;
  }

  methodNotAllowed(response, allow) {
    sendOAuthError(response, new OAuthRequestError("invalid_request", "method is not allowed", 405), { allow });
  }

  async handle(request, response, url, bodyLimitBytes) {
    const pathname = url.pathname;
    if (["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].includes(pathname)) {
      if (request.method !== "GET") this.methodNotAllowed(response, "GET");
      else sendJson(response, 200, this.protectedResourceMetadata(), { "access-control-allow-origin": "*" });
      return true;
    }
    if (["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"].includes(pathname)) {
      if (request.method !== "GET") this.methodNotAllowed(response, "GET");
      else sendJson(response, 200, this.authorizationMetadata(), { "access-control-allow-origin": "*" });
      return true;
    }
    if (pathname === "/register") {
      if (request.method !== "POST") this.methodNotAllowed(response, "POST");
      else await this.register(request, response, bodyLimitBytes);
      return true;
    }
    if (pathname === "/authorize") {
      if (request.method === "GET") await this.authorizeGet(request, response, url);
      else if (request.method === "POST") await this.authorizePost(request, response, bodyLimitBytes);
      else this.methodNotAllowed(response, "GET, POST");
      return true;
    }
    if (pathname === "/token") {
      if (request.method !== "POST") this.methodNotAllowed(response, "POST");
      else await this.token(request, response, bodyLimitBytes);
      return true;
    }
    if (pathname === "/revoke") {
      if (request.method !== "POST") this.methodNotAllowed(response, "POST");
      else await this.revoke(request, response, bodyLimitBytes);
      return true;
    }
    return false;
  }

  async register(request, response, bodyLimitBytes) {
    try {
      const ip = this.clientIp(request);
      const status = this.registrationLimiter.status(ip);
      if (!status.allowed) {
        sendOAuthError(response, new OAuthRequestError("temporarily_unavailable", "too many client registrations", 429), { "retry-after": String(status.retryAfterSec) });
        return;
      }
      this.registrationLimiter.record(ip);
      const metadata = validateClientMetadata(await readJson(request, bodyLimitBytes), this.allowedRedirectHosts);
      sendJson(response, 201, await this.store.registerClient(metadata));
    } catch (error) {
      const normalized = error instanceof OAuthRequestError
        ? error
        : new OAuthRequestError("invalid_client_metadata", asToolError(error).message);
      sendOAuthError(response, normalized);
    }
  }

  async validateAuthorizationRequest(params) {
    const clientId = formValue(params, "client_id", { required: true });
    const client = await this.store.getClient(clientId);
    if (!client) throw new OAuthRequestError("unauthorized_client", "unknown client_id", 401);
    const redirectUri = formValue(params, "redirect_uri", { required: true });
    if (!client.redirect_uris.includes(redirectUri)) throw new OAuthRequestError("invalid_request", "redirect_uri is not registered");
    if (formValue(params, "response_type", { required: true }) !== "code") {
      throw new OAuthRequestError("unsupported_response_type", "response_type must be code");
    }
    const codeChallenge = formValue(params, "code_challenge", { required: true });
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) throw new OAuthRequestError("invalid_request", "code_challenge is invalid");
    if (formValue(params, "code_challenge_method", { required: true }) !== "S256") {
      throw new OAuthRequestError("invalid_request", "code_challenge_method must be S256");
    }
    const resource = formValue(params, "resource") ?? this.resourceUrl;
    if (resource !== this.resourceUrl) throw new OAuthRequestError("invalid_target", "resource does not match this MCP server");
    return {
      clientId,
      redirectUri,
      codeChallenge,
      resource,
      scope: normalizeScope(formValue(params, "scope"), this.scope),
      state: formValue(params, "state"),
      createdAt: this.now(),
      expiresAt: this.now() + AUTH_REQUEST_TTL_MS
    };
  }

  pruneEphemeral() {
    const now = this.now();
    for (const collection of [this.authRequests, this.authCodes]) {
      for (const [key, record] of collection) if (record.expiresAt <= now) collection.delete(key);
    }
  }

  authorizationPage(requestId, errorMessage = "") {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect MCP Local Editor</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:520px;margin:48px auto;padding:0 20px;color:#202124}main{border:1px solid #dadce0;border-radius:12px;padding:24px}label,input,button{display:block;width:100%;box-sizing:border-box}input{margin:8px 0 16px;padding:11px;border:1px solid #9aa0a6;border-radius:8px}button{padding:11px;border:0;border-radius:8px;background:#111827;color:white;font-weight:600}.hint{color:#5f6368;font-size:14px}.error{color:#b3261e;font-weight:600}</style>
</head>
<body><main>
<h1>Connect MCP Local Editor</h1>
<p>Enter the owner token stored on this computer to approve ChatGPT's connection.</p>
${errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : ""}
<form method="post" action="/authorize">
<input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
<label for="owner_token">Owner token</label>
<input id="owner_token" name="owner_token" type="password" autocomplete="off" required autofocus>
<button type="submit">Authorize</button>
</form>
<p class="hint">The token is checked locally and is never returned to ChatGPT.</p>
</main></body></html>`;
  }

  async authorizeGet(_request, response, url) {
    try {
      this.pruneEphemeral();
      const record = await this.validateAuthorizationRequest(url.searchParams);
      const requestId = randomOAuthToken("req_");
      insertBounded(this.authRequests, hashToken(requestId), record, MAX_AUTH_REQUESTS);
      sendHtml(response, 200, this.authorizationPage(requestId));
    } catch (error) {
      const normalized = error instanceof OAuthRequestError
        ? error
        : new OAuthRequestError("invalid_request", asToolError(error).message);
      sendOAuthError(response, normalized);
    }
  }

  async authorizePost(request, response, bodyLimitBytes) {
    try {
      this.pruneEphemeral();
      const form = await readForm(request, bodyLimitBytes);
      const requestId = formValue(form, "request_id", { required: true });
      const requestKey = hashToken(requestId);
      const record = this.authRequests.get(requestKey);
      if (!record || record.expiresAt <= this.now()) throw new OAuthRequestError("invalid_request", "authorization request expired");

      const ip = this.clientIp(request);
      const status = this.ownerLimiter.status(ip);
      if (!status.allowed) {
        sendHtml(response, 429, this.authorizationPage(requestId, "Too many attempts. Try again later."), { "retry-after": String(status.retryAfterSec) });
        return;
      }
      const supplied = formValue(form, "owner_token", { required: true });
      if (!safeEqual(this.ownerToken, supplied)) {
        this.ownerLimiter.record(ip);
        sendHtml(response, 403, this.authorizationPage(requestId, "Owner token was not accepted."));
        return;
      }

      this.ownerLimiter.clear(ip);
      this.authRequests.delete(requestKey);
      const code = randomOAuthToken("code_");
      insertBounded(this.authCodes, hashToken(code), {
        ...record,
        createdAt: this.now(),
        expiresAt: this.now() + AUTH_CODE_TTL_MS
      }, MAX_AUTH_CODES);
      const redirect = new URL(record.redirectUri);
      redirect.searchParams.set("code", code);
      if (record.state) redirect.searchParams.set("state", record.state);
      response.writeHead(302, { location: redirect.href, "cache-control": "no-store" });
      response.end();
    } catch (error) {
      const normalized = error instanceof OAuthRequestError
        ? error
        : new OAuthRequestError("invalid_request", asToolError(error).message);
      sendOAuthError(response, normalized);
    }
  }

  async token(request, response, bodyLimitBytes) {
    try {
      this.pruneEphemeral();
      const form = await readForm(request, bodyLimitBytes);
      const grantType = formValue(form, "grant_type", { required: true });
      const clientId = clientIdFromTokenRequest(request, form);
      if (!(await this.store.getClient(clientId))) throw new OAuthRequestError("invalid_client", "unknown client_id", 401);

      let pair;
      if (grantType === "authorization_code") {
        const code = formValue(form, "code", { required: true });
        const codeKey = hashToken(code);
        const record = this.authCodes.get(codeKey);
        this.authCodes.delete(codeKey);
        if (!record || record.expiresAt <= this.now()) throw new OAuthRequestError("invalid_grant", "authorization code is invalid or expired");
        if (record.clientId !== clientId) throw new OAuthRequestError("invalid_grant", "authorization code belongs to another client");
        if (formValue(form, "redirect_uri", { required: true }) !== record.redirectUri) {
          throw new OAuthRequestError("invalid_grant", "redirect_uri does not match");
        }
        const verifier = formValue(form, "code_verifier", { required: true });
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(record.codeChallenge, pkceChallenge(verifier))) {
          throw new OAuthRequestError("invalid_grant", "PKCE verification failed");
        }
        const resource = formValue(form, "resource") ?? record.resource;
        if (resource !== record.resource) throw new OAuthRequestError("invalid_target", "resource does not match authorization request");
        pair = await this.store.issueTokenPair({
          clientId,
          scope: record.scope,
          resource,
          accessTokenTtlSec: this.accessTokenTtlSec,
          refreshTokenTtlSec: this.refreshTokenTtlSec
        });
      } else if (grantType === "refresh_token") {
        normalizeScope(formValue(form, "scope"), this.scope);
        const resource = formValue(form, "resource") ?? this.resourceUrl;
        if (resource !== this.resourceUrl) throw new OAuthRequestError("invalid_target", "resource does not match this MCP server");
        pair = await this.store.rotateRefreshToken(formValue(form, "refresh_token", { required: true }), {
          clientId,
          resource,
          accessTokenTtlSec: this.accessTokenTtlSec,
          refreshTokenTtlSec: this.refreshTokenTtlSec
        });
        if (!pair) throw new OAuthRequestError("invalid_grant", "refresh token is invalid or expired");
      } else {
        throw new OAuthRequestError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
      }

      sendJson(response, 200, {
        access_token: pair.accessToken,
        token_type: "Bearer",
        expires_in: pair.expiresIn,
        refresh_token: pair.refreshToken,
        scope: pair.scope
      }, { pragma: "no-cache" });
    } catch (error) {
      const normalized = error instanceof OAuthRequestError
        ? error
        : new OAuthRequestError("invalid_request", asToolError(error).message);
      sendOAuthError(response, normalized);
    }
  }

  async revoke(request, response, bodyLimitBytes) {
    try {
      const form = await readForm(request, bodyLimitBytes);
      await this.store.revokeToken(formValue(form, "token", { required: true }));
      sendJson(response, 200, {});
    } catch (error) {
      const normalized = error instanceof OAuthRequestError
        ? error
        : new OAuthRequestError("invalid_request", asToolError(error).message);
      sendOAuthError(response, normalized);
    }
  }
}

export const OAUTH_DEFAULTS = {
  scope: DEFAULT_SCOPE,
  accessTokenTtlSec: DEFAULT_ACCESS_TOKEN_TTL_SEC,
  refreshTokenTtlSec: DEFAULT_REFRESH_TOKEN_TTL_SEC,
  redirectHosts: [...DEFAULT_REDIRECT_HOSTS]
};
