import { validateVaultPath } from "../protocol/schemas.js";
import type { SemanticDescriptor } from "../protocol/types.js";
import type { McpReadStorage } from "../storage/mcpReadStorage.js";
import { McpToolError } from "./errors.js";
import { boundedHeadings } from "./bounds.js";
import { chunksCursor, notesCursor, parseChunksCursor, parseNotesCursor } from "./pagination.js";
import type { McpSearchResult } from "./semanticSearch.js";
import type { SemanticSearchService } from "./semanticSearch.js";

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;
export const DEFAULT_CHUNK_LIMIT = 20;
export const MAX_CHUNK_LIMIT = 50;
export const MAX_CHUNK_TEXT_CODE_POINTS = 8000;
export const DEFAULT_NOTE_MAX_CHARS = 12_000;
export const MAX_NOTE_MAX_CHARS = 50_000;
export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 20;
export const MAX_QUERY_CODE_POINTS = 2000;

export const UNTRUSTED_VAULT_DATA = "untrusted-vault-data" as const;

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) {
    throw new McpToolError("INVALID_ARGUMENT", `${label} must be a positive integer not greater than ${maximum}.`);
  }
  return result;
}

function validatePrefix(value: string): string {
  if (value === "") return value;
  const parts = value.split("/");
  const trailingSlash = parts.at(-1) === "";
  const segments = trailingSlash ? parts.slice(0, -1) : parts;
  if (
    value !== value.trim() ||
    value.length > 4096 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    segments.some((part) => !part || part === "." || part === "..")
  ) {
    throw new McpToolError("INVALID_ARGUMENT", "prefix must be a canonical vault-relative path prefix.");
  }
  return value;
}

function boundedChunkText(text: string): { text: string; totalTextChars: number; textTruncated: boolean } {
  const codePoints = Array.from(text);
  return {
    text: codePoints.slice(0, MAX_CHUNK_TEXT_CODE_POINTS).join(""),
    totalTextChars: codePoints.length,
    textTruncated: codePoints.length > MAX_CHUNK_TEXT_CODE_POINTS,
  };
}

export interface VaultStatusOutput {
  dataTrust: typeof UNTRUSTED_VAULT_DATA;
  exists: boolean;
  generation: number;
  noteCount: number;
  chunkCount: number;
  descriptor: SemanticDescriptor | null;
}

export class VaultMcpService {
  private readonly semanticSearch: SemanticSearchService;

  constructor(
    private readonly storage: McpReadStorage,
    private readonly vaultId: string,
    semanticSearch: SemanticSearchService,
  ) {
    this.semanticSearch = semanticSearch;
  }

  async vaultStatus(): Promise<VaultStatusOutput> {
    const status = await this.storage.getMcpVaultStatus(this.vaultId);
    return {
      dataTrust: UNTRUSTED_VAULT_DATA,
      exists: status.exists,
      generation: status.generation,
      noteCount: status.noteCount,
      chunkCount: status.chunkCount,
      descriptor: status.descriptor ? { ...status.descriptor } : null,
    };
  }

  async listNotes(input: { prefix?: string | undefined; limit?: number | undefined; cursor?: string | undefined }): Promise<{
    dataTrust: typeof UNTRUSTED_VAULT_DATA;
    notes: Array<{ path: string; contentHash: string; chunkCount: number }>;
    nextCursor: string | null;
  }> {
    const prefix = validatePrefix(input.prefix ?? "");
    const limit = boundedPositiveInteger(input.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, "limit");
    const afterPath = parseNotesCursor(input.cursor, prefix);
    const rows = await this.storage.listMcpNotes(this.vaultId, prefix, afterPath, limit + 1);
    const hasMore = rows.length > limit;
    const notes = rows.slice(0, limit);
    const last = notes.at(-1);
    return {
      dataTrust: UNTRUSTED_VAULT_DATA,
      notes,
      nextCursor: hasMore && last ? notesCursor(prefix, last.path) : null,
    };
  }

  async getNote(input: { path: string; startOffset?: number | undefined; maxChars?: number | undefined }): Promise<{
    dataTrust: typeof UNTRUSTED_VAULT_DATA;
    path: string;
    content: string;
    contentHash: string;
    startOffset: number;
    endOffset: number;
    totalChars: number;
    truncated: boolean;
  }> {
    const path = validateVaultPath(input.path);
    const note = await this.storage.getMcpNote(this.vaultId, path);
    if (!note) throw new McpToolError("NOTE_NOT_FOUND", "The requested note does not exist in the configured Vault mirror.");
    const codePoints = Array.from(note.content);
    const requestedStart = input.startOffset ?? 0;
    if (!Number.isSafeInteger(requestedStart) || requestedStart < 0) {
      throw new McpToolError("INVALID_ARGUMENT", "startOffset must be a non-negative integer.");
    }
    const startOffset = Math.min(requestedStart, codePoints.length);
    const maxChars = boundedPositiveInteger(input.maxChars, DEFAULT_NOTE_MAX_CHARS, MAX_NOTE_MAX_CHARS, "maxChars");
    const endOffset = Math.min(codePoints.length, startOffset + maxChars);
    return {
      dataTrust: UNTRUSTED_VAULT_DATA,
      path: note.path,
      content: codePoints.slice(startOffset, endOffset).join(""),
      contentHash: note.contentHash,
      startOffset,
      endOffset,
      totalChars: codePoints.length,
      truncated: startOffset > 0 || endOffset < codePoints.length,
    };
  }

  async getChunks(input: { path: string; limit?: number | undefined; cursor?: string | undefined }): Promise<{
    dataTrust: typeof UNTRUSTED_VAULT_DATA;
    chunks: Array<{
      chunkId: string;
      path: string;
      ordinal: number;
      headingPath: string[];
      headingPathTruncated: boolean;
      totalHeadings: number;
      source: { startOffset: number; endOffset: number; startLine: number; endLine: number };
      text: string;
      totalTextChars: number;
      textTruncated: boolean;
    }>;
    nextCursor: string | null;
  }> {
    const path = validateVaultPath(input.path);
    if (!await this.storage.hasMcpNote(this.vaultId, path)) {
      throw new McpToolError("NOTE_NOT_FOUND", "The requested note does not exist in the configured Vault mirror.");
    }
    const limit = boundedPositiveInteger(input.limit, DEFAULT_CHUNK_LIMIT, MAX_CHUNK_LIMIT, "limit");
    const after = parseChunksCursor(input.cursor, path);
    const rows = await this.storage.listMcpChunks(this.vaultId, path, after, limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      dataTrust: UNTRUSTED_VAULT_DATA,
      chunks: page.map((chunk) => ({
        chunkId: chunk.chunkId,
        path: chunk.path,
        ordinal: chunk.ordinal,
        ...boundedHeadings(chunk.headingPath),
        source: { ...chunk.source },
        ...boundedChunkText(chunk.text),
      })),
      nextCursor: hasMore && last ? chunksCursor(path, last.ordinal, last.chunkId) : null,
    };
  }

  async searchVault(input: { query: string; limit?: number | undefined }): Promise<{
    dataTrust: typeof UNTRUSTED_VAULT_DATA;
    results: McpSearchResult[];
  }> {
    const query = input.query.trim();
    if (!query || query.includes("\0") || Array.from(query).length > MAX_QUERY_CODE_POINTS) {
      throw new McpToolError("INVALID_ARGUMENT", `query must contain 1 to ${MAX_QUERY_CODE_POINTS} Unicode code points and no NUL.`);
    }
    const limit = boundedPositiveInteger(input.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, "limit");
    const results = await this.semanticSearch.search(this.vaultId, query, limit);
    return { dataTrust: UNTRUSTED_VAULT_DATA, results };
  }
}
