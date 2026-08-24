import { ToolError } from "./errors.js";

export const ACTION_ROUTES = Object.freeze([
  {
    path: "/actions/workspaces/list",
    tool: "workspace_list",
    operationId: "listWorkspaces",
    summary: "List registered local workspaces",
    description: "List operator-registered workspace ids without exposing absolute local paths."
  },
  {
    path: "/actions/workspaces/open",
    tool: "workspace_open",
    operationId: "openWorkspace",
    summary: "Open a workspace session",
    description: "Open a short-lived read or write session for one registered workspace id."
  },
  {
    path: "/actions/repository/search",
    tool: "repo_search",
    operationId: "searchRepository",
    summary: "Search a repository",
    description: "Search text inside the repository bound to a workspace session."
  },
  {
    path: "/actions/files/read",
    tool: "file_read",
    operationId: "readFile",
    summary: "Read a file slice",
    description: "Read an existing UTF-8 file and return its current SHA-256 for a later edit."
  },
  {
    path: "/actions/files/edit",
    tool: "file_edit",
    operationId: "editFile",
    summary: "Edit an existing file",
    description: "Apply unambiguous exact-text replacements using the SHA-256 returned by readFile."
  },
  {
    path: "/actions/commands/run",
    tool: "command_run",
    operationId: "runCommand",
    summary: "Run an allowlisted command",
    description: "Run one operator-configured command id inside the session workspace."
  },
  {
    path: "/actions/git/diff",
    tool: "git_diff",
    operationId: "reviewGitDiff",
    summary: "Review Git changes",
    description: "Return Git status and staged and unstaged diffs without changing Git state."
  }
]);

function normalizeServerUrl(serverUrl) {
  if (typeof serverUrl !== "string" || serverUrl.trim().length === 0) {
    throw new ToolError("INVALID_PUBLIC_URL", "OpenAPI server URL must be a non-empty string");
  }

  let parsed;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new ToolError("INVALID_PUBLIC_URL", "OpenAPI server URL must be a valid HTTP or HTTPS URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ToolError("INVALID_PUBLIC_URL", "OpenAPI server URL must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ToolError("INVALID_PUBLIC_URL", "OpenAPI server URL cannot contain credentials, query, or fragment");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new ToolError("INVALID_PUBLIC_URL", "OpenAPI server URL cannot contain a path");
  }

  return parsed.origin;
}

function definitionMap(toolDefinitions) {
  if (!Array.isArray(toolDefinitions)) {
    throw new ToolError("INVALID_TOOL_DEFINITIONS", "toolDefinitions must be an array");
  }
  return new Map(toolDefinitions.map((definition) => [definition.name, definition]));
}

const successSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean", const: true },
    result: { type: "object", additionalProperties: true }
  },
  required: ["ok", "result"],
  additionalProperties: false
};

const errorSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean", const: false },
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        details: {}
      },
      required: ["code", "message"],
      additionalProperties: false
    }
  },
  required: ["ok", "error"],
  additionalProperties: false
};

export function buildOpenApiDocument({ serverUrl, toolDefinitions }) {
  const normalizedUrl = normalizeServerUrl(serverUrl);
  const definitions = definitionMap(toolDefinitions);
  const paths = {};

  for (const route of ACTION_ROUTES) {
    const definition = definitions.get(route.tool);
    if (!definition) {
      throw new ToolError("MISSING_TOOL_DEFINITION", `Missing tool definition for ${route.tool}`);
    }
    paths[route.path] = {
      post: {
        operationId: route.operationId,
        summary: route.summary,
        description: route.description,
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: definition.inputSchema
            }
          }
        },
        responses: {
          "200": {
            description: "Action completed",
            content: { "application/json": { schema: successSchema } }
          },
          "400": {
            description: "Invalid action request",
            content: { "application/json": { schema: errorSchema } }
          },
          "401": {
            description: "Missing or invalid bearer token",
            content: { "application/json": { schema: errorSchema } }
          },
          "403": {
            description: "Action is not permitted by the session or command policy",
            content: { "application/json": { schema: errorSchema } }
          },
          "404": {
            description: "Workspace, session, file, or route was not found",
            content: { "application/json": { schema: errorSchema } }
          },
          "409": {
            description: "The local state changed and the action must be retried",
            content: { "application/json": { schema: errorSchema } }
          },
          "410": {
            description: "The workspace session expired or was revoked",
            content: { "application/json": { schema: errorSchema } }
          },
          "500": {
            description: "Unexpected local server error",
            content: { "application/json": { schema: errorSchema } }
          }
        }
      }
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "MCP Local Editor Actions",
      version: "0.2.0",
      description:
        "Authenticated actions for selecting an operator-registered local workspace, reading and editing existing files, running allowlisted checks, and reviewing Git diffs."
    },
    servers: [{ url: normalizedUrl }],
    components: {
      schemas: {},
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "opaque API token"
        }
      }
    },
    paths
  };
}

export function validatePublicUrl(value) {
  return normalizeServerUrl(value);
}
