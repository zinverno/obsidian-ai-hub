import { ProtocolError } from "./errors.js";
import { PROTOCOL_VERSION } from "./types.js";
import type {
  ChunkSourceRange,
  MirroredChunk,
  MirroredNote,
  NoteManifestEntry,
  ReconciliationPlanRequest,
  SemanticDescriptor,
  SyncBatchRequest,
  SyncOperation,
} from "./types.js";

export const MAX_BATCH_OPERATIONS = 100;
export const MAX_MANIFEST_NOTES = 100_000;
export const MAX_NOTE_CONTENT_BYTES = 4 * 1024 * 1024;
export const MAX_CHUNKS_PER_NOTE = 10_000;

function invalid(message: string): never {
  throw new ProtocolError(400, "INVALID_REQUEST", message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string, max = 16_384): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    invalid(`${label} must be a non-empty string of at most ${max} characters.`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    invalid(`${label} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function protocolVersion(value: unknown): 1 {
  if (value !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      409,
      "PROTOCOL_VERSION_MISMATCH",
      `Companion protocol version ${PROTOCOL_VERSION} is required.`,
    );
  }
  return PROTOCOL_VERSION;
}

export function validateVaultId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    invalid("vaultId must be a UUID.");
  }
  return value.toLowerCase();
}

export function validateVaultPath(value: unknown, label = "path"): string {
  const path = stringValue(value, label, 4096);
  if (
    path !== path.trim() ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    invalid(`${label} must be a canonical vault-relative path.`);
  }
  return path;
}

function descriptor(value: unknown): SemanticDescriptor {
  const input = record(value, "descriptor");
  const baseUrl = stringValue(input.baseUrl, "descriptor.baseUrl", 4096);
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    invalid("descriptor.baseUrl must be a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    invalid("descriptor.baseUrl must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password) {
    invalid("descriptor.baseUrl must not contain credentials.");
  }
  if (input.normalized !== true) invalid("descriptor.normalized must be true.");
  return {
    providerId: stringValue(input.providerId, "descriptor.providerId", 256),
    model: stringValue(input.model, "descriptor.model", 1024),
    baseUrl,
    dimensions: integer(input.dimensions, "descriptor.dimensions", 1),
    embeddingSpaceId: stringValue(input.embeddingSpaceId, "descriptor.embeddingSpaceId", 8192),
    normalized: true,
  };
}

function source(value: unknown): ChunkSourceRange {
  const input = record(value, "chunk.source");
  const result = {
    startOffset: integer(input.startOffset, "chunk.source.startOffset"),
    endOffset: integer(input.endOffset, "chunk.source.endOffset"),
    startLine: integer(input.startLine, "chunk.source.startLine"),
    endLine: integer(input.endLine, "chunk.source.endLine"),
  };
  if (result.startOffset > result.endOffset || result.startLine > result.endLine) {
    invalid("chunk.source range is reversed.");
  }
  return result;
}

function chunk(value: unknown, notePath: string, dimensions: number): MirroredChunk {
  const input = record(value, "chunk");
  if (!Array.isArray(input.headingPath) || input.headingPath.some((item) => typeof item !== "string")) {
    invalid("chunk.headingPath must be an array of strings.");
  }
  if (!Array.isArray(input.embedding) || input.embedding.length !== dimensions) {
    invalid(`chunk.embedding must contain exactly ${dimensions} values.`);
  }
  const embedding = input.embedding.map((item) => {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      invalid("chunk.embedding values must be finite numbers.");
    }
    return item;
  });
  const actualPath = validateVaultPath(input.notePath, "chunk.notePath");
  if (actualPath !== notePath) invalid("chunk.notePath must match note.path.");
  return {
    chunkId: stringValue(input.chunkId, "chunk.chunkId", 4096),
    notePath: actualPath,
    ordinal: integer(input.ordinal, "chunk.ordinal"),
    headingPath: [...(input.headingPath as string[])],
    text: typeof input.text === "string" ? input.text : invalid("chunk.text must be a string."),
    contentHash: stringValue(input.contentHash, "chunk.contentHash", 1024),
    source: source(input.source),
    embedding,
  };
}

function note(value: unknown, dimensions: number): MirroredNote {
  const input = record(value, "note");
  const path = validateVaultPath(input.path, "note.path");
  if (typeof input.content !== "string") invalid("note.content must be a string.");
  if (Buffer.byteLength(input.content as string, "utf8") > MAX_NOTE_CONTENT_BYTES) {
    invalid(`note.content exceeds ${MAX_NOTE_CONTENT_BYTES} bytes.`);
  }
  const metadata = record(input.metadata, "note.metadata");
  if (!Array.isArray(input.chunks) || input.chunks.length > MAX_CHUNKS_PER_NOTE) {
    invalid(`note.chunks must contain at most ${MAX_CHUNKS_PER_NOTE} entries.`);
  }
  const chunks = input.chunks.map((item) => chunk(item, path, dimensions));
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  for (const item of chunks) {
    if (ids.has(item.chunkId)) invalid("note.chunks contains duplicate chunkId values.");
    if (ordinals.has(item.ordinal)) invalid("note.chunks contains duplicate ordinal values.");
    if (item.source.endOffset > (input.content as string).length) {
      invalid("chunk.source must be within note.content.");
    }
    ids.add(item.chunkId);
    ordinals.add(item.ordinal);
  }
  return {
    path,
    content: input.content as string,
    contentHash: stringValue(input.contentHash, "note.contentHash", 1024),
    metadata,
    chunks,
  };
}

function manifestEntry(value: unknown): NoteManifestEntry {
  const input = record(value, "manifest note");
  if (!Array.isArray(input.chunks) || input.chunks.length > MAX_CHUNKS_PER_NOTE) {
    invalid(`manifest chunks must contain at most ${MAX_CHUNKS_PER_NOTE} entries.`);
  }
  const chunks = input.chunks.map((value) => {
    const item = record(value, "manifest chunk");
    return {
      chunkId: stringValue(item.chunkId, "manifest chunkId", 4096),
      contentHash: stringValue(item.contentHash, "manifest chunk contentHash", 1024),
    };
  });
  return {
    path: validateVaultPath(input.path),
    contentHash: stringValue(input.contentHash, "manifest contentHash", 1024),
    chunks,
  };
}

export function parseReconciliationPlanRequest(value: unknown): ReconciliationPlanRequest {
  const input = record(value, "request");
  protocolVersion(input.protocolVersion);
  if (!Array.isArray(input.notes) || input.notes.length > MAX_MANIFEST_NOTES) {
    invalid(`notes must contain at most ${MAX_MANIFEST_NOTES} entries.`);
  }
  const notes = input.notes.map(manifestEntry);
  const paths = new Set<string>();
  for (const item of notes) {
    if (paths.has(item.path)) invalid("notes contains duplicate paths.");
    paths.add(item.path);
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    generation: integer(input.generation, "generation"),
    descriptor: descriptor(input.descriptor),
    notes,
  };
}

function operation(value: unknown, dimensions: number): SyncOperation {
  const input = record(value, "operation");
  if (input.type === "UPSERT") return { type: "UPSERT", note: note(input.note, dimensions) };
  if (input.type === "DELETE") return { type: "DELETE", path: validateVaultPath(input.path) };
  if (input.type === "RENAME") {
    const renamed = note(input.note, dimensions);
    const oldPath = validateVaultPath(input.oldPath, "oldPath");
    if (oldPath === renamed.path) invalid("RENAME paths must differ.");
    return { type: "RENAME", oldPath, note: renamed };
  }
  invalid("operation.type must be UPSERT, DELETE, or RENAME.");
}

export function parseSyncBatchRequest(value: unknown): SyncBatchRequest {
  const input = record(value, "request");
  protocolVersion(input.protocolVersion);
  const parsedDescriptor = descriptor(input.descriptor);
  if (!Array.isArray(input.operations) || input.operations.length > MAX_BATCH_OPERATIONS) {
    invalid(`operations must contain at most ${MAX_BATCH_OPERATIONS} entries.`);
  }
  if (input.replaceVault !== undefined && typeof input.replaceVault !== "boolean") {
    invalid("replaceVault must be a boolean.");
  }
  const result: SyncBatchRequest = {
    protocolVersion: PROTOCOL_VERSION,
    generation: integer(input.generation, "generation"),
    descriptor: parsedDescriptor,
    operations: input.operations.map((item) => operation(item, parsedDescriptor.dimensions)),
  };
  if (input.replaceVault !== undefined) result.replaceVault = input.replaceVault;
  return result;
}
