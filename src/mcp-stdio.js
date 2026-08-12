import readline from "node:readline";
import { asToolError, ToolError } from "./errors.js";
import { TOOL_DEFINITIONS } from "./core.js";

const SERVER_INFO = { name: "mcp-local-editor", version: "0.1.0" };
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSIONS = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);

function jsonRpcError(id, code, message, data = undefined) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data })
    }
  };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function toolResult(data, isError = false) {
  const text = JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: data,
    ...(isError ? { isError: true } : {})
  };
}

function isRequest(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.jsonrpc === "2.0" &&
    typeof value.method === "string"
  );
}

export class McpStdioServer {
  constructor(editor, { input = process.stdin, output = process.stdout, errorOutput = process.stderr } = {}) {
    this.editor = editor;
    this.input = input;
    this.output = output;
    this.errorOutput = errorOutput;
    this.initialized = false;
    this.closed = false;
  }

  capabilities() {
    return { tools: { listChanged: false } };
  }

  discoverResult() {
    return {
      supportedVersions: [MODERN_PROTOCOL_VERSION],
      capabilities: this.capabilities(),
      instructions: this.editor.instructions(),
      _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO }
    };
  }

  initializeResult(params = {}) {
    const requested = params.protocolVersion;
    const protocolVersion = LEGACY_PROTOCOL_VERSIONS.has(requested) ? requested : "2025-11-25";
    this.initialized = true;
    return {
      protocolVersion,
      capabilities: this.capabilities(),
      serverInfo: SERVER_INFO,
      instructions: this.editor.instructions()
    };
  }

  async handleRequest(request) {
    const { id, method, params = {} } = request;
    const isNotification = id === undefined;

    if (isNotification) {
      if (method === "notifications/initialized") this.initialized = true;
      return null;
    }

    try {
      switch (method) {
        case "server/discover":
          return jsonRpcResult(id, this.discoverResult());
        case "initialize":
          return jsonRpcResult(id, this.initializeResult(params));
        case "ping":
          return jsonRpcResult(id, {});
        case "logging/setLevel":
          return jsonRpcResult(id, {});
        case "tools/list":
          return jsonRpcResult(id, { tools: TOOL_DEFINITIONS });
        case "tools/call": {
          if (params === null || typeof params !== "object" || Array.isArray(params)) {
            return jsonRpcError(id, -32602, "Invalid params");
          }
          if (typeof params.name !== "string") {
            return jsonRpcError(id, -32602, "tools/call requires params.name");
          }
          const args = params.arguments === undefined ? {} : params.arguments;
          if (args === null || typeof args !== "object" || Array.isArray(args)) {
            return jsonRpcError(id, -32602, "tools/call params.arguments must be an object");
          }
          try {
            const data = await this.editor.call(params.name, args);
            return jsonRpcResult(id, toolResult(data));
          } catch (error) {
            const toolError = asToolError(error);
            return jsonRpcResult(
              id,
              toolResult(
                {
                  ok: false,
                  error: {
                    code: toolError.code,
                    message: toolError.message,
                    ...(toolError.details === undefined ? {} : { details: toolError.details })
                  }
                },
                true
              )
            );
          }
        }
        case "resources/list":
          return jsonRpcResult(id, { resources: [] });
        case "resources/templates/list":
          return jsonRpcResult(id, { resourceTemplates: [] });
        case "prompts/list":
          return jsonRpcResult(id, { prompts: [] });
        default:
          return jsonRpcError(id, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      const normalized = error instanceof ToolError ? error : asToolError(error);
      return jsonRpcError(id, -32603, normalized.message, {
        code: normalized.code,
        details: normalized.details
      });
    }
  }

  async handleMessage(message) {
    if (Array.isArray(message)) {
      if (message.length === 0) return jsonRpcError(null, -32600, "Invalid Request");
      const responses = [];
      for (const item of message) {
        if (!isRequest(item)) {
          responses.push(jsonRpcError(item?.id ?? null, -32600, "Invalid Request"));
          continue;
        }
        const response = await this.handleRequest(item);
        if (response !== null) responses.push(response);
      }
      return responses.length > 0 ? responses : null;
    }

    if (!isRequest(message)) return jsonRpcError(message?.id ?? null, -32600, "Invalid Request");
    return await this.handleRequest(message);
  }

  write(message) {
    if (message === null || this.closed) return;
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  async start() {
    this.input.setEncoding("utf8");
    const lines = readline.createInterface({ input: this.input, crlfDelay: Infinity });

    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const response = await this.handleMessage(parsed);
        this.write(response);
      } catch (error) {
        if (error instanceof SyntaxError) {
          this.write(jsonRpcError(null, -32700, "Parse error"));
          continue;
        }
        const normalized = asToolError(error);
        this.errorOutput.write(`[mcp-local-editor] ${normalized.code}: ${normalized.message}\n`);
        this.write(jsonRpcError(null, -32603, "Internal error"));
      }
    }

    this.closed = true;
  }
}
