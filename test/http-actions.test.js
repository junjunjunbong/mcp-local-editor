import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { ACTION_ROUTES, buildOpenApiDocument } from "../src/actions-contract.js";
import { ToolError } from "../src/errors.js";
import { ActionsHttpServer } from "../src/http-actions.js";
import { TOOL_DEFINITIONS } from "../src/service.js";

const TOKEN = "test-token-that-is-at-least-thirty-two-characters";

async function request({ port, path, method = "GET", token, body, headers = {} }) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) });
        });
      }
    );
    req.once("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function startServer(t, service, options = {}) {
  const server = new ActionsHttpServer(service, {
    token: TOKEN,
    toolDefinitions: TOOL_DEFINITIONS,
    host: "127.0.0.1",
    port: 0,
    ...options
  });
  const address = await server.start();
  t.after(async () => server.stop());
  return { server, port: address.port };
}

test("OpenAPI document exposes one authenticated POST operation per action route", () => {
  const document = buildOpenApiDocument({ serverUrl: "https://editor.example.com", toolDefinitions: TOOL_DEFINITIONS });
  assert.equal(document.openapi, "3.1.0");
  assert.equal(document.servers[0].url, "https://editor.example.com");
  assert.deepEqual(document.components.schemas, {});
  assert.equal(Object.keys(document.paths).length, ACTION_ROUTES.length);
  for (const route of ACTION_ROUTES) {
    assert.equal(document.paths[route.path].post.operationId, route.operationId);
    assert.deepEqual(document.paths[route.path].post.security, [{ bearerAuth: [] }]);
  }
});

test("OpenAPI document rejects missing tool definitions", () => {
  assert.throws(
    () => buildOpenApiDocument({ serverUrl: "https://editor.example.com", toolDefinitions: [] }),
    (error) => error instanceof ToolError && error.code === "MISSING_TOOL_DEFINITION"
  );
});

test("health and OpenAPI endpoints are available without bearer authentication", async (t) => {
  const { port } = await startServer(t, { call: async () => ({}) });
  const health = await request({ port, path: "/healthz" });
  assert.equal(health.status, 200);
  assert.equal(health.body.status, "ready");

  const schema = await request({
    port,
    path: "/openapi.json",
    headers: { host: "random.trycloudflare.com", "x-forwarded-proto": "https" }
  });
  assert.equal(schema.status, 200);
  assert.equal(schema.body.servers[0].url, "https://random.trycloudflare.com");
});

test("action routes reject missing and incorrect bearer tokens", async (t) => {
  const { port } = await startServer(t, { call: async () => ({}) });
  const missing = await request({ port, path: "/actions/workspaces/list", method: "POST", body: {} });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error.code, "UNAUTHORIZED");

  const wrong = await request({
    port,
    path: "/actions/workspaces/list",
    method: "POST",
    token: `${TOKEN}-wrong`,
    body: {}
  });
  assert.equal(wrong.status, 401);
});

test("authenticated action routes call the shared service with the expected tool and body", async (t) => {
  const calls = [];
  const service = {
    call: async (name, args) => {
      calls.push({ name, args });
      return { echoed: args.marker ?? null };
    }
  };
  const { port } = await startServer(t, service);

  const response = await request({
    port,
    path: "/actions/files/read",
    method: "POST",
    token: TOKEN,
    body: { marker: "hello" }
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, result: { echoed: "hello" } });
  assert.deepEqual(calls, [{ name: "file_read", args: { marker: "hello" } }]);
});

test("tool errors become stable HTTP error responses", async (t) => {
  const service = {
    call: async () => {
      throw new ToolError("STALE_FILE", "file changed", { current_sha256: "abc" });
    }
  };
  const { port } = await startServer(t, service);
  const response = await request({
    port,
    path: "/actions/files/edit",
    method: "POST",
    token: TOKEN,
    body: {}
  });
  assert.equal(response.status, 409);
  assert.deepEqual(response.body, {
    ok: false,
    error: { code: "STALE_FILE", message: "file changed", details: { current_sha256: "abc" } }
  });
});

test("action routes require JSON objects and enforce the body limit", async (t) => {
  const { port } = await startServer(t, { call: async () => ({}) }, { bodyLimitBytes: 1024 });

  const wrongType = await request({
    port,
    path: "/actions/workspaces/list",
    method: "POST",
    token: TOKEN,
    headers: { "content-type": "text/plain" },
    body: {}
  });
  assert.equal(wrongType.status, 415);

  const large = await request({
    port,
    path: "/actions/files/edit",
    method: "POST",
    token: TOKEN,
    body: { marker: "x".repeat(1200) }
  });
  assert.equal(large.status, 413);
});

test("known action paths reject non-POST methods", async (t) => {
  const { port } = await startServer(t, { call: async () => ({}) });
  const response = await request({ port, path: "/actions/workspaces/list", method: "GET" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, "POST");
});
