# mcp-local-editor

A workspace guard for MCP clients and ChatGPT.

The client supplies the reasoning loop. This server does not run a model, spawn an agent, or talk to an API provider. An operator registers local folders; the client may then search, read, inspect Git diffs, and — only in the full profile — edit files or run allowlisted commands inside those folders.

The same service is available on three transports:

| Transport | Command | Typical client |
| --- | --- | --- |
| stdio MCP | `mcp-local-editor serve` | Claude Desktop, Cursor, and other local MCP hosts |
| Streamable HTTP MCP | `mcp-local-editor-mcp` | ChatGPT custom apps |
| Authenticated HTTP Actions | `mcp-local-editor-actions` | Existing Custom GPT Actions |

Remote MCP can be registered as a ChatGPT custom app and used in ordinary conversations. It is not tied to a Custom GPT.

There are no npm runtime dependencies.

## Why this exists

Most local MCP servers try to become a coding agent: a shell, the whole disk, commits, and a long tool list. This one stays a guard.

- Only operator-registered workspace ids can be opened.
- Models never see absolute local paths from `workspace_list`.
- Remote MCP defaults to a read-only profile.
- Git is inspection only. There is no commit or push.
- Commands are argv arrays from an operator file, not a shell string.

Use it when uncommitted, ignored, or otherwise local-only text needs to be visible to a model you already pay for. Use a coding agent when you want the model to own the loop.

## Tools

| Tool | `read` | `full` | Role |
| --- | :---: | :---: | --- |
| `workspace_list` | yes | yes | List registered ids and availability |
| `workspace_open` | read session only | read or write | Open a short-lived session |
| `repo_search` | yes | yes | ripgrep inside the session workspace |
| `file_read` | yes | yes | Bounded UTF-8 read plus SHA-256 |
| `git_diff` | yes | yes | Status and diffs, no Git writes |
| `file_edit` | — | write session | Exact-text replacements with a current hash |
| `command_run` | — | write session | Allowlisted argv, or unlisted argv when the workspace opts in |

Read-only mode is enforced three times: write tools are omitted from MCP discovery, `workspace_open` has no `access` field, and the service forces a read session and withholds command identifiers.

stdio defaults to `full`. Remote MCP defaults to `read`. A client cannot turn a read profile into a write session by changing arguments.

## Requirements

- Node.js 20 or newer
- Git, for `git_diff`
- ripgrep (`rg`), for `repo_search`
- An HTTPS origin when ChatGPT connects to the remote MCP server directly

From a local checkout:

```bash
npm link
```

The package is not published to npm. `npm link` installs the three binaries from this tree: `mcp-local-editor`, `mcp-local-editor-mcp`, and `mcp-local-editor-actions`.

## Register workspaces

A folder is registered once and can stay anywhere on the machine.

```bash
mcp-local-editor workspace add \
  my-project \
  /absolute/path/to/my-project \
  --display-name "My Project" \
  --commands commands.example.json
```

A relative `--commands` path is resolved from that workspace root. Repeat the command for each folder.

```bash
mcp-local-editor workspace list
mcp-local-editor workspace list --json

mcp-local-editor workspace add \
  my-project \
  /absolute/path/to/moved-project \
  --replace

mcp-local-editor workspace remove my-project
```

`--replace --no-commands` drops an inherited command file. To let the CLI pick an id from the folder name (this is what the macOS menu bar uses):

```bash
mcp-local-editor workspace add-folder /absolute/path/to/my-project
```

The default registry is the Git-ignored file `workspaces.local.json` next to this package. Override it with `--registry`, `MCP_LOCAL_EDITOR_REGISTRY`, `MCP_LOCAL_EDITOR_HOME`, or `XDG_CONFIG_HOME`.

`workspace_list` and `workspace_open` reload the registry, so a newly added folder is visible without restarting the server. Sessions live in memory and disappear when the process exits. Registrations stay on disk.

## Local MCP

```bash
mcp-local-editor serve
mcp-local-editor serve --profile read
mcp-local-editor serve --session-ttl-sec 1800
```

Session lifetime defaults to 30 minutes and can be set between 60 and 3600 seconds.

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

Typical write-session flow:

```text
workspace_list()
workspace_open({workspace_id: "my-project", access: "write"})
file_read({session_id: "ses_...", path: "README.md"})
file_edit({session_id: "ses_...", path: "README.md", expected_sha256: "...", replacements: [...]})
command_run({session_id: "ses_...", command_id: "test"})
git_diff({session_id: "ses_..."})
```

In the read profile, `workspace_open` does not accept `access`. A read session may search, read, and inspect diffs. `file_edit` and `command_run` need a write session in the full profile. Removing or replacing a registration revokes its sessions on the next tool call.

## ChatGPT

Two ways to reach a normal ChatGPT conversation; Actions remain a Custom GPT fallback.

### Secure MCP Tunnel

Keep the service on stdio and let [OpenAI's tunnel-client](https://github.com/openai/tunnel-client) launch:

```bash
node /absolute/path/to/mcp-local-editor/src/cli.js serve --profile read
```

Register that tunnel connection as a custom app in ChatGPT developer mode. Use `--profile full` only when that ChatGPT workspace is allowed to modify files.

### Direct HTTPS MCP with OAuth

`mcp-local-editor-mcp` is a dependency-free Streamable HTTP endpoint at `/mcp`. It implements authorization-code OAuth with PKCE S256, dynamic client registration, rotating refresh tokens, hashed persisted tokens, owner-token approval, and Host/Origin checks. The remote profile is `read` unless you pass `--profile full`.

```bash
umask 077
openssl rand -hex 32 > .mcp-local-editor-token
chmod 600 .mcp-local-editor-token
```

Expose `127.0.0.1:8790` through a stable HTTPS reverse proxy. For a temporary Cloudflare route, start the tunnel first, copy the origin, then start the server. Do not put `/mcp` on `--public-url`.

```bash
cloudflared tunnel --url http://127.0.0.1:8790

mcp-local-editor-mcp \
  --host 127.0.0.1 \
  --port 8790 \
  --public-url https://example.trycloudflare.com \
  --owner-token-file .mcp-local-editor-token \
  --profile read
```

In ChatGPT:

```text
MCP URL: https://example.trycloudflare.com/mcp
Authentication: OAuth
```

Enter the local owner token on the approval page. The token is checked on this machine and is never returned to ChatGPT.

Access and refresh tokens are bound to the configured resource URL. If a temporary hostname changes, restart with the new `--public-url` and authorize again. OAuth state defaults to `<registry-path>.oauth.json` and stores client metadata plus SHA-256 hashes of tokens.

Unauthenticated mode needs both `--auth none` and `--allow-unauthenticated`. Do not expose that combination to the public internet.

Setup and troubleshooting: [docs/chatgpt-mcp.md](docs/chatgpt-mcp.md).

### Actions fallback

```bash
umask 077
openssl rand -hex 32 > .mcp-local-editor-token

mcp-local-editor-actions \
  --token-file .mcp-local-editor-token \
  --host 127.0.0.1 \
  --port 8787
```

Expose port `8787` over HTTPS and import `/openapi.json` into a Custom GPT Action. Prefer the MCP custom-app path for ordinary ChatGPT conversations. Details: [docs/chatgpt-actions.md](docs/chatgpt-actions.md).

## macOS menu bar

A small menu-bar app can keep the Secure MCP Tunnel running and add folders through Finder. The current UI is Korean: **터널 켜기** / **터널 끄기**, optional start at login, and a local status page at `http://127.0.0.1:8791/`.

```bash
chmod +x macos/keep-tunnel.sh macos/install-gui.sh
./macos/install-gui.sh
```

The installer writes `~/.config/tunnel-client/local-read.env` if it is missing. Put the runtime key and `org-` id there, stop any foreground `tunnel-client run` so port 8080 is free, then open **Local Editor** from Applications and choose **터널 켜기**.

The status page is also available without the menu bar:

```bash
mcp-local-editor dashboard
```

## Command allowlist

Commands are configured per workspace. The model normally sends only a `command_id`. If that workspace sets `allowUnlistedArgv` to `true`, `command_run` may also take an `argv` array. A single shell string is still rejected. The process always starts in the workspace root.

```json
{
  "allowUnlistedArgv": false,
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

See [commands.example.json](commands.example.json). Commands run with `shell: false`, a restricted environment, a timeout, output limits, and process-group termination on timeout. The file is validated at registration, loaded when a session opens, and reloaded immediately before every `command_run`.

## Safety

This is a workspace guard, not an operating-system sandbox.

It enforces:

- only registered workspace ids can be opened
- model-supplied absolute paths are rejected
- lexical and symlink escapes are rejected
- edits need a current SHA-256 and an unambiguous exact-text match
- file writes use a temporary file and an atomic rename
- read sessions cannot edit or run commands
- the read profile omits write tools and forces read access on the server
- only operator-configured argv arrays can run, unless a workspace opts into unlisted argv
- Git operations are read-only
- concurrent workspace sessions stay isolated
- direct remote MCP requires OAuth by default
- OAuth tokens are stored only as hashes, with atomic writes, a file lock, and rate limits on owner-token and client-registration attempts
- Actions use a separate bearer token

It does not provide Docker or VM isolation, a network sandbox, an arbitrary shell, file create/delete/move, Git commit/push, automated tunnel management, or an autonomous agent loop.

Keep the owner token private. Do not commit the registry, OAuth state, command policy, or token files.

## Development

```bash
npm run check
```

CI runs that suite on Node.js 20 and 22. Tests cover registry persistence and locking, workspace replacement and removal, path confinement, stale edits, read/write access, session expiry and revocation, concurrent isolation, stdio MCP, remote MCP, OAuth PKCE, refresh rotation, revocation, persisted bearer validation, OpenAPI generation, Actions dispatch, and the local dashboard.
