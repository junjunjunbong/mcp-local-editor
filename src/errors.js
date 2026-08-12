export class ToolError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }
}

export function asToolError(error) {
  if (error instanceof ToolError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ToolError("INTERNAL_ERROR", message);
}
