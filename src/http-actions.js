import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { ACTION_ROUTES, buildOpenApiDocument, validatePublicUrl } from "./actions-contract.js";
import { asToolError, ToolError } from "./errors.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
const MIN_TOKEN_LENGTH = 32;

const ROUTES_BY_PATH = new Map(ACTION_ROUTES.map((route) => [route.path, route]));

function jsonResponse(response, statusCode, body, extraHeaders = {}) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders
  });
  response.end(payload);
}

function normalizeToken(token) {
  if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH || /[\r\n]/.test(token)) {
    throw new ToolError(
      "INVALID_ACTIONS_TOKEN",
      `Actions bearer token must be at least ${MIN_TOKEN_LENGTH} characters and contain no line breaks`
    );
  }
  return token;
}

function tokenMatches(expected, actual) {
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function bearerToken(request) {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  return token.length ? token : null;
}

function requireAuthorization(request, expectedToken) {
  const supplied = bearerToken(request);
  if (!supplied || !tokenMatches(expectedToken, supplied)) {
    throw new ToolError("UNAUTHORIZED", "Missing or invalid bearer token");
  }
}

function validatePort(value) {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new ToolError("INVALID_PORT", "port must be an integer between 0 and 65535");
  }
  return value;
}

function validateHost(value) {
  if (typeof value !== "string" || value.trim().length === 0 || /[\r\n/]/.test(value)) {
    throw new ToolError("INVALID_HOST", "host must be a non-empty hostname or IP address");
  }
  return value.trim();
}

function firstHeaderValue(value) {
  return typeof value === "string" ? value.split(",", 1)[0].trim() : undefined;
}

function inferredServerUrl(request, fallbackPort) {
  const forwardedProto = firstHeaderValue(request.headers["x-forwarded-proto"]);
  const protocol = forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : "http";
  const forwardedHost = firstHeaderValue(request.headers["x-forwarded-host"]);
  const host = forwardedHost || request.headers.host || `${DEFAULT_HOST}:${fallbackPort}`;
  if (/[^A-Za-z0-9.:[\]-]/.test(host)) {
    throw new ToolError("INVALID_HOST_HEADER", "Cannot build OpenAPI server URL from the request host");
  }
  return validatePublicUrl(`${protocol}://${host}`);
}

async function readJsonBody(request, limitBytes) {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new ToolError("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }

  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    throw new ToolError("REQUEST_TOO_LARGE", `Request body exceeds ${limitBytes} bytes`);
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > limitBytes) {
      request.resume();
      throw new ToolError("REQUEST_TOO_LARGE", `Request body exceeds ${limitBytes} bytes`);
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ToolError("INVALID_JSON", "Request body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolError("INVALID_ARGUMENT", "Request body must be a JSON object");
  }
  return parsed;
}

function statusForError(error) {
  switch (error.code) {
    case "UNAUTHORIZED": return 401;
    case "PERMISSION_DENIED":
    case "COMMAND_NOT_ALLOWED": return 403;
    case "WORKSPACE_NOT_FOUND":
    case "SESSION_NOT_FOUND":
    case "FILE_NOT_FOUND":
    case "UNKNOWN_TOOL": return 404;
    case "STALE_FILE":
    case "AMBIGUOUS_REPLACEMENT":
    case "TEXT_NOT_FOUND":
    case "NO_CHANGE":
    case "WORKSPACE_ALREADY_EXISTS":
    case "WORKSPACE_ROOT_ALREADY_REGISTERED":
    case "WORKSPACE_ROOT_CHANGED": return 409;
    case "SESSION_EXPIRED":
    case "SESSION_REVOKED": return 410;
    case "REQUEST_TOO_LARGE": return 413;
    case "UNSUPPORTED_MEDIA_TYPE": return 415;
    case "COMMAND_TIMEOUT": return 504;
    case "INTERNAL_ERROR": return 500;
    default:
      return error.code.startsWith("INVALID_") || error.code.endsWith("_REQUIRED") ? 400 : 500;
  }
}

function errorBody(error) {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details })
    }
  };
}

export class ActionsHttpServer {
  constructor(
    service,
    {
      token,
      toolDefinitions,
      host = DEFAULT_HOST,
      port = DEFAULT_PORT,
      publicUrl = undefined,
      bodyLimitBytes = DEFAULT_BODY_LIMIT_BYTES
    } = {}
  ) {
    if (!service || typeof service.call !== "function") {
      throw new ToolError("INVALID_SERVICE", "service must provide call(name, args)");
    }
    if (!Array.isArray(toolDefinitions)) {
      throw new ToolError("INVALID_TOOL_DEFINITIONS", "toolDefinitions must be an array");
    }
    if (!Number.isInteger(bodyLimitBytes) || bodyLimitBytes < 1024 || bodyLimitBytes > 10 * 1024 * 1024) {
      throw new ToolError("INVALID_BODY_LIMIT", "bodyLimitBytes must be between 1024 and 10485760");
    }

    this.service = service;
    this.token = normalizeToken(token);
    this.toolDefinitions = toolDefinitions;
    this.host = validateHost(host);
    this.port = validatePort(port);
    this.publicUrl = publicUrl === undefined ? undefined : validatePublicUrl(publicUrl);
    this.bodyLimitBytes = bodyLimitBytes;
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        const normalized = asToolError(error);
        if (!response.headersSent) jsonResponse(response, statusForError(normalized), errorBody(normalized));
        else response.destroy();
      });
    });
  }

  async handle(request, response) {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const pathname = requestUrl.pathname;

    if (request.method === "GET" && pathname === "/healthz") {
      jsonResponse(response, 200, { ok: true, service: "mcp-local-editor", version: "0.2.1", status: "ready" });
      return;
    }

    if (request.method === "GET" && pathname === "/openapi.json") {
      const serverUrl = this.publicUrl ?? inferredServerUrl(request, this.port);
      jsonResponse(response, 200, buildOpenApiDocument({ serverUrl, toolDefinitions: this.toolDefinitions }));
      return;
    }

    const route = ROUTES_BY_PATH.get(pathname);
    if (!route) {
      jsonResponse(response, 404, errorBody(new ToolError("ROUTE_NOT_FOUND", "Action route was not found")));
      return;
    }
    if (request.method !== "POST") {
      jsonResponse(
        response,
        405,
        errorBody(new ToolError("METHOD_NOT_ALLOWED", "Action routes accept POST requests only")),
        { allow: "POST" }
      );
      return;
    }

    requireAuthorization(request, this.token);
    const args = await readJsonBody(request, this.bodyLimitBytes);
    const result = await this.service.call(route.tool, args);
    jsonResponse(response, 200, { ok: true, result });
  }

  async start() {
    if (this.server.listening) throw new ToolError("SERVER_ALREADY_RUNNING", "Actions HTTP server is already running");
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.port, this.host);
    });
    const address = this.server.address();
    return {
      host: this.host,
      port: typeof address === "object" && address ? address.port : this.port,
      public_url: this.publicUrl ?? null
    };
  }

  async waitUntilClosed() {
    if (!this.server.listening) return;
    await new Promise((resolve) => this.server.once("close", resolve));
  }

  async stop() {
    if (!this.server.listening) return;
    await new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

export const ACTIONS_DEFAULTS = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  bodyLimitBytes: DEFAULT_BODY_LIMIT_BYTES,
  minTokenLength: MIN_TOKEN_LENGTH
};
