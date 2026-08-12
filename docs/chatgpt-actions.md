# Connect mcp-local-editor to ChatGPT web with Actions

The Actions adapter exposes the same `LocalEditorService` used by the stdio MCP server through a small authenticated HTTP API.

```text
ChatGPT Custom GPT
        │ HTTPS + Bearer token
        ▼
Cloudflare Tunnel or another HTTPS tunnel
        │
        ▼
127.0.0.1:8787
        │
        ▼
registered local workspaces
```

It does not run Codex, OpenCodex, or another model. ChatGPT supplies the reasoning loop and calls the local tools.

## Security model

- The HTTP server binds to `127.0.0.1` by default.
- Every action endpoint requires one bearer token.
- `/healthz` and `/openapi.json` are intentionally public and contain no local paths or secrets.
- The model can select only workspace ids registered by the operator.
- Workspace sessions, SHA-256 edit guards, command allowlists, and path confinement are identical to the stdio MCP path.
- Exposing the server through a tunnel makes the action endpoint Internet-reachable. Anyone who obtains the bearer token can use the registered workspace permissions, so keep the token private.

This remains a workspace guard rather than an operating-system sandbox. Register only trusted repositories and command allowlists.

## 1. Register workspaces

Register each local folder once:

```bash
npm link

mcp-local-editor workspace add \
  mcp-local-editor \
  /Users/junwon/Projects/mcp-local-editor \
  --display-name "MCP Local Editor" \
  --commands commands.local.json
```

The default registry is the Git-ignored `workspaces.local.json` next to this package.

## 2. Create a bearer token

The server requires a token of at least 32 characters. A local token file avoids putting the secret in shell history or the process list.

```bash
cd /Users/junwon/Projects/mcp-local-editor
umask 077
openssl rand -hex 32 > .mcp-local-editor-token
```

The default `.gitignore` excludes `.mcp-local-editor-token`.

An environment variable is also supported:

```bash
export MCP_LOCAL_EDITOR_ACTIONS_TOKEN="$(openssl rand -hex 32)"
```

Do not pass a token as a command-line argument. The CLI rejects `--token` because command-line secrets can be visible in process listings.

## 3. Start the local Actions server

```bash
mcp-local-editor-actions \
  --token-file .mcp-local-editor-token \
  --host 127.0.0.1 \
  --port 8787
```

Useful local checks:

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/openapi.json
```

Test an authenticated action:

```bash
TOKEN="$(cat .mcp-local-editor-token)"

curl \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' \
  http://127.0.0.1:8787/actions/workspaces/list
```

## 4. Expose it through HTTPS

ChatGPT web must reach a public HTTPS endpoint. For a development test, Cloudflare Quick Tunnel can expose the loopback server:

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

It prints a temporary origin such as:

```text
https://random-words.trycloudflare.com
```

Verify the public schema:

```bash
curl https://random-words.trycloudflare.com/openapi.json
```

The server derives the OpenAPI `servers` URL from the forwarded HTTPS host, so a Quick Tunnel does not require restarting `mcp-local-editor` with a public URL.

Quick Tunnel URLs change when the tunnel restarts. They are appropriate for testing only. For regular use, configure a named tunnel with a stable hostname and start the server with the stable origin:

```bash
mcp-local-editor-actions \
  --token-file .mcp-local-editor-token \
  --public-url https://local-editor.example.com
```

Cloudflare documents Quick Tunnels and stable published application routes at:

- https://developers.cloudflare.com/tunnel/setup/
- https://developers.cloudflare.com/tunnel/routing/

## 5. Create the Custom GPT Action

In the ChatGPT GPT editor:

1. Open **Actions** and choose **Create new action**.
2. Import the schema URL, for example `https://random-words.trycloudflare.com/openapi.json`.
3. Set authentication to **API key**.
4. Select **Bearer** authentication.
5. Paste the exact token stored in `.mcp-local-editor-token`.
6. Test `listWorkspaces` in Preview.
7. Keep the GPT private while testing.

OpenAI's current Actions setup guide is:

- https://help.openai.com/en/articles/9442513

At the time this document was written, a GPT can use Actions or Apps but not both, and custom Actions are not available in Pro mode. The GPT editor therefore offers only non-Pro models that support Actions.

## Recommended GPT instructions

```text
You can edit only operator-registered local workspaces through the Local Editor actions.

Repository selection:
1. Call listWorkspaces before beginning local repository work.
2. Select only a returned workspace_id. Never invent or request an absolute local path.
3. Call openWorkspace and state which workspace was selected.
4. Use access="read" unless the user asks to edit a file or run an allowlisted command.
5. Do not switch workspaces during a task unless the user explicitly requests it.

Editing:
1. Call readFile before editFile.
2. Pass the exact sha256 returned by readFile.
3. Use narrow, unambiguous exact-text replacements.
4. If editFile reports STALE_FILE, read the file again before retrying.
5. After every edit, call reviewGitDiff and inspect the resulting diff.

Verification:
1. Run only command ids returned by openWorkspace.
2. Use runCommand only when the requested change needs verification.
3. Never claim a test passed unless runCommand returned exit_code 0.
4. Do not claim a file changed until editFile succeeded and reviewGitDiff confirms it.
```

## HTTP endpoints

| Method | Path | Action |
|---|---|---|
| `GET` | `/healthz` | unauthenticated readiness check |
| `GET` | `/openapi.json` | generated OpenAPI 3.1 schema |
| `POST` | `/actions/workspaces/list` | `workspace_list` |
| `POST` | `/actions/workspaces/open` | `workspace_open` |
| `POST` | `/actions/repository/search` | `repo_search` |
| `POST` | `/actions/files/read` | `file_read` |
| `POST` | `/actions/files/edit` | `file_edit` |
| `POST` | `/actions/commands/run` | `command_run` |
| `POST` | `/actions/git/diff` | `git_diff` |

All `POST` endpoints require `Authorization: Bearer <token>` and an `application/json` object body.
