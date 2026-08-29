import { commandRun, fileEdit, fileRead, gitDiff, repoSearch } from "./core.js";
import { ToolError } from "./errors.js";

const SESSION_ID = { type: "string", minLength: 1, description: "Session returned by workspace_open" };
const TOOL_PROFILES = new Set(["full", "read"]);

export const TOOL_DEFINITIONS = [
  {
    name: "workspace_list",
    title: "List registered workspaces",
    description: "List operator-registered workspace ids without exposing absolute local paths.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "workspace_open",
    title: "Open workspace session",
    description: "Open a short-lived read or write session for one registered workspace id.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", minLength: 1 },
        access: { type: "string", enum: ["read", "write"], default: "read" },
        ttl_sec: { type: "integer", minimum: 60, maximum: 3600 }
      },
      required: ["workspace_id"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "repo_search",
    title: "Search repository",
    description: "Search text inside the workspace bound to session_id.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: SESSION_ID,
        query: { type: "string", minLength: 1 },
        glob: { type: "string", minLength: 1 },
        max_results: { type: "integer", minimum: 1, maximum: 200, default: 30 }
      },
      required: ["session_id", "query"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "file_read",
    title: "Read file slice",
    description: "Read an existing UTF-8 file and return its SHA-256 for file_edit.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: SESSION_ID,
        path: { type: "string", minLength: 1 },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 }
      },
      required: ["session_id", "path"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "file_edit",
    title: "Apply exact-text edits",
    description: "Edit one existing file using its current SHA-256 and unambiguous exact replacements.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: SESSION_ID,
        path: { type: "string", minLength: 1 },
        expected_sha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
        replacements: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            properties: { old_text: { type: "string", minLength: 1 }, new_text: { type: "string" } },
            required: ["old_text", "new_text"],
            additionalProperties: false
          }
        }
      },
      required: ["session_id", "path", "expected_sha256", "replacements"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  },
  {
    name: "command_run",
    title: "Run workspace command",
    description: "Run a command inside the session workspace. Prefer a registered command_id. If workspace_open returned allow_unlisted_argv=true, you may instead pass argv as a string array (for example [\".venv/bin/python\", \"src/script.py\"]). cwd is the workspace root. A single shell string is not accepted. This is not an OS sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: SESSION_ID,
        command_id: { type: "string", minLength: 1 },
        argv: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          items: { type: "string", minLength: 1 },
          description: "Executable plus arguments. Only allowed when the workspace has allowUnlistedArgv."
        },
        timeout_sec: { type: "integer", minimum: 1, maximum: 900, default: 300 }
      },
      required: ["session_id"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  },
  {
    name: "git_diff",
    title: "Review Git changes",
    description: "Return Git status and staged/unstaged diffs without changing Git state.",
    inputSchema: {
      type: "object",
      properties: { session_id: SESSION_ID },
      required: ["session_id"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }
];

const READ_TOOL_NAMES = new Set(["workspace_list", "workspace_open", "repo_search", "file_read", "git_diff"]);

function clone(value) {
  return structuredClone(value);
}

function readOnlyWorkspaceOpenDefinition() {
  const base = clone(TOOL_DEFINITIONS.find((definition) => definition.name === "workspace_open"));
  return {
    ...base,
    title: "Open read-only workspace session",
    description: "Open a short-lived read-only session for one registered workspace id.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", minLength: 1 },
        ttl_sec: { type: "integer", minimum: 60, maximum: 3600 }
      },
      required: ["workspace_id"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  };
}

export function normalizeToolProfile(value = "full") {
  if (typeof value !== "string" || !TOOL_PROFILES.has(value)) {
    throw new ToolError("INVALID_TOOL_PROFILE", "tool profile must be full or read");
  }
  return value;
}

export function toolDefinitionsForProfile(profile = "full") {
  const normalized = normalizeToolProfile(profile);
  if (normalized === "full") return TOOL_DEFINITIONS.map(clone);
  return TOOL_DEFINITIONS
    .filter((definition) => READ_TOOL_NAMES.has(definition.name))
    .map((definition) => {
      if (definition.name === "workspace_open") return readOnlyWorkspaceOpenDefinition();
      const safe = clone(definition);
      if (safe.name === "file_read") safe.description = "Read a bounded slice of an existing UTF-8 file and return its SHA-256.";
      return safe;
    });
}

function withoutSession(input) {
  const { session_id: _sessionId, ...rest } = input;
  return rest;
}

export class LocalEditorService {
  constructor(registry, sessions, options = {}) {
    this.registry = registry;
    this.sessions = sessions;
    const requestedProfile = typeof options === "string" ? options : options.profile;
    this.profile = normalizeToolProfile(requestedProfile ?? "full");
    this.toolDefinitions = toolDefinitionsForProfile(this.profile);
    this.allowedToolNames = new Set(this.toolDefinitions.map((definition) => definition.name));
  }

  instructions() {
    const common = [
      "Call workspace_list and workspace_open before repository tools.",
      "Select only a registered workspace id; never invent or request an absolute path.",
      "Pass session_id to every repository tool.",
      "This is a workspace guard, not an operating-system sandbox."
    ];
    if (this.profile === "read") {
      return [
        ...common,
        "All sessions are read-only.",
        "This profile cannot edit files or run commands."
      ].join(" ");
    }
    return [
      ...common,
      "Use file_read before file_edit and pass the returned SHA-256.",
      "Read sessions cannot edit files or run commands."
    ].join(" ");
  }

  async call(name, args = {}) {
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      throw new ToolError("INVALID_ARGUMENT", "tool arguments must be an object");
    }
    if (!this.allowedToolNames.has(name)) {
      throw new ToolError("UNKNOWN_TOOL", `tool is not available in the ${this.profile} profile: ${name}`);
    }
    switch (name) {
      case "workspace_list":
        return { workspaces: await this.registry.listStatus() };
      case "workspace_open": {
        if (this.profile === "read") {
          if (args.access !== undefined && args.access !== "read") {
            throw new ToolError("PERMISSION_DENIED", "the read profile cannot open a write session");
          }
          const opened = await this.sessions.open({ ...args, access: "read" });
          const { commands: _commands, allow_unlisted_argv: _allowUnlisted, ...safe } = opened;
          return safe;
        }
        return await this.sessions.open(args);
      }
      case "repo_search": {
        const session = await this.sessions.resolve(args.session_id);
        return await repoSearch(session.workspace, withoutSession(args));
      }
      case "file_read": {
        const session = await this.sessions.resolve(args.session_id);
        return await fileRead(session.workspace, withoutSession(args));
      }
      case "file_edit": {
        const session = await this.sessions.resolve(args.session_id, { write: true });
        return await fileEdit(session.workspace, withoutSession(args));
      }
      case "command_run": {
        const session = await this.sessions.resolve(args.session_id, { write: true, refreshConfig: true });
        return await commandRun(session.workspace, session.config, withoutSession(args));
      }
      case "git_diff": {
        const session = await this.sessions.resolve(args.session_id);
        return await gitDiff(session.workspace);
      }
      default:
        throw new ToolError("UNKNOWN_TOOL", `unknown tool: ${name}`);
    }
  }
}
