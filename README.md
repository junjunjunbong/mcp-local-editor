# mcp-local-editor

A small local editing service that lets an MCP client or a ChatGPT Custom GPT work inside **operator-registered local repositories**.

The server does not run Codex, OpenCodex, an external model provider, or an API model. The client supplies the reasoning loop. The same constrained service is available through:

- stdio MCP with `mcp-local-editor serve`
- authenticated HTTP Actions with `mcp-local-editor-actions`

The service exposes seven tools:

- `workspace_list`
- `workspace_open`
- `repo_search`
- `file_read`
- `file_edit`
- `command_run`
- `git_diff`

## Switch repositories without restarting

The server stores a persistent allowlist of workspaces and issues a short-lived session for the selected workspace.

```text
one long-running local editor
        │
        ├─ mcp-local-editor
        ├─ ai-research-harness
        └─ stay-probe

conversation A → session A → mcp-local-editor
conversation B → session B → ai-research-harness
```

A model never provides an absolute local path. It can select only an id registered by the operator.

## Requirements

- Node.js 20 or newer
- Git for `git_diff`
- ripgrep (`rg`) for `repo_search`
- a public HTTPS tunnel only when connecting ChatGPT web Actions

There are no npm runtime dependencies.

## Register workspaces

A folder is registered once. It can remain anywhere on the computer and does not need to live inside this repository.

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

List or remove registrations:

```bash
mcp-local-editor workspace list
mcp-local-editor workspace list --json
mcp-local-editor workspace remove ai-research-harness
```

Update a moved folder while preserving omitted metadata:

```bash
mcp-local-editor workspace add \
  ai-research-harness \
  /new/path/ai-research-harness \
  --replace
```

Use `--replace --no-commands` to remove an inherited command configuration.

The default registry is stored next to this package, in the Git-ignored local file:

```text
workspaces.local.json
```

For a checkout at `/Users/junwon/Projects/mcp-local-editor`, the file is:

```text
/Users/junwon/Projects/mcp-local-editor/workspaces.local.json
```

The file is local machine state and is already excluded by `.gitignore`. Keep `workspaces.example.json` in Git as the shareable format example.

Override it with `--registry`, `MCP_LOCAL_EDITOR_REGISTRY`, `MCP_LOCAL_EDITOR_HOME`, or `XDG_CONFIG_HOME`.

## Start the stdio MCP server

```bash
mcp-local-editor serve
```

The default session lifetime is 30 minutes. It can be configured between 60 and 3600 seconds:

```bash
mcp-local-editor serve --session-ttl-sec 1800
```

Sessions are in memory and disappear when the process stops. Workspace registrations remain on disk. `workspace_list` and `workspace_open` reload the registry, so a folder added from another terminal becomes available without restarting the server.

Example stdio client configuration:

```json
{
  "mcpServers": {
    "local-editor": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-local-editor/src/cli.js",
        "serve"
      ]
    }
  }
}
```

## Connect ChatGPT web with Actions

Start the authenticated local HTTP adapter with a bearer token:

```bash
umask 077
openssl rand -hex 32 > .mcp-local-editor-token

mcp-local-editor-actions \
  --token-file .mcp-local-editor-token \
  --host 127.0.0.1 \
  --port 8787
```

Then expose `http://127.0.0.1:8787` through an HTTPS tunnel and import the public `/openapi.json` URL in a Custom GPT Action. Full setup, tunnel guidance, authentication, and recommended GPT instructions are in [docs/chatgpt-actions.md](docs/chatgpt-actions.md).

The HTTP adapter:

- reuses the same workspace registry, session manager, edit guards, and command policy as stdio MCP
- requires `Authorization: Bearer <token>` on every action endpoint
- exposes only `/healthz` and `/openapi.json` without authentication
- binds to loopback by default
- accepts JSON request bodies up to 1 MiB

## Normal tool flow

```text
workspace_list()
workspace_open({workspace_id: "mcp-local-editor", access: "write"})
file_read({session_id: "ses_...", path: "README.md"})
file_edit({session_id: "ses_...", path: "README.md", expected_sha256: "...", replacements: [...]})
command_run({session_id: "ses_...", command_id: "test"})
git_diff({session_id: "ses_..."})
```

A read session may search, read, and inspect Git diffs. `file_edit` and `command_run` require a write session. If a workspace registration is removed or replaced, existing sessions for it are revoked on their next tool call.

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
- only operator-configured argv arrays can run
- Git operations are read-only
- concurrent sessions remain bound to their own workspaces
- HTTP action calls require a bearer token

It does not provide Docker, VM, network isolation, arbitrary shell access, file create/delete/move, Git commit/push, OAuth, automated tunnel management, HTTP MCP, or an autonomous agent loop.

## Development

```bash
npm run check
```

The test suite covers registry persistence and locking, workspace replacement/removal, path confinement, stale edits, read/write access, session expiry and revocation, concurrent workspace isolation, per-workspace command isolation, MCP round trips, workspace CLI behavior, OpenAPI generation, bearer authentication, HTTP error mapping, body limits, and Actions route dispatch.
