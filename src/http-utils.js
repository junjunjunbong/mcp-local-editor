import { ToolError } from "./errors.js";

export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isLoopbackHostname(hostname) {
  const normalized = String(hostname ?? "").replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

export function validatePublicUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolError("PUBLIC_URL_REQUIRED", "public URL is required");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ToolError("INVALID_PUBLIC_URL", "public URL must be an absolute HTTP(S) URL");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ToolError("INVALID_PUBLIC_URL", "public URL cannot contain credentials, a query, or a fragment");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new ToolError("INVALID_PUBLIC_URL", "public URL must be an origin without a path; append /mcp only in ChatGPT");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))) {
    throw new ToolError("INVALID_PUBLIC_URL", "public URL must use HTTPS except for loopback development");
  }
  return new URL(parsed.origin);
}

export function sendBuffer(response, status, contentType, payload, headers = {}) {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": String(payload.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  });
  response.end(payload);
}

export function sendJson(response, status, body, headers = {}) {
  sendBuffer(
    response,
    status,
    "application/json; charset=utf-8",
    Buffer.from(`${JSON.stringify(body)}\n`, "utf8"),
    headers
  );
}

export function sendText(response, status, text, headers = {}) {
  sendBuffer(response, status, "text/plain; charset=utf-8", Buffer.from(text, "utf8"), headers);
}

export function sendHtml(response, status, html, headers = {}) {
  sendBuffer(response, status, "text/html; charset=utf-8", Buffer.from(html, "utf8"), headers);
}

export async function readBody(request, limitBytes = DEFAULT_BODY_LIMIT_BYTES) {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > limitBytes) {
    throw new ToolError("REQUEST_TOO_LARGE", `request body exceeds ${limitBytes} bytes`);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limitBytes) {
      request.resume();
      throw new ToolError("REQUEST_TOO_LARGE", `request body exceeds ${limitBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function contentType(request) {
  return String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
}

export async function readJson(request, limitBytes = DEFAULT_BODY_LIMIT_BYTES) {
  if (contentType(request) !== "application/json") {
    throw new ToolError("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  const text = await readBody(request, limitBytes);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ToolError("INVALID_JSON", "request body is not valid JSON");
  }
}

export async function readForm(request, limitBytes = DEFAULT_BODY_LIMIT_BYTES) {
  if (contentType(request) !== "application/x-www-form-urlencoded") {
    throw new ToolError("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/x-www-form-urlencoded");
  }
  return new URLSearchParams(await readBody(request, limitBytes));
}

export function statusForToolError(error) {
  switch (error.code) {
    case "UNAUTHORIZED": return 401;
    case "FORBIDDEN": return 403;
    case "ROUTE_NOT_FOUND": return 404;
    case "METHOD_NOT_ALLOWED": return 405;
    case "NOT_ACCEPTABLE": return 406;
    case "REQUEST_TOO_LARGE": return 413;
    case "UNSUPPORTED_MEDIA_TYPE": return 415;
    case "INTERNAL_ERROR": return 500;
    default:
      return error.code.startsWith("INVALID_") || error.code.endsWith("_REQUIRED") ? 400 : 500;
  }
}

export function errorBody(error) {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details })
    }
  };
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
