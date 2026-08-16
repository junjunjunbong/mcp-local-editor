# mcp-local-editor

A local repository service that lets an MCP client or ChatGPT work inside **operator-registered workspaces**.

The server does not run Codex, OpenCodex, an external model provider, or an API model. The client supplies the reasoning loop. The same guarded service is available through three transports:

- stdio MCP with `mcp-local-editor serve`
- remote Streamable HTTP MCP with `mcp-local-editor-mcp`
- authenticated HTTP Actions with `mcp-local-editor-actions`

The remote MCP transport can be registered as a custom app and used from normal ChatGPT conversations. It is not tied to a Custom GPT.

## Tools and profiles

The full profile exposes seven tools:

- `workspace_list`
- `workspace_open`
- `repo_search`
- `file_read`
- `file_edit`
- `command_run`
- `git_diff`

The read profile exposes only `workspace_list`, read-only `workspace_open`, `repo_search`, `file_read`, and `git_diff`.

Read-only mode is enforced at three levels:

- write tools are omitted from MCP discovery;
- `workspace_open` does not expose an `access` field;
- the service forces a read session and does not return command identifiers.

## Requirements

- Node.js 20 or newer
- Git for `git_diff`
- ripgrep (`rg`) for `repo_search`
- an HTTPS route when ChatGPT connects directly to the remote MCP server

There are no npm runtime dependencies.

## Register workspaces

A folder is registered once and can remain anywhere on the computer.

```bash
npm link

mcp-local-editor workspace add \
  mcp-local-editor \
  /Users/junwon/Projects/mcp-local-editor \
  --display-name "MCP Local Editor" \
  --commands commands.local.json
```

A relative `--commands` path is resolved from the target workspace root. Register another folder the same way:

```bash
mcp-local-editor workspace add \
  ai-research-harness \
  /Users/junwon/Projects/ai-research-harness \
  --display-name "AI Research Harness" \
  --commands commands.local.json
```

List, replace, or remove registrations:

```bash
mcp-local-editor workspace list
mcp-local-editor workspace list --json

mcp-local-editor workspace add \
  ai-research-harness \
  /new/path/ai-research-harness \
  --replace

mcp-local-editor workspace remove ai-research-harness
```

Use `--replace --no-commands` to remove an inherited command configuration.

The default registry is stored next to this package in the Git-ignored file `workspaces.local.json`. Override it with `--registry`, `MCP_LOCAL_EDITOR_REGISTRY`, `MCP_LOCAL_EDITOR_HOME`, or `XDG_CONFIG_HOME`.

## Local stdio MCP

Run the existing full local editor:

```bash
mcp-local-editor serve
```

Run a read-only MCP catalog:

```bash
mcp-local-editor serve --profile read
```

Example stdio client configuration:

```json
{
  "mcpServers": {
    "local-editor": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-local-editor/src/cli.js",
        "serve",
        "--profile",
        "full"
      ]
    }
  }
}
```

The default workspace-session lifetime is 30 minutes. It can be configured between 60 and 3600 seconds:

```bash
mcp-local-editor serve --session-ttl-sec 1800
```

Sessions are kept in memory and disappear when the process stops. Workspace registrations remain on disk. `workspace_list` and `workspace_open` reload the registry, so newly registered workspaces become available without restarting the server.

## ChatGPT custom app

There are two deployment paths.

### Option A: Secure MCP Tunnel

Keep the service on stdio and configure OpenAI's Secure MCP Tunnel to launch:

```bash
node /absolute/path/to/mcp-local-editor/src/cli.js serve --profile read
```

Then register the tunnel connection as a custom app in ChatGPT developer mode. The current tunnel-client setup is documented at:

- https://github.com/openai/tunnel-client

Use `--profile full` only when the ChatGPT workspace permits modify tools.

### Option B: direct HTTPS MCP with OAuth

The repository includes a dependency-free stateless Streamable HTTP endpoint at `/mcp` with:

- OAuth authorization-code flow with PKCE S256
- dynamic client registration
- protected-resource and authorization-server metadata
- rotating refresh tokens and token revocation
- persistent client state and hashed bearer tokens
- owner-token approval with rate limiting
- bounded state and request bodies
- Host and Origin validation
- read-only remote profile by default

Create an owner token:

```bash
umask 077
openssl rand -hex 32 > .mcp-local-editor-token
chmod 600 .mcp-local-editor-token
```

Expose local port `8790` through a fixed HTTPS tunnel or reverse proxy. For a temporary Cloudflare route, start the tunnel first:

```bash
cloudflared tunnel --url http://127.0.0.1:8790
```

Copy the generated HTTPS origin, then start the MCP server. Do not append `/mcp` to `--public-url`.

```bash
mcp-local-editor-mcp \
  --host 127.0.0.1 \
  --port 8790 \
  --public-url https://example.trycloudflare.com \
  --owner-token-file /Users/junwon/Projects/mcp-local-editor/.mcp-local-editor-token \
  --profile read
```

Create the ChatGPT custom app with:

```text
MCP URL: https://example.trycloudflare.com/mcp
Authentication: OAuth
```

During authorization, enter the local owner token. The token is checked locally and is never returned to ChatGPT.

A stable HTTPS hostname is recommended. Access and refresh tokens are bound to the configured MCP resource URL. If a temporary hostname changes, restart with the new `--public-url` and authorize again.

The default OAuth state file is `<registry-path>.oauth.json`. It stores client metadata and only SHA-256 hashes of access and refresh tokens.

Full setup and troubleshooting are in [docs/chatgpt-mcp.md](docs/chatgpt-mcp.md).

### Full remote profile

The remote server defaults to `--profile read`. Expose modify tools only through an explicit choice:

```bash
mcp-local-editor-mcp \
  --public-url https://editor.example.com \
  --owner-token-file .mcp-local-editor-token \
  --profile full
```

Unauthenticated mode requires a second explicit acknowledgement:

```bash
mcp-local-editor-mcp \
  --auth none \
  --allow-unauthenticated \
  --public-url http://127.0.0.1:8790
```

Do not expose no-auth mode directly to the public internet.

## ChatGPT Actions fallback

Actions remain available for existing Custom GPT integrations:

```bash
umask 077
openssl rand -hex 32 > .mcp-local-editor-token

mcp-local-editor-actions \
  --token-file .mcp-local-editor-token \
  --host 127.0.0.1 \
  --port 8787
```

Expose port `8787` through HTTPS and import the public `/openapi.json` URL in a Custom GPT Action. See [docs/chatgpt-actions.md](docs/chatgpt-actions.md).

Use the MCP path when the tool should appear as a custom app in normal ChatGPT conversations. Keep Actions as a compatibility fallback.

## Normal tool flow

```text
workspace_list()
workspace_open({workspace_id: "mcp-local-editor", access: "write"})
file_read({session_id: "ses_...", path: "README.md"})
file_edit({session_id: "ses_...", path: "README.md", expected_sha256: "...", replacements: [...]})
command_run({session_id: "ses_...", command_id: "test"})
git_diff({session_id: "ses_..."})
```

In the read profile, `workspace_open` does not accept `access`; the service always creates a read session.

A read session may search, read, and inspect Git diffs. `file_edit` and `command_run` require a write session in the full profile. If a workspace registration is removed or replaced, existing sessions for it are revoked on their next tool call.

## Command allowlist

Commands are configured per workspace. The model supplies only a `command_id`; it cannot supply a shell string or extra arguments.

```json
{
  "commands": {
    "test": {
      "description": "Run the project test suite",
      "argv": ["npm", "test"],
      "timeoutSec": 300,
      "maxOutputBytes": 262144
    }
  }
}
```

Commands run with `shell: false`, a restricted environment, a timeout, output limits, and process-group termination on timeout. The command file is validated during registration, loaded when a session opens, and reloaded immediately before every `command_run`.

## Safety boundary

This is a workspace guard, not an operating-system sandbox.

It enforces:

- only operator-registered workspace ids can be opened
- model-supplied absolute paths are rejected
- lexical and symlink escapes are rejected
- edits require a current SHA-256 and an unambiguous exact-text match
- file writes use a temporary file and atomic rename
- read sessions cannot edit or execute commands
- the read profile omits write tools and enforces read access server-side
- only operator-configured argv arrays can run
- Git operations are read-only
- concurrent workspace sessions remain isolated
- direct remote MCP requires OAuth by default
- OAuth tokens are persisted only as hashes
- OAuth state uses atomic writes and a local file lock
- OAuth owner-token and client-registration attempts are rate limited
- Actions require a separate bearer token

It does not provide Docker, VM, network isolation, arbitrary shell access, file create/delete/move, Git commit/push, automated tunnel management, or an autonomous agent loop.

Keep the owner token private. Do not commit the registry, OAuth state, command policy, or token files.

## Development

```bash
npm run check
```

CI runs the full check suite on Node.js 20 and 22. Tests cover registry persistence and locking, workspace replacement/removal, path confinement, stale edits, read/write access, session expiry and revocation, concurrent workspace isolation, stdio MCP, remote MCP, OAuth PKCE, refresh rotation, revocation, persisted bearer validation, OpenAPI generation, bearer authentication, body limits, and Actions dispatch.
