export type McpToolErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_CURSOR"
  | "NOTE_NOT_FOUND"
  | "SEMANTIC_SEARCH_UNAVAILABLE";

export class McpToolError extends Error {
  constructor(readonly code: McpToolErrorCode, message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

export function semanticSearchUnavailable(): McpToolError {
  return new McpToolError(
    "SEMANTIC_SEARCH_UNAVAILABLE",
    "Semantic search is unavailable because the stored vector space and Companion query provider are not compatible or the provider could not be reached.",
  );
}
