# Connect MCP Local Editor to ChatGPT Web

This guide connects a local folder to an ordinary ChatGPT Web conversation through a developer-mode MCP app. ChatGPT supplies the model and reasoning loop; MCP Local Editor supplies bounded local tools.

The bridge does not call the OpenAI API, but it does not remove or bypass ChatGPT limits. Plan eligibility, model availability, usage limits, workspace policies, and confirmation behavior remain controlled by ChatGPT.

## Fast route: temporary quick tunnel

Install the prerequisites. On macOS:

```bash
brew install node cloudflared ripgrep
```

Git is also required for `git_diff`. Then run:

```bash
npx mcp-local-editor@latest setup-chatgpt /absolute/path/to/project
```

To expose a command policy stored inside the project:

```bash
npx mcp-local-editor@latest setup-chatgpt \
  /absolute/path/to/project \
  --commands commands.local.json
```

The setup command:

1. registers or reuses the folder as a workspace;
2. creates a private owner-token file if one does not exist;
3. launches a Cloudflare Quick Tunnel to a loopback-only MCP server;
4. starts Streamable HTTP MCP with OAuth and the `full` tool profile;
5. prints the MCP URL and local token path without printing the token itself.

Use `--profile read` if ChatGPT should only search, read, and inspect Git diffs.

## Create the app in ChatGPT

OpenAI's current developer-mode flow is:

1. In ChatGPT Web, open **Settings → Security and login** and enable **Developer mode**.
2. Open [ChatGPT Plugins](https://chatgpt.com/plugins).
3. Select **+** and create a developer-mode app.
4. Paste the `MCP URL` printed by the terminal.
5. Select **OAuth** authentication.
6. When the local approval page opens, read the printed owner-token file and paste its value.
7. Start a normal conversation, choose **Developer mode** from the plus menu, and enable the app.

OpenAI documents the current eligibility, UI, protocol, and confirmation behavior in the [ChatGPT developer-mode guide](https://developers.openai.com/api/docs/guides/developer-mode). Availability can change, so treat that page as authoritative.

A useful first prompt is:

```text
Use MCP Local Editor only. List the registered workspaces, open my-project,
read its README, and show the current Git diff.
```

For an edit:

```text
Use MCP Local Editor only. Open my-project with write access. Make the requested
change, run the available test command, and inspect the Git diff. Do not claim
success unless the command exits with code 0 and the diff confirms the edit.
```

Keep `setup-chatgpt` running while the app is in use. Press `Ctrl-C` to stop both the MCP server and tunnel.

## Temporary URL behavior

Cloudflare Quick Tunnel hostnames change when the process restarts. OAuth access and refresh tokens are bound to the MCP resource URL. After a restart:

1. copy the new printed MCP URL;
2. update or recreate the developer-mode app;
3. complete OAuth approval again.

Use a fixed hostname or OpenAI's [Secure MCP Tunnel](https://github.com/openai/tunnel-client) for a durable connection.

## Tool profiles

| Profile | Tools | Intended use |
| --- | --- | --- |
| `read` | workspace list/open, search, read, Git diff | Evaluation and review-only access |
| `full` | all seven tools, including edit and command execution | Local coding work with write confirmations |

Read-only mode is enforced by the server: write tools are omitted from discovery, `workspace_open` cannot request write access, and every opened session is forced to read access. A client cannot upgrade it by changing arguments.

The `full` profile still requires `workspace_open` with `access: "write"` before `file_edit` or `command_run` succeeds.

## Local state

For a new npm installation, the default state is under:

```text
~/.config/mcp-local-editor/workspaces.json
~/.config/mcp-local-editor/workspaces.json.oauth.json
~/.config/mcp-local-editor/.mcp-local-editor-owner-token
```

The registry and OAuth files are mode `0600` on POSIX systems. OAuth access and refresh tokens are stored only as SHA-256 hashes. Override paths with:

```text
MCP_LOCAL_EDITOR_REGISTRY
MCP_LOCAL_EDITOR_HOME
XDG_CONFIG_HOME
MCP_LOCAL_EDITOR_OWNER_TOKEN_FILE
MCP_LOCAL_EDITOR_OAUTH_STORE
```

Source checkouts with an existing `workspaces.local.json` keep using it for backward compatibility.

## Stable route: direct HTTPS MCP

Install the CLI globally so all package binaries are available:

```bash
npm install --global mcp-local-editor@latest
```

Register a workspace:

```bash
mcp-local-editor workspace add \
  my-project \
  /absolute/path/to/project \
  --display-name "My Project" \
  --commands commands.local.json
```

Create a private owner token:

```bash
umask 077
openssl rand -hex 32 > ~/.config/mcp-local-editor/.mcp-local-editor-owner-token
chmod 600 ~/.config/mcp-local-editor/.mcp-local-editor-owner-token
```

Expose `127.0.0.1:8790` through a stable HTTPS reverse proxy, then start the server. `--public-url` is the public origin without `/mcp`.

```bash
mcp-local-editor-mcp \
  --host 127.0.0.1 \
  --port 8790 \
  --public-url https://editor.example.com \
  --owner-token-file ~/.config/mcp-local-editor/.mcp-local-editor-owner-token \
  --profile full
```

Register this app in ChatGPT:

```text
MCP URL: https://editor.example.com/mcp
Authentication: OAuth
```

Verify the deployment before connecting ChatGPT:

```bash
curl -sS https://editor.example.com/healthz
curl -sS https://editor.example.com/.well-known/oauth-protected-resource/mcp
curl -sS https://editor.example.com/.well-known/oauth-authorization-server
```

An unauthenticated call to `/mcp` should return `401 Unauthorized` with a `WWW-Authenticate` header.

## OAuth behavior

The bundled server implements a single-owner OAuth authorization-code flow with:

- PKCE S256 on every authorization
- one-time, five-minute authorization codes
- dynamic client registration
- rotating refresh tokens and bearer-token revocation
- strict redirect URI validation
- Host and Origin validation
- bounded requests and rate limits
- process-safe, atomic OAuth state writes
- hashed persisted access and refresh tokens

The owner token is checked by the local approval page and is not returned to ChatGPT. This is designed for one trusted local operator, not as a general multi-tenant identity provider.

Unauthenticated mode requires both flags below and must not be exposed directly to the public internet:

```bash
mcp-local-editor-mcp \
  --auth none \
  --allow-unauthenticated \
  --public-url http://127.0.0.1:8790
```

## Troubleshooting

### `CLOUDFLARED_NOT_FOUND`

Install `cloudflared`, confirm `cloudflared --version` works, and rerun the setup command. A nonstandard executable can be selected with `--cloudflared /absolute/path/to/cloudflared`.

### Port 8790 is already in use

Choose another local port:

```bash
npx mcp-local-editor@latest setup-chatgpt /absolute/path/to/project --port 8890
```

### Authorization metadata is missing

Confirm the app URL ends in `/mcp`, the terminal process is still running, and the quick-tunnel URL has not changed. Check the two `/.well-known/` endpoints shown above.

### The approval page opens but callback validation fails

Current ChatGPT callbacks should be accepted automatically. For another HTTPS callback host on the manual server, repeat `--redirect-host hostname.example` as needed.

### Edit tools are absent

The server is probably running with `--profile read`, or the ChatGPT account/workspace does not allow modify tools. Restart with `--profile full`, then refresh the app's tools. Follow the official ChatGPT documentation for account-side availability.

### A workspace session expired

Sessions default to 30 minutes and live only in memory. Ask ChatGPT to open the workspace again, or use `--session-ttl-sec 3600`.

### The tunnel restarts and authentication stops working

Quick-tunnel hostnames are temporary and tokens are resource-bound. Reconnect with the new URL or use a stable hostname.

## Other routes

- For local MCP hosts, run `mcp-local-editor serve` over stdio.
- For OpenAI Secure MCP Tunnel, configure it to launch `mcp-local-editor serve --profile read` or `--profile full`.
- For an existing Custom GPT Actions workflow, follow [chatgpt-actions.md](chatgpt-actions.md).
