import { commandRun, fileEdit, fileRead, gitDiff, repoSearch } from "./core.js";
import { ToolError } from "./errors.js";

const SESSION_ID = { type: "string", minLength: 1, description: "Session returned by workspace_open" };

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
    title: "Run allowlisted command",
    description: "Run one operator-configured command id inside the session workspace. No shell string is accepted.",
    inputSchema: {
      type: "object",
      properties: { session_id: SESSION_ID, command_id: { type: "string", minLength: 1 } },
      required: ["session_id", "command_id"],
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

function withoutSession(input) {
  const { session_id: _sessionId, ...rest } = input;
  return rest;
}

export class LocalEditorService {
  constructor(registry, sessions) {
    this.registry = registry;
    this.sessions = sessions;
  }

  instructions() {
    return [
      "Call workspace_list and workspace_open before repository tools.",
      "Select only a registered workspace id; never invent or request an absolute path.",
      "Pass session_id to every repository tool.",
      "Use file_read before file_edit and pass the returned SHA-256.",
      "Read sessions cannot edit files or run commands.",
      "This is a workspace guard, not an operating-system sandbox."
    ].join(" ");
  }

  async call(name, args = {}) {
    if (args === null || typeof args !== "object" || Array.isArray(args)) throw new ToolError("INVALID_ARGUMENT", "tool arguments must be an object");
    switch (name) {
      case "workspace_list":
        return { workspaces: await this.registry.listStatus() };
      case "workspace_open":
        return await this.sessions.open(args);
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
