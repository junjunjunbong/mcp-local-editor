#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
TUNNEL="$(command -v tunnel-client || true)"
CONFIG_DIR="${HOME}/.config/mcp-local-editor"
TUNNEL_DIR="${HOME}/.config/tunnel-client"
AGENT_DIR="${HOME}/Library/LaunchAgents"
LOG_DIR="${HOME}/Library/Logs"
APP_DIR="${HOME}/Applications/Local Editor.app"
LABEL="com.mcp-local-editor.tunnel"
PLIST="${AGENT_DIR}/${LABEL}.plist"
ENV_FILE="${TUNNEL_DIR}/local-read.env"

if [[ -z "${NODE}" ]]; then
  echo "node가 PATH에 없습니다." >&2
  exit 1
fi
if [[ -z "${TUNNEL}" ]]; then
  echo "tunnel-client가 PATH에 없습니다. brew install openai/tools/tunnel-client" >&2
  exit 1
fi

mkdir -p "${CONFIG_DIR}" "${TUNNEL_DIR}" "${AGENT_DIR}" "${LOG_DIR}" "${APP_DIR}/Contents/MacOS"

cat > "${CONFIG_DIR}/gui.json" <<EOF
{
  "node": "${NODE}",
  "cli": "${ROOT}/src/cli.js",
  "registry": "${ROOT}/workspaces.local.json",
  "agentLabel": "${LABEL}",
  "agentPlist": "${PLIST}",
  "healthURL": "http://127.0.0.1:8080/readyz",
  "uiURL": "http://127.0.0.1:8791/",
  "dashboardHealthURL": "http://127.0.0.1:8791/healthz",
  "chatgptURL": "https://chatgpt.com/#settings/Connectors"
}
EOF
chmod 600 "${CONFIG_DIR}/gui.json"

if [[ ! -f "${ENV_FILE}" ]]; then
  cat > "${ENV_FILE}" <<'EOF'
# Fill these in. Do not commit this file.
export CONTROL_PLANE_API_KEY=""
export CONTROL_PLANE_ORGANIZATION_ID=""
EOF
  chmod 600 "${ENV_FILE}"
  echo "Created ${ENV_FILE} — runtime 키와 org- 값을 넣으세요."
fi

cat > "${PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${ROOT}/macos/keep-tunnel.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/mcp-local-editor-tunnel.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/mcp-local-editor-tunnel.log</string>
</dict>
</plist>
EOF

cat > "${APP_DIR}/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Local Editor</string>
  <key>CFBundleIdentifier</key>
  <string>com.mcp-local-editor.bar</string>
  <key>CFBundleExecutable</key>
  <string>LocalEditorBar</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSUIElement</key>
  <true/>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
</dict>
</plist>
EOF

swiftc -O -o "${APP_DIR}/Contents/MacOS/LocalEditorBar" "${ROOT}/macos/LocalEditorBar.swift"
chmod +x "${ROOT}/macos/keep-tunnel.sh"

echo "Installed:"
echo "  app     ${APP_DIR}"
echo "  agent   ${PLIST}"
echo "  config  ${CONFIG_DIR}/gui.json"
echo "  env     ${ENV_FILE}"
echo
echo "Next:"
echo "  1. Fill ${ENV_FILE} if it is still empty"
echo "  2. Stop any foreground 'tunnel-client run' first (port 8080)"
echo "  3. open \"${APP_DIR}\""
echo "  4. Menu: 터널 켜기, then 파인더에서 폴더 추가"
