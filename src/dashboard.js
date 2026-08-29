import { execFile as execFileCallback } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import { asToolError, ToolError } from "./errors.js";
import { errorBody, isLoopbackHostname, readJson, sendHtml, sendJson, sendText, statusForToolError } from "./http-utils.js";

const execFile = promisify(execFileCallback);

export const DASHBOARD_DEFAULTS = {
  host: "127.0.0.1",
  port: 8791,
  tunnelReadyz: "http://127.0.0.1:8080/readyz",
  tunnelUi: "http://127.0.0.1:8080/ui"
};

export async function pickFolderWithOsascript(run = execFile) {
  try {
    const { stdout } = await run("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "ChatGPT에 보여줄 폴더")'
    ], { encoding: "utf8" });
    const picked = stdout.trim().replace(/\/$/, "");
    if (!picked) throw new ToolError("FOLDER_PICK_CANCELLED", "folder picker returned an empty path");
    return picked;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if (error?.code === 1 || /(-128|User canceled)/i.test(String(error?.stderr || error?.message || ""))) {
      throw new ToolError("FOLDER_PICK_CANCELLED", "folder picker was cancelled");
    }
    throw new ToolError("FOLDER_PICK_FAILED", "could not open the Finder folder picker", { cause: String(error) });
  }
}

function publicEntry(entry) {
  return {
    workspace_id: entry.id,
    display_name: entry.displayName,
    root: entry.root,
    commands_config: entry.commandsConfig
  };
}

export class DashboardServer {
  constructor(registry, options = {}) {
    this.registry = registry;
    this.host = options.host ?? DASHBOARD_DEFAULTS.host;
    this.port = options.port ?? DASHBOARD_DEFAULTS.port;
    this.tunnelReadyz = options.tunnelReadyz ?? DASHBOARD_DEFAULTS.tunnelReadyz;
    this.tunnelUi = options.tunnelUi ?? DASHBOARD_DEFAULTS.tunnelUi;
    this.pickFolder = options.pickFolder ?? pickFolderWithOsascript;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.watchdog = options.watchdog ?? null;
    this.server = null;
  }

  async tunnelStatus() {
    try {
      const response = await this.fetchImpl(this.tunnelReadyz, { signal: AbortSignal.timeout(1200) });
      const text = (await response.text()).trim();
      return { ready: response.ok && text.includes("ready"), detail: text || `HTTP ${response.status}` };
    } catch (error) {
      return { ready: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async state() {
    const [tunnel, workspaces] = await Promise.all([this.tunnelStatus(), this.registry.list()]);
    return {
      ok: true,
      tunnel,
      tunnel_ui: this.tunnelUi,
      registry: this.registry.filePath,
      workspaces: workspaces.map(publicEntry),
      ...(this.watchdog ? { watchdog: this.watchdog.status() } : {})
    };
  }

  async start() {
    if (!isLoopbackHostname(this.host)) {
      throw new ToolError("INVALID_DASHBOARD_HOST", "dashboard must bind to loopback");
    }
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        const normalized = asToolError(error);
        if (!response.headersSent) sendJson(response, statusForToolError(normalized), errorBody(normalized));
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, resolve);
    });
    this.watchdog?.start?.();
    return `http://${this.host}:${this.port}/`;
  }

  async stop() {
    this.watchdog?.stop?.();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  async handle(request, response) {
    const host = String(request.headers.host ?? "").split(":")[0];
    if (host && !isLoopbackHostname(host)) {
      sendJson(response, 403, errorBody(new ToolError("FORBIDDEN", "dashboard is loopback only")));
      return;
    }
    const url = new URL(request.url ?? "/", `http://${this.host}:${this.port}`);
    if (url.pathname === "/healthz") {
      sendText(response, 200, "ok\n");
      return;
    }
    if (url.pathname === "/api/state" && request.method === "GET") {
      sendJson(response, 200, await this.state());
      return;
    }
    if (url.pathname === "/api/workspaces" && request.method === "POST") {
      const body = await readJson(request);
      if (typeof body.root !== "string" || !body.root.trim()) {
        throw new ToolError("INVALID_ROOT", "root is required");
      }
      const entry = await this.registry.addFolder({ root: body.root, displayName: body.display_name, commandsConfig: null });
      sendJson(response, 200, { ok: true, workspace: publicEntry(entry) });
      return;
    }
    if (url.pathname === "/api/workspaces/pick" && request.method === "POST") {
      const root = await this.pickFolder();
      const entry = await this.registry.addFolder({ root, commandsConfig: null });
      sendJson(response, 200, { ok: true, workspace: publicEntry(entry) });
      return;
    }
    const removed = url.pathname.match(/^\/api\/workspaces\/([^/]+)$/);
    if (removed && request.method === "DELETE") {
      const entry = await this.registry.remove(decodeURIComponent(removed[1]));
      sendJson(response, 200, { ok: true, removed: publicEntry(entry) });
      return;
    }
    if (url.pathname === "/" && request.method === "GET") {
      sendHtml(response, 200, renderPage());
      return;
    }
    sendJson(response, 404, errorBody(new ToolError("ROUTE_NOT_FOUND", "not found")));
  }
}

function renderPage() {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Local Editor</title>
  <style>
    :root { color-scheme: light dark; }
    body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, sans-serif; margin: 32px auto; max-width: 880px; padding: 0 20px; }
    h1 { font-size: 20px; margin: 0 0 8px; }
    .muted { opacity: .7; }
    .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 16px 0; }
    button, .btn { border: 1px solid color-mix(in srgb, currentColor 30%, transparent); background: transparent; border-radius: 8px; padding: 6px 10px; cursor: pointer; text-decoration: none; color: inherit; }
    button.danger { color: #b42318; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid color-mix(in srgb, currentColor 14%, transparent); vertical-align: top; }
    td.path { font-size: 12px; opacity: .75; word-break: break-all; }
    td.actions { white-space: nowrap; }
    .dot { width: .7em; height: .7em; border-radius: 50%; display: inline-block; margin-right: 6px; background: #b42318; }
    .dot.on { background: #12b76a; }
    .empty { padding: 24px 0; }
  </style>
</head>
<body>
  <h1>Local Editor</h1>
  <p class="muted">ChatGPT가 읽을 수 있는 폴더를 여기서 관리합니다. 홈 폴더 전체가 아니라 추가한 항목만 보입니다.</p>
  <div class="row">
    <div id="tunnel"><span class="dot"></span>터널 확인 중</div>
    <a class="btn" id="tunnel-ui" href="http://127.0.0.1:8080/ui">터널 로그</a>
    <button id="add">파인더에서 폴더 추가</button>
  </div>
  <table>
    <thead><tr><th>이름</th><th>경로</th><th></th></tr></thead>
    <tbody id="rows"><tr><td colspan="3" class="muted">불러오는 중</td></tr></tbody>
  </table>
  <p id="message" class="muted"></p>
  <script>
    const message = document.getElementById("message");
    async function api(path, options) {
      const response = await fetch(path, Object.assign({ headers: { "content-type": "application/json" } }, options));
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || response.statusText);
      return body;
    }
    function render(state) {
      const tunnel = document.getElementById("tunnel");
      const recovery = state.watchdog && state.watchdog.last_recovery;
      tunnel.innerHTML = '<span class="dot ' + (state.tunnel.ready ? "on" : "") + '"></span>' +
        (state.tunnel.ready ? "터널 연결됨" : "터널 꺼짐") +
        (state.tunnel.detail && !state.tunnel.ready ? " · " + state.tunnel.detail : "") +
        (recovery ? " · 세션 복구됨" : "");
      document.getElementById("tunnel-ui").href = state.tunnel_ui;
      const rows = document.getElementById("rows");
      if (!state.workspaces.length) {
        rows.innerHTML = '<tr><td colspan="3" class="empty muted">등록된 폴더가 없습니다. 위에서 추가하세요.</td></tr>';
        return;
      }
      rows.innerHTML = state.workspaces.map((item) =>
        "<tr>" +
          "<td><strong>" + escapeHtml(item.display_name) + "</strong><div class=\\"muted\\">" + escapeHtml(item.workspace_id) + "</div></td>" +
          "<td class=\\"path\\">" + escapeHtml(item.root) + "</td>" +
          "<td class=\\"actions\\"><button data-id=\\"" + escapeHtml(item.workspace_id) + "\\" class=\\"danger\\">삭제</button></td>" +
        "</tr>"
      ).join("");
    }
    function escapeHtml(value) {
      return String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
    }
    async function reload() {
      render(await api("/api/state"));
    }
    document.getElementById("add").onclick = async () => {
      message.textContent = "파인더에서 폴더를 고르세요.";
      try {
        const result = await api("/api/workspaces/pick", { method: "POST", body: "{}" });
        message.textContent = result.workspace.display_name + " 추가됨";
        await reload();
      } catch (error) {
        message.textContent = error.message;
      }
    };
    document.getElementById("rows").onclick = async (event) => {
      const button = event.target.closest("button[data-id]");
      if (!button) return;
      if (!confirm(button.dataset.id + " 을(를) 제거할까요?")) return;
      try {
        await api("/api/workspaces/" + encodeURIComponent(button.dataset.id), { method: "DELETE" });
        message.textContent = "제거됨";
        await reload();
      } catch (error) {
        message.textContent = error.message;
      }
    };
    reload().catch((error) => { message.textContent = error.message; });
  </script>
</body>
</html>`;
}
