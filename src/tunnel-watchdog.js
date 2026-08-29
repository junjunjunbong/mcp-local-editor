import { execFile as execFileCallback } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { open } from "node:fs/promises";

const execFile = promisify(execFileCallback);

export const TUNNEL_WATCHDOG_DEFAULTS = {
  logPath: path.join(homedir(), "Library/Logs/mcp-local-editor-tunnel.log"),
  agentLabel: "com.mcp-local-editor.tunnel",
  intervalMs: 5_000,
  cooldownMs: 60_000,
  logTailBytes: 1024 * 1024
};

const DEADLINE_MSG = "command response deadline reached; dropping without posting a response";
const FORWARD_MSG = "dispatcher forwarded command to MCP server";
const MCP_STARTED_MSG = "stdio MCP command started";
const UPSTREAM_ERROR_MSG = "dispatcher received MCP upstream error; posted error response to control plane";

function parseLine(line, index) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let entry;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof entry?.msg !== "string") return null;
  let kind = null;
  if (entry.msg === FORWARD_MSG) kind = "forward";
  else if (entry.msg === DEADLINE_MSG) kind = "deadline";
  else if (entry.msg === MCP_STARTED_MSG) kind = "mcp_started";
  else if (entry.msg === UPSTREAM_ERROR_MSG && entry.status_code === 502) kind = "upstream_502";
  else return null;
  const time = Date.parse(entry.time);
  return { kind, index, time: Number.isFinite(time) ? time : index };
}

export function parseTunnelLog(text) {
  const events = [];
  if (!text) return events;
  for (const line of String(text).split(/\r?\n/)) {
    const event = parseLine(line, events.length);
    if (event) events.push(event);
  }
  return events;
}

export function assessTunnelLog(text, { now = Date.now(), cooldownUntil = 0, tunnelWanted = true } = {}) {
  if (!tunnelWanted) return { action: "idle", reason: "tunnel_off" };
  if (now < cooldownUntil) return { action: "idle", reason: "cooldown" };

  const events = parseTunnelLog(text);
  let lastForward = null;
  let lastDeadline = null;
  let last502 = null;
  let lastStart = null;
  for (const event of events) {
    if (event.kind === "forward") lastForward = event;
    else if (event.kind === "deadline") lastDeadline = event;
    else if (event.kind === "upstream_502") last502 = event;
    else if (event.kind === "mcp_started") lastStart = event;
  }

  const inSession = (event) => event && (!lastStart || event.index > lastStart.index);
  const deadline = inSession(lastDeadline) ? lastDeadline : null;
  const forward = inSession(lastForward) ? lastForward : null;
  const err502 = inSession(last502) ? last502 : null;

  if (deadline && (!forward || forward.index < deadline.index)) {
    return { action: "restart", reason: "deadline_without_later_forward" };
  }
  if (err502 && !forward) return { action: "restart", reason: "unforwarded_502" };
  return { action: "idle", reason: "healthy" };
}

async function readLogTail(logPath, maxBytes = TUNNEL_WATCHDOG_DEFAULTS.logTailBytes) {
  let handle;
  try {
    handle = await open(logPath, "r");
  } catch (error) {
    if (error && error.code === "ENOENT") return "";
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return "";
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, size - length));
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function agentIsLoaded(agentLabel, run = execFile) {
  try {
    await run("launchctl", ["list", agentLabel]);
    return true;
  } catch {
    return false;
  }
}

async function kickstartAgent(agentLabel, run = execFile) {
  const uid = process.getuid();
  await run("launchctl", ["kickstart", "-k", `gui/${uid}/${agentLabel}`]);
}

export class TunnelWatchdog {
  constructor(options = {}) {
    this.logPath = options.logPath ?? TUNNEL_WATCHDOG_DEFAULTS.logPath;
    this.agentLabel = options.agentLabel ?? TUNNEL_WATCHDOG_DEFAULTS.agentLabel;
    this.intervalMs = options.intervalMs ?? TUNNEL_WATCHDOG_DEFAULTS.intervalMs;
    this.cooldownMs = options.cooldownMs ?? TUNNEL_WATCHDOG_DEFAULTS.cooldownMs;
    this.logTailBytes = options.logTailBytes ?? TUNNEL_WATCHDOG_DEFAULTS.logTailBytes;
    this.readLog = options.readLog ?? (() => readLogTail(this.logPath, this.logTailBytes));
    this.isTunnelWanted = options.isTunnelWanted ?? (() => agentIsLoaded(this.agentLabel, options.run));
    this.restart = options.restart ?? (() => kickstartAgent(this.agentLabel, options.run));
    this.now = options.now ?? Date.now;
    this.onRecover = options.onRecover ?? ((info) => {
      process.stderr.write(`[mcp-local-editor] tunnel session recovered (${info.reason})\n`);
    });
    this.lastRecovery = null;
    this.cooldownUntil = 0;
    this.timer = null;
    this.tickInFlight = false;
  }

  status() {
    return { enabled: true, last_recovery: this.lastRecovery };
  }

  async tick() {
    if (this.tickInFlight) return { action: "idle", reason: "busy" };
    this.tickInFlight = true;
    try {
      const [tunnelWanted, text] = await Promise.all([this.isTunnelWanted(), this.readLog()]);
      const decision = assessTunnelLog(text, {
        now: this.now(),
        cooldownUntil: this.cooldownUntil,
        tunnelWanted
      });
      if (decision.action !== "restart") return decision;
      await this.restart();
      this.lastRecovery = { at: new Date(this.now()).toISOString(), reason: decision.reason };
      this.cooldownUntil = this.now() + this.cooldownMs;
      this.onRecover(this.lastRecovery);
      return decision;
    } catch {
      return { action: "idle", reason: "tick_failed" };
    } finally {
      this.tickInFlight = false;
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
