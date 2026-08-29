import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ToolError } from "./errors.js";
import { runProcess } from "./process.js";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_READ_LINES = 2_000;
const MAX_REPLACEMENTS = 50;
const MAX_RESULTS = 200;
const MAX_ARGV_ITEMS = 64;
const MAX_COMMAND_TIMEOUT_SEC = 900;
const DEFAULT_OUTPUT_BYTES = 256 * 1024;

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function requireRelativePath(value) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new ToolError("INVALID_PATH", "path must be a non-empty repository-relative string");
  }
  if (path.isAbsolute(value)) throw new ToolError("PATH_OUTSIDE_ROOT", "absolute paths are not allowed");
}

function requireObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolError("INVALID_ARGUMENT", `${name} must be an object`);
  }
  return value;
}

export class Workspace {
  static async open(rootPath) {
    if (typeof rootPath !== "string" || rootPath.trim() === "") {
      throw new ToolError("ROOT_REQUIRED", "workspace root is required");
    }
    let root;
    try {
      root = await fs.realpath(path.resolve(rootPath));
    } catch (error) {
      throw new ToolError("ROOT_NOT_FOUND", "workspace root does not exist", { cause: String(error) });
    }
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new ToolError("ROOT_NOT_DIRECTORY", "workspace root is not a directory");
    return new Workspace(root);
  }

  constructor(root) {
    this.root = root;
  }

  async resolveExistingFile(relativePath) {
    requireRelativePath(relativePath);
    const lexical = path.resolve(this.root, relativePath);
    if (!isInside(this.root, lexical)) throw new ToolError("PATH_OUTSIDE_ROOT", "path escapes the workspace");
    let real;
    try {
      real = await fs.realpath(lexical);
    } catch (error) {
      throw new ToolError("FILE_NOT_FOUND", `file not found: ${relativePath}`, { cause: String(error) });
    }
    if (!isInside(this.root, real)) throw new ToolError("PATH_OUTSIDE_ROOT", "resolved path escapes the workspace");
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new ToolError("NOT_A_FILE", `not a regular file: ${relativePath}`);
    return { absolutePath: real, stat };
  }
}

function validateCommand(id, raw) {
  requireObject(raw, `commands.${id}`);
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new ToolError("INVALID_CONFIG", `invalid command id: ${id}`);
  if (!Array.isArray(raw.argv) || raw.argv.length === 0 || raw.argv.some((v) => typeof v !== "string" || !v)) {
    throw new ToolError("INVALID_CONFIG", `commands.${id}.argv must be a non-empty string array`);
  }
  const timeoutSec = raw.timeoutSec ?? 300;
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec > MAX_COMMAND_TIMEOUT_SEC) {
    throw new ToolError("INVALID_CONFIG", `commands.${id}.timeoutSec must be between 0 and ${MAX_COMMAND_TIMEOUT_SEC}`);
  }
  const maxOutputBytes = raw.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 10 * 1024 * 1024) {
    throw new ToolError("INVALID_CONFIG", `commands.${id}.maxOutputBytes is out of range`);
  }
  return {
    id,
    description: typeof raw.description === "string" ? raw.description : "",
    argv: [...raw.argv],
    timeoutMs: Math.round(timeoutSec * 1000),
    maxOutputBytes
  };
}

export function normalizeConfig(raw = {}) {
  requireObject(raw, "config");
  const commandsObject = raw.commands === undefined ? {} : requireObject(raw.commands, "commands");
  const commands = new Map();
  for (const [id, command] of Object.entries(commandsObject)) commands.set(id, validateCommand(id, command));
  if (raw.allowUnlistedArgv !== undefined && typeof raw.allowUnlistedArgv !== "boolean") {
    throw new ToolError("INVALID_CONFIG", "allowUnlistedArgv must be a boolean");
  }
  return { commands, allowUnlistedArgv: raw.allowUnlistedArgv === true };
}

export async function loadConfig(configPath, root) {
  if (!configPath) return normalizeConfig({});
  const resolved = path.isAbsolute(configPath) ? configPath : path.resolve(root, configPath);
  let text;
  try {
    text = await fs.readFile(resolved, "utf8");
  } catch (error) {
    throw new ToolError("CONFIG_NOT_FOUND", `could not read command config: ${resolved}`, { cause: String(error) });
  }
  try {
    return normalizeConfig(JSON.parse(text));
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError("INVALID_CONFIG", `command config is not valid JSON: ${resolved}`, { cause: String(error) });
  }
}

export function listCommands(config) {
  return [...config.commands.values()].map(({ id, description }) => ({ command_id: id, description }));
}

async function readUtf8(workspace, relativePath) {
  const { absolutePath, stat } = await workspace.resolveExistingFile(relativePath);
  if (stat.size > MAX_FILE_BYTES) throw new ToolError("FILE_TOO_LARGE", "file exceeds the 5 MiB limit");
  const content = await fs.readFile(absolutePath, "utf8");
  if (content.includes("\0")) throw new ToolError("BINARY_FILE", "binary files are not supported");
  return { absolutePath, stat, content };
}

export async function fileRead(workspace, input) {
  const start = input.start_line ?? 1;
  const end = input.end_line ?? start + 399;
  if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start) {
    throw new ToolError("INVALID_ARGUMENT", "line bounds must be positive integers with end_line >= start_line");
  }
  if (end - start + 1 > MAX_READ_LINES) throw new ToolError("READ_TOO_LARGE", "at most 2000 lines may be read");
  const { content } = await readUtf8(workspace, input.path);
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const effectiveEnd = Math.min(end, lines.length);
  return {
    path: input.path,
    sha256: sha256(content),
    size_bytes: Buffer.byteLength(content),
    total_lines: lines.length,
    start_line: start,
    end_line: effectiveEnd,
    content: start > lines.length ? "" : lines.slice(start - 1, effectiveEnd).join("\n")
  };
}

function countOccurrences(text, needle) {
  let count = 0;
  let offset = 0;
  while (needle && (offset = text.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

export async function fileEdit(workspace, input) {
  if (typeof input.expected_sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(input.expected_sha256)) {
    throw new ToolError("INVALID_ARGUMENT", "expected_sha256 must be a SHA-256 digest");
  }
  if (!Array.isArray(input.replacements) || input.replacements.length < 1 || input.replacements.length > MAX_REPLACEMENTS) {
    throw new ToolError("INVALID_ARGUMENT", "replacements must contain 1-50 entries");
  }
  const { absolutePath, stat, content } = await readUtf8(workspace, input.path);
  const current = sha256(content);
  if (current !== input.expected_sha256.toLowerCase()) {
    throw new ToolError("STALE_FILE", "file changed after it was read", { current_sha256: current });
  }

  let next = content;
  const applied = [];
  for (let index = 0; index < input.replacements.length; index += 1) {
    const replacement = requireObject(input.replacements[index], `replacements[${index}]`);
    if (typeof replacement.old_text !== "string" || replacement.old_text === "" || typeof replacement.new_text !== "string") {
      throw new ToolError("INVALID_ARGUMENT", `invalid replacements[${index}]`);
    }
    const matches = countOccurrences(next, replacement.old_text);
    if (matches === 0) throw new ToolError("TEXT_NOT_FOUND", `replacements[${index}].old_text was not found`);
    if (matches > 1) throw new ToolError("AMBIGUOUS_REPLACEMENT", `replacements[${index}].old_text matched ${matches} times`);
    next = next.replace(replacement.old_text, replacement.new_text);
    if (Buffer.byteLength(next) > MAX_FILE_BYTES) throw new ToolError("FILE_TOO_LARGE", "edited file would exceed 5 MiB");
    applied.push({ replacement_index: index });
  }
  if (next === content) throw new ToolError("NO_CHANGE", "edit would not change the file");

  const temp = path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.mcp-edit-${randomBytes(6).toString("hex")}`);
  try {
    const mode = stat.mode & 0o777;
    await fs.writeFile(temp, next, { encoding: "utf8", mode });
    await fs.chmod(temp, mode);
    await fs.rename(temp, absolutePath);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw new ToolError("WRITE_FAILED", `failed to edit ${input.path}`, { cause: String(error) });
  }
  return { path: input.path, previous_sha256: current, sha256: sha256(next), replacements_applied: applied };
}

export async function repoSearch(workspace, input) {
  if (typeof input.query !== "string" || input.query === "" || input.query.length > 2_000) {
    throw new ToolError("INVALID_ARGUMENT", "query must be a non-empty string of at most 2000 characters");
  }
  const maxResults = input.max_results ?? 30;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) {
    throw new ToolError("INVALID_ARGUMENT", "max_results must be between 1 and 200");
  }
  const args = ["--json", "--line-number", "--column", "--smart-case", "--color", "never"];
  if (input.glob !== undefined) {
    if (typeof input.glob !== "string" || !input.glob) throw new ToolError("INVALID_ARGUMENT", "glob must be non-empty");
    args.push("--glob", input.glob);
  }
  args.push("--", input.query, ".");
  let result;
  try {
    result = await runProcess({ file: "rg", args, cwd: workspace.root, timeoutMs: 30_000, maxOutputBytes: 5 * 1024 * 1024 });
  } catch (error) {
    if (error instanceof ToolError && error.code === "COMMAND_START_FAILED") {
      throw new ToolError("RIPGREP_NOT_FOUND", "repo_search requires ripgrep (`rg`) on PATH");
    }
    throw error;
  }
  if (![0, 1].includes(result.exitCode)) throw new ToolError("SEARCH_FAILED", "ripgrep failed", { stderr: result.stderr });
  const matches = [];
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== "match") continue;
    const data = event.data ?? {};
    const p = data.path?.text;
    const text = data.lines?.text;
    if (typeof p !== "string" || typeof text !== "string") continue;
    matches.push({
      path: p.replace(/^\.\//, ""),
      line: data.line_number ?? null,
      column: typeof data.submatches?.[0]?.start === "number" ? data.submatches[0].start + 1 : null,
      text: text.replace(/[\r\n]+$/, "")
    });
    if (matches.length >= maxResults) break;
  }
  return { query: input.query, glob: input.glob ?? null, matches, match_count: matches.length, truncated: matches.length >= maxResults || result.outputTruncated };
}

function validateArgv(argv, name) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGV_ITEMS || argv.some((value) => typeof value !== "string" || !value)) {
    throw new ToolError("INVALID_ARGUMENT", `${name} must be a non-empty string array of at most ${MAX_ARGV_ITEMS} items`);
  }
  return [...argv];
}

function resolveTimeoutSec(value) {
  const timeoutSec = value ?? 300;
  if (!Number.isInteger(timeoutSec) || timeoutSec <= 0 || timeoutSec > MAX_COMMAND_TIMEOUT_SEC) {
    throw new ToolError("INVALID_ARGUMENT", `timeout_sec must be an integer between 1 and ${MAX_COMMAND_TIMEOUT_SEC}`);
  }
  return timeoutSec;
}

function resolveCommand(config, input) {
  const hasCommandId = input.command_id !== undefined;
  const hasArgv = input.argv !== undefined;
  if (hasCommandId && hasArgv) throw new ToolError("INVALID_ARGUMENT", "pass command_id or argv, not both");
  if (hasCommandId) {
    if (typeof input.command_id !== "string" || !input.command_id) throw new ToolError("INVALID_ARGUMENT", "command_id is required");
    const command = config.commands.get(input.command_id);
    if (!command) {
      throw new ToolError("COMMAND_NOT_ALLOWED", `unknown command_id: ${input.command_id}`, {
        allowed_commands: listCommands(config).map((value) => value.command_id),
        allow_unlisted_argv: config.allowUnlistedArgv === true
      });
    }
    return command;
  }
  if (hasArgv) {
    if (!config.allowUnlistedArgv) {
      throw new ToolError("COMMAND_NOT_ALLOWED", "unlisted argv is disabled for this workspace", {
        allowed_commands: listCommands(config).map((value) => value.command_id),
        allow_unlisted_argv: false
      });
    }
    return {
      id: null,
      argv: validateArgv(input.argv, "argv"),
      timeoutMs: resolveTimeoutSec(input.timeout_sec) * 1000,
      maxOutputBytes: DEFAULT_OUTPUT_BYTES
    };
  }
  throw new ToolError("INVALID_ARGUMENT", config.allowUnlistedArgv ? "command_id or argv is required" : "command_id is required");
}

export async function commandRun(workspace, config, input) {
  const command = resolveCommand(config, input);
  const [file, ...args] = command.argv;
  const result = await runProcess({ file, args, cwd: workspace.root, timeoutMs: command.timeoutMs, maxOutputBytes: command.maxOutputBytes });
  return {
    command_id: command.id,
    argv: command.argv,
    exit_code: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    output_truncated: result.outputTruncated,
    duration_ms: result.durationMs
  };
}

async function git(workspace, args) {
  try {
    return await runProcess({
      file: "git",
      args,
      cwd: workspace.root,
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
      env: { GIT_PAGER: "cat", PAGER: "cat", GIT_OPTIONAL_LOCKS: "0" }
    });
  } catch (error) {
    if (error instanceof ToolError && error.code === "COMMAND_START_FAILED") throw new ToolError("GIT_NOT_FOUND", "git is required");
    throw error;
  }
}

export async function gitDiff(workspace) {
  const check = await git(workspace, ["rev-parse", "--is-inside-work-tree"]);
  if (check.exitCode !== 0 || check.stdout.trim() !== "true") throw new ToolError("NOT_A_GIT_REPOSITORY", "workspace is not a Git work tree");
  const results = await Promise.all([
    git(workspace, ["status", "--short", "--untracked-files=all"]),
    git(workspace, ["diff", "--no-ext-diff", "--stat"]),
    git(workspace, ["diff", "--no-ext-diff", "--unified=3"]),
    git(workspace, ["diff", "--cached", "--no-ext-diff", "--stat"]),
    git(workspace, ["diff", "--cached", "--no-ext-diff", "--unified=3"])
  ]);
  if (results.some((result) => result.exitCode !== 0)) throw new ToolError("GIT_DIFF_FAILED", "one or more Git reads failed");
  return {
    status: results[0].stdout,
    unstaged_stat: results[1].stdout,
    unstaged_diff: results[2].stdout,
    staged_stat: results[3].stdout,
    staged_diff: results[4].stdout,
    output_truncated: results.some((result) => result.outputTruncated)
  };
}
