# MCP Local Editor

<p align="center">
  <strong>English</strong> · <a href="https://github.com/junjunjunbong/mcp-local-editor/blob/main/README.ko.md">한국어</a>
</p>

**Use ChatGPT Web like a local coding agent.** ChatGPT does the reasoning; MCP Local Editor gives it guarded access to search, read, edit, test, and review files on your computer.

[![npm](https://img.shields.io/npm/v/mcp-local-editor)](https://www.npmjs.com/package/mcp-local-editor)
[![CI](https://github.com/junjunjunbong/mcp-local-editor/actions/workflows/ci.yml/badge.svg)](https://github.com/junjunjunbong/mcp-local-editor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

No OpenAI API key. No second model. No model calls from this package. You keep using your existing ChatGPT account in an ordinary web conversation while the local bridge performs only the operations you expose.

> MCP Local Editor does **not** bypass ChatGPT limits. Your ChatGPT plan, model availability, usage limits, and workspace policies still apply. This is an independent open-source project and is not affiliated with or endorsed by OpenAI.

## One-command ChatGPT setup

Requirements: Node.js 20+, `cloudflared`, Git, and [ripgrep](https://github.com/BurntSushi/ripgrep). On macOS with Homebrew:

```bash
brew install node cloudflared ripgrep
```

Then point MCP Local Editor at a folder:

```bash
npx mcp-local-editor@latest setup-chatgpt /absolute/path/to/your/project
```

The command registers the folder, creates a private owner token, starts an OAuth MCP server, opens a temporary HTTPS tunnel, and prints one `MCP URL`.

In ChatGPT Web:

1. Open **Settings → Security and login** and enable **Developer mode**.
2. Open [ChatGPT Plugins](https://chatgpt.com/plugins), select **+**, and create a developer-mode app.
3. Paste the printed MCP URL and select **OAuth**.
4. When the local approval page opens, paste the token stored at the printed owner-token path.
5. In a chat, choose **Developer mode** from the plus menu and enable the app.

Keep the terminal command running while you use the app. The quick-tunnel hostname is temporary; after a restart, reconnect the app with the newly printed URL. See the [complete ChatGPT setup guide](docs/chatgpt-mcp.md) for stable-hostname and manual options.

OpenAI currently documents ChatGPT developer mode as supporting remote streaming HTTP MCP servers, OAuth, and read/write tools for eligible web accounts. Write actions normally require confirmation. Review the current [official developer-mode guide](https://developers.openai.com/api/docs/guides/developer-mode) before enabling write access.

## What makes it different

```text
ordinary ChatGPT Web conversation
              │ reasoning + tool calls
              ▼
     OAuth MCP over HTTPS
              │
              ▼
 MCP Local Editor on your machine
              │ registered workspace only
              ▼
 search · read · edit · test · git diff
```

- **ChatGPT stays the agent.** The package is a local tool bridge, not another LLM wrapper.
- **No API billing layer.** The bridge never calls an AI API; it uses the ChatGPT conversation you already opened.
- **Local files really change.** Edits use exact text plus a current file hash, and tests run as argv arrays rather than shell strings.
- **The whole disk is not exposed.** ChatGPT sees registered workspace ids, not arbitrary absolute paths.
- **Read-only is a real server profile.** Write tools disappear from tool discovery and cannot be enabled by changing a tool argument.
- **Useful outside ChatGPT too.** The same core works over stdio MCP and an authenticated Actions adapter.

## Example workflow

Ask ChatGPT:

```text
Use MCP Local Editor only. Open the my-project workspace with write access.
Find where the homepage button label is defined, change it from “Start” to
“Ship it”, run the available test command, and review the Git diff.
```

The intended tool sequence is:

```text
workspace_list
→ workspace_open({ workspace_id: "my-project", access: "write" })
→ repo_search / file_read
→ file_edit with expected_sha256
→ command_run
→ git_diff
```

A tiny recording fixture and a copy-ready walkthrough live in [examples/demo-project](examples/demo-project).

## Tools and profiles

| Tool | `read` | `full` | Purpose |
| --- | :---: | :---: | --- |
| `workspace_list` | yes | yes | List registered workspace ids and availability |
| `workspace_open` | read only | read or write | Create a short-lived workspace-bound session |
| `repo_search` | yes | yes | Search with ripgrep inside the workspace |
| `file_read` | yes | yes | Read bounded UTF-8 text and return SHA-256 |
| `git_diff` | yes | yes | Inspect status and diffs without Git writes |
| `file_edit` | — | write session | Apply exact-text replacements with hash checking |
| `command_run` | — | write session | Run configured argv, or opt-in unlisted argv |

`setup-chatgpt` defaults to `full` so the first experience can edit and verify code. Start with read-only access instead when you are evaluating the project:

```bash
npx mcp-local-editor@latest setup-chatgpt /absolute/path/to/project --profile read
```

## Workspace and command policy

Registrations are stored in the user config directory on new installs:

```text
~/.config/mcp-local-editor/workspaces.json
```

Override it with `--registry`, `MCP_LOCAL_EDITOR_REGISTRY`, `MCP_LOCAL_EDITOR_HOME`, or `XDG_CONFIG_HOME`. Existing source checkouts that already contain `workspaces.local.json` continue using that file for backward compatibility.

Register and inspect folders manually:

```bash
mcp-local-editor workspace add \
  my-project \
  /absolute/path/to/my-project \
  --display-name "My Project" \
  --commands commands.local.json

mcp-local-editor workspace list
mcp-local-editor workspace remove my-project
```

Commands are configured per workspace. The process starts inside the workspace root and uses `shell: false`.

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

See [commands.example.json](commands.example.json). Setting `allowUnlistedArgv` to `true` lets the client provide an argv array, but a shell command string is always rejected.

## Other connection modes

| Transport | Command | Typical client |
| --- | --- | --- |
| ChatGPT quick setup | `mcp-local-editor setup-chatgpt <root>` | Ordinary ChatGPT Web conversations |
| stdio MCP | `mcp-local-editor serve` | Local MCP hosts |
| Streamable HTTP MCP | `mcp-local-editor-mcp` | Stable remote ChatGPT app deployment |
| Authenticated Actions | `mcp-local-editor-actions` | Existing Custom GPT Actions |

### Local stdio MCP

```bash
mcp-local-editor serve --profile full
```

Example client configuration after installing the package globally:

```json
{
  "mcpServers": {
    "local-editor": {
      "command": "mcp-local-editor",
      "args": ["serve", "--profile", "full"]
    }
  }
}
```

### Stable HTTPS MCP

For a named tunnel or your own HTTPS reverse proxy, use `mcp-local-editor-mcp` directly. It implements OAuth authorization code with PKCE S256, dynamic client registration, rotating refresh tokens, hashed persisted tokens, owner-token approval, and Host/Origin checks. Follow [docs/chatgpt-mcp.md](docs/chatgpt-mcp.md).

### Custom GPT Actions fallback

The Actions adapter exposes the same service through a generated OpenAPI document and bearer authentication. Follow [docs/chatgpt-actions.md](docs/chatgpt-actions.md).

### macOS menu bar

The repository also includes a Korean menu-bar helper for the OpenAI Secure MCP Tunnel and the local dashboard. This path is intended for source-checkout users:

```bash
git clone https://github.com/junjunjunbong/mcp-local-editor.git
cd mcp-local-editor
chmod +x macos/keep-tunnel.sh macos/install-gui.sh
./macos/install-gui.sh
```

## Safety boundaries

MCP Local Editor is a workspace guard, not an operating-system sandbox.

It enforces:

- registered workspace ids only
- rejection of absolute, lexical escape, and symlink escape paths
- short-lived, workspace-bound read or write sessions
- current SHA-256 plus unambiguous exact-text matching for edits
- temporary-file writes followed by atomic rename
- read-only Git inspection; no commit or push tool
- command argv policies, timeouts, output limits, and process termination
- OAuth by default for remote MCP
- hashed persisted OAuth tokens and private local state files

It does **not** provide Docker/VM isolation, network isolation, an arbitrary shell string, file create/delete/move tools, Git commit/push, or a fully autonomous background loop. Register only folders and commands you trust. Review ChatGPT's write confirmations and the resulting Git diff.

## Development

```bash
git clone https://github.com/junjunjunbong/mcp-local-editor.git
cd mcp-local-editor
npm install
npm run check
npm link
```

The package has no runtime dependencies. CI tests Node.js 20 and 22. The suite covers path confinement, registry locking, session isolation, read/write enforcement, stale edits, command execution, stdio MCP, Streamable HTTP MCP, OAuth PKCE, token rotation and revocation, Actions, the dashboard, tunnel recovery, and the one-command ChatGPT setup.

## License

[MIT](LICENSE) © 2026 [junjunjunbong](https://github.com/junjunjunbong)
