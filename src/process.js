import { spawn } from "node:child_process";
import { ToolError } from "./errors.js";

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

function pickSafeEnvironment(extra = {}) {
  const allowedKeys = [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "SYSTEMROOT",
    "COMSPEC",
    "ComSpec",
    "PATHEXT",
    "LOCALAPPDATA",
    "APPDATA"
  ];

  const env = {};
  for (const key of allowedKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

class OutputCollector {
  constructor(limitBytes = DEFAULT_MAX_OUTPUT_BYTES) {
    this.limitBytes = Math.max(1024, limitBytes);
    this.headLimit = Math.floor(this.limitBytes * 0.7);
    this.tailLimit = this.limitBytes - this.headLimit;
    this.head = Buffer.alloc(0);
    this.tail = Buffer.alloc(0);
    this.totalBytes = 0;
  }

  push(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.totalBytes += buffer.length;

    let remaining = buffer;
    if (this.head.length < this.headLimit) {
      const needed = this.headLimit - this.head.length;
      const take = Math.min(needed, remaining.length);
      this.head = Buffer.concat([this.head, remaining.subarray(0, take)]);
      remaining = remaining.subarray(take);
    }

    if (remaining.length > 0) {
      this.tail = Buffer.concat([this.tail, remaining]);
      if (this.tail.length > this.tailLimit) {
        this.tail = this.tail.subarray(this.tail.length - this.tailLimit);
      }
    }
  }

  result() {
    const truncated = this.totalBytes > this.limitBytes;
    if (!truncated) {
      return {
        text: Buffer.concat([this.head, this.tail]).toString("utf8"),
        truncated: false,
        totalBytes: this.totalBytes
      };
    }

    const omitted = Math.max(0, this.totalBytes - this.head.length - this.tail.length);
    const marker = Buffer.from(`\n...[truncated ${omitted} bytes]...\n`, "utf8");
    return {
      text: Buffer.concat([this.head, marker, this.tail]).toString("utf8"),
      truncated: true,
      totalBytes: this.totalBytes
    };
  }
}

function terminateProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    child.kill("SIGKILL");
    return;
  }

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Process may have already exited.
    }
  }
}

export async function runProcess({
  file,
  args = [],
  cwd,
  timeoutMs = 30_000,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  env = {}
}) {
  if (typeof file !== "string" || file.length === 0) {
    throw new ToolError("INVALID_COMMAND", "Command executable must be a non-empty string");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new ToolError("INVALID_COMMAND", "Command arguments must be strings");
  }

  const startedAt = Date.now();
  const stdout = new OutputCollector(maxOutputBytes);
  const stderr = new OutputCollector(maxOutputBytes);

  return await new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const child = spawn(file, args, {
      cwd,
      env: pickSafeEnvironment(env),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, Math.max(1, timeoutMs));

    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new ToolError("COMMAND_START_FAILED", `Failed to start ${file}: ${error.message}`, {
          file,
          args
        })
      );
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const stdoutResult = stdout.result();
      const stderrResult = stderr.result();
      const durationMs = Date.now() - startedAt;

      if (timedOut) {
        reject(
          new ToolError("COMMAND_TIMEOUT", `Command timed out after ${timeoutMs} ms`, {
            file,
            args,
            timeoutMs,
            durationMs,
            stdout: stdoutResult.text,
            stderr: stderrResult.text
          })
        );
        return;
      }

      resolve({
        exitCode: typeof code === "number" ? code : 1,
        signal,
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        outputTruncated: stdoutResult.truncated || stderrResult.truncated,
        durationMs
      });
    });
  });
}
