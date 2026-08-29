# Demo project

This tiny fixture is intentionally one edit away from passing its verification command. It is designed for a short screen recording of ChatGPT Web editing a local file.

## Prepare a disposable copy

```bash
cp -R examples/demo-project /tmp/mcp-local-editor-demo
git -C /tmp/mcp-local-editor-demo init
git -C /tmp/mcp-local-editor-demo add .
git -C /tmp/mcp-local-editor-demo \
  -c user.name=demo -c user.email=demo@example.com \
  commit -m "Initial demo"
npx mcp-local-editor@latest setup-chatgpt \
  /tmp/mcp-local-editor-demo \
  --display-name "MCP Local Editor Demo" \
  --commands commands.json
```

Register the printed MCP URL in ChatGPT, then paste this prompt:

```text
Use MCP Local Editor only. Open the mcp-local-editor-demo workspace with write
access. Find the call-to-action button, change its label from "Start" to
"Ship it", run the available verification command, and review the Git diff.
```

The initial verification fails. It passes after `index.html` contains the new button label.
