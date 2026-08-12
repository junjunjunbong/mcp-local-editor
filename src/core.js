import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ToolError } from "./errors.js";
import { runProcess } from "./process.js";

const DEFAULT_TIMEOUT_SEC = 300;
const MAX_TIMEOUT_SEC = 900;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_REPLACEMENTS = 50;
const DEFAULT_END_LINE = 400;
const MAX_LINES_PER_READ = 2_000;
const DEFAULT_MAX_RESULTS = 30;
const MAX_RESULTS = 200;
const MAX_SEARCH_OUTPUT_BYTES = 5 * 1024 * 1024;
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;
const GIT_ENV = { GIT_PAGER: "cat", PAGER: "cat", GIT_OPTIONAL_LOCKS: "0" };

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = haystack.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function randomSuffix() {
  return randomBytes(6).toString("hex");
}

function ensurePlainObject(value, name = "value") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function validateRelativePath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
    throw new ToolError("INVALID_PATH", "Path must be a non-empty repository-relative string");
  }
  if (relativePath.includes("\0")) {
    throw new ToolError("INVALID_PATH", "Path contains a null byte");
  }
  if (path.isAbsolute(relativePath)) {
    throw new ToolError("PATH_OUTSIDE_ROOT", "Absolute paths are not allowed", { path: relativePath });
  }
}

export class Workspace {
  static async open(rootPath) {
    if (typeof rootPath !== "string" || rootPath.trim().length === 0) {
      throw new ToolError("ROOT_REQUIRED", "A repository root is required");
    }

    let realRoot;
    try {
      realRoot = await fs.realpath(path.resolve(rootPath));
    } catch (error) {
      throw new ToolError("ROOT_NOT_FOUND", `Repository root does not exist: ${rootPath}`, {
        cause: error instanceof Error ? error.message : String(error)
      });
    }

    const stat = await fs.stat(realRoot);
    if (!stat.isDirectory()) {
      throw new ToolError("ROOT_NOT_DIRECTORY", `Repository root is not a directory: ${rootPath}`);
    }

    return new Workspace(realRoot);
  }

  constructor(root) {
    this.root = root;
  }

  async resolveExistingFile(relativePath) {
    validateRelativePath(relativePath);
    const lexicalPath = path.resolve(this.root, relativePath);
    if (!isInside(this.root, lexicalPath)) {
      throw new ToolError("PATH_OUTSIDE_ROOT", "Path escapes the configured repository root", {
        path: relativePath
      });
    }

    let realPath;
    try {
      realPath = await fs.realpath(lexicalPath);
    } catch (error) {
      throw new ToolError("FILE_NOT_FOUND", `File not found: ${relativePath}`, {
        cause: error instanceof Error ? error.message : String(error)
      });
    }

    if (!isInside(this.root, realPath)) {
      throw new ToolError("PATH_OUTSIDE_ROOT", "Resolved path escapes the configured repository root", {
        path: relativePath,
        resolvedPath: realPath
      });
    }

    const stat = await fs.stat(realPath);
    if (!stat.isFile()) {
      throw new ToolError("NOT_A_FILE", `Path is not a regular file: ${relativePath}`);
    }

    return { absolutePath: realPath, stat };
  }
}

function validateCommand(id, value) {
  const command = ensurePlainObject(value, `commands.${id}`);
  if (!Array.isArray(command.argv) || command.argv.length === 0) {
    throw new ToolError("INVALID_CONFIG", `commands.${id}.argv must be a non-empty string array`);
  }
  if (command.argv.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new ToolError("INVALID_CONFIG", `commands.${id}.argv must contain only non-empty strings`);
  }

  const timeoutSec = command.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  if (typeof timeoutSec !== "number" || !Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec > MAX_TIMEOUT_SEC) {
    throw new ToolError(
      "INVALID_CONFIG",
      `commands.${id}.timeoutSec must be greater than 0 and at most ${MAX_TIMEOUT_SEC}`
    );
  }

  const maxOutputBytes = command.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 10 * 1024 * 1024) {
    throw new ToolError(
      "INVALID_CONFIG",
      `commands.${id}.maxOutputBytes must be an integer between 1024 and 10485760`
    );
  }

  return {
    id,
    description: typeof command.description === "string" ? command.description : "",
    argv: [...command.argv],
    timeoutMs: Math.round(timeoutSec * 1000),
    maxOutputBytes
  };
}

export function normalizeConfig(raw = {}) {
  const config = ensurePlainObject(raw, "config");
  const rawCommands = config.commands === undefined ? {} : ensurePlainObject(config.commands, "commands");
  const commands = new Map();

  for (const [id, value] of Object.entries(rawCommands)) {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new ToolError("INVALID_CONFIG", `Invalid command id: ${id}`);
    }
    commands.set(id, validateCommand(id, value));
  }

  return { commands };
}

export async function loadConfig(configPath, root) {
  if (!configPath) return normalizeConfig({});

  const resolved = path.isAbsolute(configPath) ? configPath : path.resolve(root, configPath);
  let text;
  try {
    text = await fs.readFile(resolved, "utf8");
  } catch (error) {
    throw new ToolError("CONFIG_NOT_FOUND", `Could not read config file: ${resolved}`, {
      cause: error instanceof Error ? error.message : String(error)
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ToolError("INVALID_CONFIG", `Config file is not valid JSON: ${resolved}`, {
      cause: error instanceof Error ? error.message : String(error)
    });
  }

  return normalizeConfig(parsed);
}

function validateLine(value, name, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new ToolError("INVALID_ARGUMENT", `${name} must be a positive integer`);
  }
  return value;
}

export async function fileRead(workspace, input) {
  const startLine = validateLine(input.start_line, "start_line", 1);
  const endLine = validateLine(input.end_line, "end_line", startLine + DEFAULT_END_LINE - 1);
  if (endLine < startLine) {
    throw new ToolError("INVALID_ARGUMENT", "end_line must be greater than or equal to start_line");
  }
  if (endLine - startLine + 1 > MAX_LINES_PER_READ) {
    throw new ToolError("READ_TOO_LARGE", `At most ${MAX_LINES_PER_READ} lines may be read at once`);
  }

  const { absolutePath, stat } = await workspace.resolveExistingFile(input.path);
  if (stat.size > MAX_FILE_BYTES) {
    throw new ToolError("FILE_TOO_LARGE", `File exceeds the ${MAX_FILE_BYTES}-byte read limit`, {
      path: input.path,
      size: stat.size
    });
  }

  const content = await fs.readFile(absolutePath, "utf8");
  if (content.includes("\0")) {
    throw new ToolError("BINARY_FILE", `Binary files are not supported: ${input.path}`);
  }

  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const effectiveEnd = Math.min(endLine, lines.length);
  const selected = startLine > lines.length ? "" : lines.slice(startLine - 1, effectiveEnd).join("\n");

  return {
    path: input.path,
    sha256: sha256(content),
    size_bytes: Buffer.byteLength(content, "utf8"),
    total_lines: lines.length,
    start_line: startLine,
    end_line: effectiveEnd,
    content: selected
  };
}

function validateReplacements(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REPLACEMENTS) {
    throw new ToolError(
      "INVALID_ARGUMENT",
      `replacements must contain between 1 and ${MAX_REPLACEMENTS} exact-text replacements`
    );
  }

  return value.map((replacement, index) => {
    if (replacement === null || typeof replacement !== "object" || Array.isArray(replacement)) {
      throw new ToolError("INVALID_ARGUMENT", `replacements[${index}] must be an object`);
    }
    if (typeof replacement.old_text !== "string" || replacement.old_text.length === 0) {
      throw new ToolError("INVALID_ARGUMENT", `replacements[${index}].old_text must be non-empty`);
    }
    if (typeof replacement.new_text !== "string") {
      throw new ToolError("INVALID_ARGUMENT", `replacements[${index}].new_text must be a string`);
    }
    return { oldText: replacement.old_text, newText: replacement.new_text };
  });
}

export async function fileEdit(workspace, input) {
  if (typeof input.expected_sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(input.expected_sha256)) {
    throw new ToolError("INVALID_ARGUMENT", "expected_sha256 must be a 64-character SHA-256 hex digest");
  }

  const replacements = validateReplacements(input.replacements);
  const { absolutePath, stat } = await workspace.resolveExistingFile(input.path);
  if (stat.size > MAX_FILE_BYTES) {
    throw new ToolError("FILE_TOO_LARGE", `File exceeds the ${MAX_FILE_BYTES}-byte edit limit`, {
      path: input.path,
      size: stat.size
    });
  }

  const original = await fs.readFile(absolutePath, "utf8");
  if (original.includes("\0")) {
    throw new ToolError("BINARY_FILE", `Binary files are not supported: ${input.path}`);
  }

  const currentHash = sha256(original);
  if (currentHash !== input.expected_sha256.toLowerCase()) {
    throw new ToolError("STALE_FILE", "File changed after it was read; read it again before editing", {
      path: input.path,
      expected_sha256: input.expected_sha256,
      current_sha256: currentHash
    });
  }

  let next = original;
  const applied = [];
  for (let index = 0; index < replacements.length; index += 1) {
    const { oldText, newText } = replacements[index];
    const matches = countOccurrences(next, oldText);
    if (matches === 0) {
      throw new ToolError("TEXT_NOT_FOUND", `replacements[${index}].old_text was not found`, {
        path: input.path,
        replacement_index: index
      });
    }
    if (matches > 1) {
      throw new ToolError("AMBIGUOUS_REPLACEMENT", `replacements[${index}].old_text matched ${matches} times`, {
        path: input.path,
        replacement_index: index,
        matches
      });
    }

    next = next.replace(oldText, newText);
    if (Buffer.byteLength(next, "utf8") > MAX_FILE_BYTES) {
      throw new ToolError("FILE_TOO_LARGE", `Edited file would exceed the ${MAX_FILE_BYTES}-byte limit`, {
        path: input.path
      });
    }
    applied.push({ replacement_index: index, removed_chars: oldText.length, added_chars: newText.length });
  }

  if (next === original) {
    throw new ToolError("NO_CHANGE", "The requested replacements would not change the file");
  }

  const directory = path.dirname(absolutePath);
  const temporaryPath = path.join(directory, `.${path.basename(absolutePath)}.mcp-edit-${randomSuffix()}`);
  try {
    const permissionMode = stat.mode & 0o777;
    await fs.writeFile(temporaryPath, next, { encoding: "utf8", mode: permissionMode });
    await fs.chmod(temporaryPath, permissionMode);
    await fs.rename(temporaryPath, absolutePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw new ToolError("WRITE_FAILED", `Failed to update ${input.path}`, {
      cause: error instanceof Error ? error.message : String(error)
    });
  }

  return {
    path: input.path,
    previous_sha256: currentHash,
    sha256: sha256(next),
    replacements_applied: applied,
    size_bytes: Buffer.byteLength(next, "utf8")
  };
}

export async function repoSearch(workspace, input) {
  if (typeof input.query !== "string" || input.query.length === 0) {
    throw new ToolError("INVALID_ARGUMENT", "query must be a non-empty string");
  }
  if (input.query.length > 2_000) {
    throw new ToolError("INVALID_ARGUMENT", "query is too long");
  }

  const maxResults = input.max_results ?? DEFAULT_MAX_RESULTS;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) {
    throw new ToolError("INVALID_ARGUMENT", `max_results must be an integer between 1 and ${MAX_RESULTS}`);
  }
  if (input.glob !== undefined && (typeof input.glob !== "string" || input.glob.length === 0)) {
    throw new ToolError("INVALID_ARGUMENT", "glob must be a non-empty string when provided");
  }

  const args = ["--json", "--line-number", "--column", "--smart-case", "--color", "never"];
  if (input.glob) args.push("--glob", input.glob);
  args.push("--", input.query, ".");

  let result;
  try {
    result = await runProcess({
      file: "rg",
      args,
      cwd: workspace.root,
      timeoutMs: 30_000,
      maxOutputBytes: MAX_SEARCH_OUTPUT_BYTES
    });
  } catch (error) {
    if (error instanceof ToolError && error.code === "COMMAND_START_FAILED") {
      throw new ToolError("RIPGREP_NOT_FOUND", "repo_search requires ripgrep (`rg`) on PATH");
    }
    throw error;
  }

  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new ToolError("SEARCH_FAILED", "ripgrep failed", {
      exit_code: result.exitCode,
      stderr: result.stderr
    });
  }

  const matches = [];
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "match") continue;

    const data = event.data ?? {};
    const matchedPath = data.path?.text;
    const lineText = data.lines?.text;
    const submatch = Array.isArray(data.submatches) ? data.submatches[0] : undefined;
    if (typeof matchedPath !== "string" || typeof lineText !== "string") continue;

    matches.push({
      path: matchedPath.replace(/^\.\//, ""),
      line: data.line_number ?? null,
      column: typeof submatch?.start === "number" ? submatch.start + 1 : null,
      text: lineText.replace(/[\r\n]+$/, "")
    });
    if (matches.length >= maxResults) break;
  }

  return {
    query: input.query,
    glob: input.glob ?? null,
    matches,
    match_count: matches.length,
    truncated: matches.length >= maxResults || result.outputTruncated
  };
}

export function listCommands(config) {
  return [...config.commands.values()].map((command) => ({
    command_id: command.id,
    description: command.description
  }));
}

export async function commandRun(workspace, config, input) {
  if (typeof input.command_id !== "string" || input.command_id.length === 0) {
    throw new ToolError("INVALID_ARGUMENT", "command_id must be a non-empty string");
  }

  const command = config.commands.get(input.command_id);
  if (!command) {
    throw new ToolError("COMMAND_NOT_ALLOWED", `Unknown command_id: ${input.command_id}`, {
      allowed_commands: listCommands(config).map((entry) => entry.command_id)
    });
  }

  const [file, ...args] = command.argv;
  const result = await runProcess({
    file,
    args,
    cwd: workspace.root,
    timeoutMs: command.timeoutMs,
    maxOutputBytes: command.maxOutputBytes
  });

  return {
    command_id: command.id,
    exit_code: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    output_truncated: result.outputTruncated,
    duration_ms: result.durationMs
  };
}

async function git(workspace, args) {
  let result;
  try {
    result = await runProcess({
      file: "git",
      args,
      cwd: workspace.root,
      timeoutMs: 30_000,
      maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
      env: GIT_ENV
    });
  } catch (error) {
    if (error instanceof ToolError && error.code === "COMMAND_START_FAILED") {
      throw new ToolError("GIT_NOT_FOUND", "git_diff requires git on PATH");
    }
    throw error;
  }
  return result;
}

export async function gitDiff(workspace) {
  const repositoryCheck = await git(workspace, ["rev-parse", "--is-inside-work-tree"]);
  if (repositoryCheck.exitCode !== 0 || repositoryCheck.stdout.trim() !== "true") {
    throw new ToolError("NOT_A_GIT_REPOSITORY", "Configured root is not inside a Git working tree");
  }

  const [status, unstagedStat, unstaged, stagedStat, staged] = await Promise.all([
    git(workspace, ["status", "--short", "--untracked-files=all"]),
    git(workspace, ["diff", "--no-ext-diff", "--stat"]),
    git(workspace, ["diff", "--no-ext-diff", "--unified=3"]),
    git(workspace, ["diff", "--cached", "--no-ext-diff", "--stat"]),
    git(workspace, ["diff", "--cached", "--no-ext-diff", "--unified=3"])
  ]);

  const failures = [status, unstagedStat, unstaged, stagedStat, staged].filter((result) => result.exitCode !== 0);
  if (failures.length > 0) {
    throw new ToolError("GIT_DIFF_FAILED", "One or more git diff commands failed", {
      errors: failures.map((failure) => failure.stderr)
    });
  }

  return {
    status: status.stdout,
    unstaged_stat: unstagedStat.stdout,
    unstaged_diff: unstaged.stdout,
    staged_stat: stagedStat.stdout,
    staged_diff: staged.stdout,
    output_truncated: [status, unstagedStat, unstaged, stagedStat, staged].some(
      (result) => result.outputTruncated
    )
  };
}

export const TOOL_DEFINITIONS = [
  {
    name: "repo_search",
    title: "Search repository",
    description: "Search text in the configured repository with ripgrep. This tool is read-only.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "ripgrep regular expression" },
        glob: { type: "string", minLength: 1, description: "Optional ripgrep glob, such as **/*.js" },
        max_results: { type: "integer", minimum: 1, maximum: 200, default: 30 }
      },
      required: ["query"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "file_read",
    title: "Read file slice",
    description: "Read a UTF-8 file slice and return the full-file SHA-256 needed by file_edit.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Repository-relative file path" },
        start_line: { type: "integer", minimum: 1, default: 1 },
        end_line: { type: "integer", minimum: 1, description: "Inclusive line number" }
      },
      required: ["path"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "file_edit",
    title: "Apply exact-text edits",
    description:
      "Edit one existing UTF-8 file using unambiguous exact-text replacements. Requires the SHA-256 returned by file_read.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Repository-relative file path" },
        expected_sha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
        replacements: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              old_text: { type: "string", minLength: 1 },
              new_text: { type: "string" }
            },
            required: ["old_text", "new_text"],
            additionalProperties: false
          }
        }
      },
      required: ["path", "expected_sha256", "replacements"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  },
  {
    name: "command_run",
    title: "Run allowlisted command",
    description: "Run one command defined by the operator in the JSON config. Arbitrary shell strings are not accepted.",
    inputSchema: {
      type: "object",
      properties: {
        command_id: { type: "string", minLength: 1 }
      },
      required: ["command_id"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  },
  {
    name: "git_diff",
    title: "Review Git changes",
    description: "Return git status plus staged and unstaged diffs. This tool never changes Git state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }
];

export class LocalEditor {
  constructor(workspace, config) {
    this.workspace = workspace;
    this.config = config;
  }

  instructions() {
    const commands = listCommands(this.config);
    const commandText = commands.length
      ? commands
          .map((command) => `${command.command_id}${command.description ? `: ${command.description}` : ""}`)
          .join("; ")
      : "none";
    return [
      `Repository root is fixed to ${this.workspace.root}.`,
      "Use file_read before file_edit and pass the returned SHA-256.",
      "file_edit only supports existing UTF-8 files and exact replacements.",
      `Allowlisted command IDs: ${commandText}.`,
      "This server is workspace-confined, not a process sandbox."
    ].join(" ");
  }

  async call(name, args = {}) {
    switch (name) {
      case "repo_search":
        return await repoSearch(this.workspace, args);
      case "file_read":
        return await fileRead(this.workspace, args);
      case "file_edit":
        return await fileEdit(this.workspace, args);
      case "command_run":
        return await commandRun(this.workspace, this.config, args);
      case "git_diff":
        return await gitDiff(this.workspace);
      default:
        throw new ToolError("UNKNOWN_TOOL", `Unknown tool: ${name}`);
    }
  }
}
