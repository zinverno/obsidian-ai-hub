import { McpToolError } from "./errors.js";

export const MAX_CURSOR_LENGTH = 65_536;

interface NotesCursor {
  version: 1;
  kind: "notes";
  prefix: string;
  path: string;
}

interface ChunksCursor {
  version: 1;
  kind: "chunks";
  path: string;
  ordinal: number;
  chunkId: string;
}

function invalidCursor(): never {
  throw new McpToolError("INVALID_CURSOR", "The pagination cursor is invalid for this request.");
}

function decode(cursor: string): Record<string, unknown> {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(cursor)) invalidCursor();
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Converted to the stable public tool error below.
  }
  return invalidCursor();
}

function encode(cursor: NotesCursor | ChunksCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function notesCursor(prefix: string, path: string): string {
  return encode({ version: 1, kind: "notes", prefix, path });
}

export function parseNotesCursor(cursor: string | undefined, prefix: string): string {
  if (cursor === undefined) return "";
  const value = decode(cursor);
  if (value.version !== 1 || value.kind !== "notes" || value.prefix !== prefix || typeof value.path !== "string") {
    invalidCursor();
  }
  return value.path as string;
}

export function chunksCursor(path: string, ordinal: number, chunkId: string): string {
  return encode({ version: 1, kind: "chunks", path, ordinal, chunkId });
}

export function parseChunksCursor(
  cursor: string | undefined,
  path: string,
): { ordinal: number; chunkId: string } | null {
  if (cursor === undefined) return null;
  const value = decode(cursor);
  if (
    value.version !== 1 ||
    value.kind !== "chunks" ||
    value.path !== path ||
    typeof value.ordinal !== "number" ||
    !Number.isSafeInteger(value.ordinal) ||
    value.ordinal < 0 ||
    typeof value.chunkId !== "string"
  ) {
    invalidCursor();
  }
  return { ordinal: value.ordinal, chunkId: value.chunkId } as { ordinal: number; chunkId: string };
}
