import assert from "node:assert/strict";
import test from "node:test";
import { assessTunnelLog, TunnelWatchdog } from "../src/tunnel-watchdog.js";

function line(time, msg, extra = {}) {
  return JSON.stringify({ time, msg, ...extra });
}

function log(lines) {
  return lines.join("\n") + "\n";
}

const T0 = "2026-08-29T10:39:41.847578+09:00";
const T1 = "2026-08-29T10:41:57.078017+09:00";
const T2 = "2026-08-29T10:41:57.274510+09:00";
const T3 = "2026-08-29T13:35:56.333452+09:00";

test("healthy forwards stay idle", () => {
  const text = log([
    line("2026-08-28T21:07:17.000000+09:00", "stdio MCP command started"),
    line(T0, "dispatcher forwarded command to MCP server")
  ]);
  assert.deepEqual(assessTunnelLog(text), { action: "idle", reason: "healthy" });
});

test("deadline without a later forward recovers the session", () => {
  const text = log([
    line("2026-08-28T21:07:17.000000+09:00", "stdio MCP command started"),
    line(T0, "dispatcher forwarded command to MCP server"),
    line(T1, "command response deadline reached; dropping without posting a response"),
    line(T2, "dispatcher received MCP upstream error; posted error response to control plane", { status_code: 502 })
  ]);
  assert.deepEqual(assessTunnelLog(text), { action: "restart", reason: "deadline_without_later_forward" });
});

test("mcp start after a deadline means the session already recovered", () => {
  const text = log([
    line(T0, "dispatcher forwarded command to MCP server"),
    line(T1, "command response deadline reached; dropping without posting a response"),
    line(T2, "dispatcher received MCP upstream error; posted error response to control plane", { status_code: 502 }),
    line(T3, "stdio MCP command started")
  ]);
  assert.deepEqual(assessTunnelLog(text), { action: "idle", reason: "healthy" });
});

test("forward after a deadline is treated as healthy", () => {
  const text = log([
    line("2026-08-28T21:07:17.000000+09:00", "stdio MCP command started"),
    line(T1, "command response deadline reached; dropping without posting a response"),
    line(T3, "dispatcher forwarded command to MCP server")
  ]);
  assert.deepEqual(assessTunnelLog(text), { action: "idle", reason: "healthy" });
});

test("502s with no forward after the last start recover even without a deadline line", () => {
  const text = log([
    line("2026-08-28T21:07:17.000000+09:00", "stdio MCP command started"),
    line(T2, "dispatcher received MCP upstream error; posted error response to control plane", { status_code: 502 })
  ]);
  assert.deepEqual(assessTunnelLog(text), { action: "restart", reason: "unforwarded_502" });
});

test("non-JSON noise and other tunnel lines are ignored", () => {
  const text = [
    "[mcp-local-editor] profile=full",
    "not json",
    line(T0, "tunnel-client startup summary"),
    line(T1, "command response deadline reached; dropping without posting a response")
  ].join("\n");
  assert.deepEqual(assessTunnelLog(text), { action: "restart", reason: "deadline_without_later_forward" });
});

test("a stopped tunnel is not kicked back on", () => {
  const text = log([
    line(T1, "command response deadline reached; dropping without posting a response")
  ]);
  assert.deepEqual(assessTunnelLog(text, { tunnelWanted: false }), { action: "idle", reason: "tunnel_off" });
});

test("cooldown suppresses another restart", () => {
  const text = log([
    line(T1, "command response deadline reached; dropping without posting a response")
  ]);
  assert.deepEqual(assessTunnelLog(text, { now: 1000, cooldownUntil: 2000 }), { action: "idle", reason: "cooldown" });
});

test("watchdog tick restarts once and then cools down", async () => {
  let logText = log([
    line("2026-08-28T21:07:17.000000+09:00", "stdio MCP command started"),
    line(T1, "command response deadline reached; dropping without posting a response")
  ]);
  const restarts = [];
  let now = 1_000;
  const watchdog = new TunnelWatchdog({
    readLog: async () => logText,
    isTunnelWanted: async () => true,
    restart: async () => { restarts.push(now); },
    now: () => now,
    cooldownMs: 60_000
  });

  assert.deepEqual(await watchdog.tick(), { action: "restart", reason: "deadline_without_later_forward" });
  assert.deepEqual(restarts, [1_000]);
  assert.equal(watchdog.status().last_recovery.reason, "deadline_without_later_forward");

  now = 2_000;
  assert.deepEqual(await watchdog.tick(), { action: "idle", reason: "cooldown" });
  assert.deepEqual(restarts, [1_000]);

  logText += line(T3, "stdio MCP command started") + "\n";
  now = 70_000;
  assert.deepEqual(await watchdog.tick(), { action: "idle", reason: "healthy" });
  assert.deepEqual(restarts, [1_000]);
});

test("watchdog tick does not restart when the operator stopped the tunnel", async () => {
  const watchdog = new TunnelWatchdog({
    readLog: async () => log([
      line(T1, "command response deadline reached; dropping without posting a response")
    ]),
    isTunnelWanted: async () => false,
    restart: async () => { throw new Error("should not restart"); }
  });
  assert.deepEqual(await watchdog.tick(), { action: "idle", reason: "tunnel_off" });
  assert.equal(watchdog.status().last_recovery, null);
});
