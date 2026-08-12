import readline from "node:readline";
import { asToolError, ToolError } from "./errors.js";
import { TOOL_DEFINITIONS } from "./service.js";

const SERVER_INFO = { name: "mcp-local-editor", version: "0.2.0" };
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSIONS = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);

const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });
const rpcError = (id, code, message, data) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
const toolResult = (value, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value, ...(isError ? { isError: true } : {}) });

function isRequest(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && value.jsonrpc === "2.0" && typeof value.method === "string";
}

export class McpStdioServer {
  constructor(service, { input = process.stdin, output = process.stdout, errorOutput = process.stderr } = {}) {
    this.service = service;
    this.input = input;
    this.output = output;
    this.errorOutput = errorOutput;
    this.closed = false;
  }

  capabilities() {
    return { tools: { listChanged: false } };
  }

  discoverResult() {
    return {
      supportedVersions: [MODERN_PROTOCOL_VERSION],
      capabilities: this.capabilities(),
      instructions: this.service.instructions(),
      _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO }
    };
  }

  initializeResult(params = {}) {
    const requested = params.protocolVersion;
    return {
      protocolVersion: LEGACY_PROTOCOL_VERSIONS.has(requested) ? requested : "2025-11-25",
      capabilities: this.capabilities(),
      serverInfo: SERVER_INFO,
      instructions: this.service.instructions()
    };
  }

  async handleRequest(request) {
    const { id, method, params = {} } = request;
    if (id === undefined) return null;
    try {
      switch (method) {
        case "server/discover": return result(id, this.discoverResult());
        case "initialize": return result(id, this.initializeResult(params));
        case "ping":
        case "logging/setLevel": return result(id, {});
        case "tools/list": return result(id, { tools: TOOL_DEFINITIONS });
        case "resources/list": return result(id, { resources: [] });
        case "resources/templates/list": return result(id, { resourceTemplates: [] });
        case "prompts/list": return result(id, { prompts: [] });
        case "tools/call": {
          if (params === null || typeof params !== "object" || Array.isArray(params) || typeof params.name !== "string") {
            return rpcError(id, -32602, "Invalid params");
          }
          const args = params.arguments ?? {};
          if (args === null || typeof args !== "object" || Array.isArray(args)) return rpcError(id, -32602, "Invalid tool arguments");
          try {
            return result(id, toolResult(await this.service.call(params.name, args)));
          } catch (error) {
            const normalized = asToolError(error);
            return result(id, toolResult({ ok: false, error: { code: normalized.code, message: normalized.message, ...(normalized.details === undefined ? {} : { details: normalized.details }) } }, true));
          }
        }
        default: return rpcError(id, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      const normalized = error instanceof ToolError ? error : asToolError(error);
      return rpcError(id, -32603, normalized.message, { code: normalized.code, details: normalized.details });
    }
  }

  async handleMessage(message) {
    if (Array.isArray(message)) {
      if (message.length === 0) return rpcError(null, -32600, "Invalid Request");
      const responses = [];
      for (const item of message) {
        if (!isRequest(item)) responses.push(rpcError(item?.id ?? null, -32600, "Invalid Request"));
        else {
          const response = await this.handleRequest(item);
          if (response !== null) responses.push(response);
        }
      }
      return responses.length ? responses : null;
    }
    if (!isRequest(message)) return rpcError(message?.id ?? null, -32600, "Invalid Request");
    return await this.handleRequest(message);
  }

  write(message) {
    if (message !== null && !this.closed) this.output.write(`${JSON.stringify(message)}\n`);
  }

  async start() {
    this.input.setEncoding("utf8");
    const lines = readline.createInterface({ input: this.input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.write(await this.handleMessage(JSON.parse(line)));
      } catch (error) {
        if (error instanceof SyntaxError) this.write(rpcError(null, -32700, "Parse error"));
        else {
          const normalized = asToolError(error);
          this.errorOutput.write(`[mcp-local-editor] ${normalized.code}: ${normalized.message}\n`);
          this.write(rpcError(null, -32603, "Internal error"));
        }
      }
    }
    this.closed = true;
  }
}
