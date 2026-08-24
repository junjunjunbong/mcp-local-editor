#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/bin:${HOME}/.hermes/node/bin:/usr/bin:/bin:${PATH}"

if ! curl -sf "http://127.0.0.1:8791/healthz" >/dev/null; then
  nohup node "${ROOT}/src/cli.js" dashboard --host 127.0.0.1 --port 8791 \
    >> "${HOME}/Library/Logs/mcp-local-editor-dashboard.log" 2>&1 &
fi

ENV_FILE="${HOME}/.config/tunnel-client/local-read.env"
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

if [[ -z "${CONTROL_PLANE_API_KEY:-}" ]]; then
  echo "CONTROL_PLANE_API_KEY is missing. Put it in ${ENV_FILE}" >&2
  exit 1
fi

exec tunnel-client run --profile local-read
