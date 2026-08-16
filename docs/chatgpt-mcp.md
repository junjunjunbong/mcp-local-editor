# ChatGPT custom MCP app setup

This guide connects `mcp-local-editor` to normal ChatGPT conversations as a custom MCP app. The existing Custom GPT Actions adapter remains available, but it is no longer the only web integration.

## Choose a tool profile

The server has two independently enforced profiles.

| Profile | Tools | Intended use |
| --- | --- | --- |
| `read` | workspace list/open, search, read, Git diff | ChatGPT accounts or workspaces that permit read/fetch tools only |
| `full` | all seven tools, including edit and allowlisted commands | MCP clients and ChatGPT workspaces that permit modify tools |

The remote MCP CLI defaults to `read`. A client cannot turn a read session into a write session by changing arguments: the write tools are omitted from discovery, `workspace_open` has no `access` field, and the service forces `access: read`.

The stdio CLI remains `full` by default for backward compatibility.

```bash
mcp-local-editor serve --profile full
mcp-local-editor serve --profile read
```

## Route A: OpenAI Secure MCP Tunnel

Use this route when the local stdio process should not be exposed through a public reverse proxy.

1. Register the workspaces normally.
2. Configure OpenAI's Secure MCP Tunnel to launch:

```bash
node /absolute/path/to/mcp-local-editor/src/cli.js serve --profile read
```

3. Register the tunnel connection as a custom app in ChatGPT developer mode.
4. Enable the app in a normal conversation.

The official tunnel client and its current setup commands are maintained at:

- https://github.com/openai/tunnel-client

For a full-capability workspace, replace `--profile read` with `--profile full` only when the ChatGPT workspace permits modify tools.

## Route B: direct HTTPS MCP with local OAuth

This repository includes a dependency-free stateless Streamable HTTP server at `/mcp`. It implements single-owner OAuth authorization-code flow with PKCE.

### 1. Register a workspace

```bash
cd /Users/junwon/Projects/mcp-local-editor
npm link

mcp-local-editor workspace add \
  my-project \
  /Users/junwon/Projects/my-project \
  --display-name "My Project" \
  --commands /Users/junwon/Projects/my-project/commands.local.json
```

Commands are optional. The read profile never exposes or executes them.

### 2. Create the owner token

```bash
cd /Users/junwon/Projects/mcp-local-editor
umask 077
openssl rand -hex 32 > .mcp-local-editor-token
chmod 600 .mcp-local-editor-token
```

The OAuth approval page checks this token locally. The token is not returned to ChatGPT and is not stored in the OAuth state file.

### 3. Provide a public HTTPS origin

A fixed hostname is preferable. For a temporary Cloudflare route, run this in one terminal:

```bash
cloudflared tunnel --url http://127.0.0.1:8790
```

Copy the generated origin, for example:

```text
https://example.trycloudflare.com
```

The server's `--public-url` value must be the origin only. Do not append `/mcp`.

### 4. Start the remote MCP server

```bash
mcp-local-editor-mcp \
  --host 127.0.0.1 \
  --port 8790 \
  --public-url https://example.trycloudflare.com \
  --owner-token-file /Users/junwon/Projects/mcp-local-editor/.mcp-local-editor-token \
  --profile read
```

The server prints the local listener, public MCP endpoint, active tool profile, authentication mode, registry path, and OAuth state path. It never prints the token.

Verify discovery before registering the app:

```bash
curl -sS https://example.trycloudflare.com/.well-known/oauth-protected-resource/mcp
curl -sS https://example.trycloudflare.com/.well-known/oauth-authorization-server
curl -sS https://example.trycloudflare.com/healthz
```

The MCP endpoint itself should return an authorization challenge when called without a bearer token.

```bash
curl -i \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  https://example.trycloudflare.com/mcp
```

Expected status: `401 Unauthorized`, with a `WWW-Authenticate` header referring to the protected-resource metadata URL.

### 5. Create the ChatGPT app

In ChatGPT developer mode, create a custom MCP app using:

```text
MCP URL: https://example.trycloudflare.com/mcp
Authentication: OAuth
```

ChatGPT dynamically registers an OAuth public client. The authorization page opens from the local MCP server. Paste the owner token from `.mcp-local-editor-token` to approve the connection.

After authorization, enable the app in a normal ChatGPT conversation. A useful first request is:

```text
Use MCP Local Editor. List the registered workspaces, open my-project, read its README, and show the current Git diff.
```

### 6. Full profile

Use full mode only when the client and ChatGPT workspace permit modify tools:

```bash
mcp-local-editor-mcp \
  --public-url https://editor.example.com \
  --owner-token-file /Users/junwon/Projects/mcp-local-editor/.mcp-local-editor-token \
  --profile full
```

The full profile still requires a write workspace session before `file_edit` or `command_run` can succeed.

## OAuth behavior

The remote server exposes:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-authorization-server`
- `/.well-known/openid-configuration` as a compatibility alias
- `/register`
- `/authorize`
- `/token`
- `/revoke`
- `/mcp`

Security properties include:

- authorization code lifetime of 5 minutes
- PKCE S256 required for every authorization
- one-time authorization codes
- rotating refresh tokens
- bearer-token revocation
- owner-token attempt limiting
- dynamic-client registration limiting and bounded state
- strict redirect URI validation
- Host and Origin validation
- bounded request bodies
- atomic OAuth state writes with a process-safe lock
- access and refresh tokens persisted only as SHA-256 hashes
- mode `0600` for OAuth state on POSIX systems

The implementation is single-owner OAuth for a trusted local development machine. It is not a general multi-tenant identity provider.

## Local state

The default files are:

```text
workspaces.local.json
workspaces.local.json.oauth.json
.mcp-local-editor-token
```

All are ignored by Git. Override locations with:

```text
MCP_LOCAL_EDITOR_REGISTRY
MCP_LOCAL_EDITOR_OWNER_TOKEN_FILE
MCP_LOCAL_EDITOR_OAUTH_STORE
```

Other remote MCP environment settings:

```text
MCP_LOCAL_EDITOR_SESSION_TTL_SEC
MCP_LOCAL_EDITOR_MCP_PROFILE
MCP_LOCAL_EDITOR_MCP_HOST
MCP_LOCAL_EDITOR_MCP_PORT
MCP_LOCAL_EDITOR_MCP_PUBLIC_URL
MCP_LOCAL_EDITOR_MCP_AUTH
MCP_LOCAL_EDITOR_ALLOW_UNAUTHENTICATED
```

## Public URL changes

Access and refresh tokens are bound to the configured MCP resource URL. If a temporary tunnel hostname changes:

1. stop the old MCP process;
2. start the new tunnel;
3. restart `mcp-local-editor-mcp` with the new `--public-url`;
4. reconnect or reauthorize the ChatGPT app.

Old tokens will not authorize a different MCP resource URL. To remove old client registrations as well, delete the OAuth state file while the MCP process is stopped.

## Unauthenticated local mode

No-auth mode requires an explicit acknowledgement:

```bash
mcp-local-editor-mcp \
  --auth none \
  --allow-unauthenticated \
  --public-url http://127.0.0.1:8790
```

Use this only for loopback development or behind a separately authenticated tunnel. Never expose it directly to the public internet.

## Troubleshooting

### ChatGPT reports that authorization metadata is missing

Check both metadata endpoints with `curl`. Confirm that `--public-url` exactly matches the externally visible HTTPS origin and that the app URL ends in `/mcp`.

### The approval page opens but the callback fails

The registered redirect URI must be an HTTPS URL under `chatgpt.com` or `openai.com`, or a loopback HTTP URI for local testing. Additional HTTPS redirect hosts can be added explicitly:

```bash
mcp-local-editor-mcp \
  --redirect-host auth.example.com \
  --public-url https://editor.example.com \
  --owner-token-file .mcp-local-editor-token
```

### The app connects but edit tools are absent

The remote CLI defaults to `--profile read`. Start it with `--profile full`, then refresh the app's tool discovery. The ChatGPT plan or workspace must also permit modify tools.

### `workspace_open` succeeds but later calls say the session expired

Workspace sessions default to 30 minutes and are kept in memory. Reopen the workspace or raise the bounded TTL:

```bash
mcp-local-editor-mcp --session-ttl-sec 3600 ...
```

### A temporary tunnel restarts and the app stops authenticating

Temporary tunnel hostnames can change. Update `--public-url` and reauthorize. Use a fixed hostname or Secure MCP Tunnel to avoid that churn.

## Migrating from Actions

The Actions adapter remains available and unchanged:

```bash
mcp-local-editor-actions \
  --token-file .mcp-local-editor-token \
  --host 127.0.0.1 \
  --port 8787
```

Use Actions only for an existing Custom GPT workflow. Use `/mcp` when the tool should appear as a custom app in normal ChatGPT conversations with MCP-native discovery and OAuth.
