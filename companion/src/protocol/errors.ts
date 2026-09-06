export type ProtocolErrorCode =
  | "PROPOSAL_CONFLICT" | "PROPOSAL_NOT_FOUND" | "PROPOSAL_NOT_PENDING" | "PROPOSAL_INVALID_CLAIM" | "PROPOSAL_LIMIT"
  | "AUTH_REQUIRED"
  | "PROTOCOL_VERSION_MISMATCH"
  | "MALFORMED_JSON"
  | "INVALID_REQUEST"
  | "REQUEST_TOO_LARGE"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "DESCRIPTOR_MISMATCH"
  | "STALE_GENERATION"
  | "STORAGE_ERROR"
  | "INTERNAL_ERROR";

export class ProtocolError extends Error {
  constructor(
    readonly status: number,
    readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function publicError(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) return error;
  return new ProtocolError(
    500,
    "INTERNAL_ERROR",
    "The Companion could not complete the request.",
  );
}
