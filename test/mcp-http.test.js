import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpHttpServer } from "../src/mcp-http.js";
import { OAuthStateStore } from "../src/oauth-store.js";
import { LocalEditorService, toolDefinitionsForProfile } from "../src/service.js";

async function tempDir(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-http-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function fakeService() {
  return {
    toolDefinitions: [
      {
        name: "echo",
        title: "Echo",
        description: "Return the supplied text.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      }
    ],
    instructions() { return "Use echo."; },
    async call(name, args) {
      if (name !== "echo") throw new Error("unknown tool");
      return { text: args.text };
    }
  };
}

async function postMcp(base, body, token = undefined) {
  return await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

test("read profile exposes only read tools and forces read sessions", async () => {
  const definitions = toolDefinitionsForProfile("read");
  assert.deepEqual(
    definitions.map((tool) => tool.name),
    ["workspace_list", "workspace_open", "repo_search", "file_read", "git_diff"]
  );
  const open = definitions.find((tool) => tool.name === "workspace_open");
  assert.equal(open.annotations.readOnlyHint, true);
  assert.equal("access" in open.inputSchema.properties, false);

  const openedInputs = [];
  const service = new LocalEditorService(
    { async listStatus() { return []; } },
    {
      async open(input) {
        openedInputs.push(input);
        return {
          session_id: "ses_read",
          workspace_id: input.workspace_id,
          access: input.access,
          commands: [{ command_id: "hidden" }]
        };
      }
    },
    { profile: "read" }
  );

  const result = await service.call("workspace_open", { workspace_id: "repo" });
  assert.equal(openedInputs[0].access, "read");
  assert.equal("commands" in result, false);
  await assert.rejects(
    service.call("workspace_open", { workspace_id: "repo", access: "write" }),
    (error) => error.code === "PERMISSION_DENIED"
  );
  await assert.rejects(service.call("file_edit", {}), (error) => error.code === "UNKNOWN_TOOL");
});

test("stateless Streamable HTTP serves MCP initialize, tools, calls, and notifications", async (t) => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = new McpHttpServer(fakeService(), {
    host: "127.0.0.1",
    port,
    publicUrl: base,
    auth: { mode: "none" }
  });
  await server.start();
  t.after(() => server.stop());

  const initialized = await postMcp(base, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25" }
  });
  assert.equal(initialized.status, 200);
  const initializeBody = await initialized.json();
  assert.equal(initializeBody.result.protocolVersion, "2025-11-25");
  assert.equal(initializeBody.result.serverInfo.name, "mcp-local-editor");

  const listed = await postMcp(base, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listedBody = await listed.json();
  assert.equal(listedBody.result.tools[0].name, "echo");
  assert.equal(listedBody.result.tools[0]._meta["openai/visibility"], "public");

  const called = await postMcp(base, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "echo", arguments: { text: "ok" } }
  });
  const calledBody = await called.json();
  assert.equal(calledBody.result.structuredContent.text, "ok");

  const notification = await postMcp(base, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {}
  });
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), "");
});

test("remote MCP rejects untrusted browser origins", async (t) => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = new McpHttpServer(fakeService(), {
    host: "127.0.0.1",
    port,
    publicUrl: base,
    auth: { mode: "none" }
  });
  await server.start();
  t.after(() => server.stop());

  const response = await fetch(`${base}/healthz`, { headers: { origin: "https://evil.example" } });
  assert.equal(response.status, 403);
});

test("OAuth state serializes concurrent client registrations", async (t) => {
  const directory = await tempDir(t);
  const storePath = path.join(directory, "oauth.json");
  const stores = [new OAuthStateStore(storePath), new OAuthStateStore(storePath)];
  await Promise.all(Array.from({ length: 20 }, (_, index) => stores[index % 2].registerClient({
    redirect_uris: [`http://127.0.0.1:${41000 + index}/callback`],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: `client-${index}`
  })));
  const document = JSON.parse(await fs.readFile(storePath, "utf8"));
  assert.equal(Object.keys(document.clients).length, 20);
});

test("OAuth discovery, PKCE authorization, refresh rotation, revoke, and persisted access work end to end", async (t) => {
  const directory = await tempDir(t);
  const storePath = path.join(directory, "oauth.json");
  const ownerToken = "owner-token-".padEnd(64, "x");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let server = new McpHttpServer(fakeService(), {
    host: "127.0.0.1",
    port,
    publicUrl: base,
    auth: { mode: "oauth", ownerToken, storePath }
  });
  await server.start();
  t.after(async () => { await server.stop(); });

  const unauthorized = await postMcp(base, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {}
  });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("www-authenticate"), /oauth-protected-resource\/mcp/);

  const resourceMetadata = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(resourceMetadata.resource, `${base}/mcp`);
  const authorizationMetadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(authorizationMetadata.registration_endpoint, `${base}/register`);

  const redirectUri = "http://127.0.0.1:45678/callback";
  const registration = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      client_name: "test"
    })
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();

  const verifier = "v".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizeUrl = new URL(`${base}/authorize`);
  authorizeUrl.searchParams.set("client_id", client.client_id);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("scope", "mcp-local-editor");
  authorizeUrl.searchParams.set("resource", `${base}/mcp`);
  authorizeUrl.searchParams.set("state", "state-1");

  const approvalPage = await fetch(authorizeUrl, { headers: { origin: "null" } });
  assert.equal(approvalPage.status, 200);
  const html = await approvalPage.text();
  const requestId = html.match(/name="request_id" value="([^"]+)"/)?.[1];
  assert.ok(requestId);

  const denied = await fetch(`${base}/authorize`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "null"
    },
    body: new URLSearchParams({
      request_id: requestId,
      owner_token: "wrong-token-that-is-long-enough-123456"
    })
  });
  assert.equal(denied.status, 403);

  const approved = await fetch(`${base}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "null"
    },
    body: new URLSearchParams({ request_id: requestId, owner_token: ownerToken })
  });
  assert.equal(approved.status, 302);
  const callback = new URL(approved.headers.get("location"));
  assert.equal(callback.searchParams.get("state"), "state-1");
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const tokenResponse = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
      resource: `${base}/mcp`
    })
  });
  assert.equal(tokenResponse.status, 200);
  const firstTokens = await tokenResponse.json();

  const authenticated = await postMcp(base, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  }, firstTokens.access_token);
  assert.equal(authenticated.status, 200);
  const authenticatedBody = await authenticated.json();
  assert.deepEqual(
    authenticatedBody.result.tools[0].securitySchemes,
    [{ type: "oauth2", scopes: ["mcp-local-editor"] }]
  );

  const refreshed = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: firstTokens.refresh_token,
      resource: `${base}/mcp`
    })
  });
  assert.equal(refreshed.status, 200);
  const secondTokens = await refreshed.json();
  assert.notEqual(secondTokens.refresh_token, firstTokens.refresh_token);

  const reused = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: firstTokens.refresh_token,
      resource: `${base}/mcp`
    })
  });
  assert.equal(reused.status, 400);
  assert.equal((await reused.json()).error, "invalid_grant");

  const revoked = await fetch(`${base}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: firstTokens.access_token })
  });
  assert.equal(revoked.status, 200);
  const afterRevoke = await postMcp(base, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/list",
    params: {}
  }, firstTokens.access_token);
  assert.equal(afterRevoke.status, 401);

  await server.stop();
  const restartPort = await freePort();
  const restartBase = `http://127.0.0.1:${restartPort}`;
  server = new McpHttpServer(fakeService(), {
    host: "127.0.0.1",
    port: restartPort,
    publicUrl: base,
    auth: { mode: "oauth", ownerToken, storePath }
  });
  await server.start();
  const persisted = await postMcp(restartBase, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/list",
    params: {}
  }, secondTokens.access_token);
  assert.equal(persisted.status, 200);

  if (process.platform !== "win32") {
    assert.equal((await fs.stat(storePath)).mode & 0o777, 0o600);
  }
});
