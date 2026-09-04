import type { ChunkSourceRange, VaultStatus } from "../protocol/types.js";

export interface McpNoteSummary {
  path: string;
  contentHash: string;
  chunkCount: number;
}

export interface McpStoredNote {
  path: string;
  content: string;
  contentHash: string;
}

export interface McpStoredChunk {
  chunkId: string;
  path: string;
  ordinal: number;
  headingPath: string[];
  source: ChunkSourceRange;
  text: string;
}

export interface McpStoredVector {
  chunkId: string;
  path: string;
  ordinal: number;
  headingPath: string[];
  source: ChunkSourceRange;
  vector: Float32Array;
}

/** Narrow, query-only view used by MCP. It deliberately exposes no mutation method. */
export interface McpReadStorage {
  getMcpVaultStatus(vaultId: string): Promise<VaultStatus>;
  listMcpNotes(vaultId: string, prefix: string, afterPath: string, limit: number): Promise<McpNoteSummary[]>;
  getMcpNote(vaultId: string, path: string): Promise<McpStoredNote | null>;
  hasMcpNote(vaultId: string, path: string): Promise<boolean>;
  listMcpChunks(
    vaultId: string,
    path: string,
    after: { ordinal: number; chunkId: string } | null,
    limit: number,
  ): Promise<McpStoredChunk[]>;
  iterateMcpVectors(vaultId: string, dimensions: number): Iterable<McpStoredVector>;
  getMcpChunkTexts(vaultId: string, chunkIds: readonly string[]): Promise<Map<string, string>>;
}

/** Runtime capability boundary as well as a TypeScript boundary. */
export function createMcpReadView(storage: McpReadStorage): McpReadStorage {
  return Object.freeze({
    getMcpVaultStatus: storage.getMcpVaultStatus.bind(storage),
    listMcpNotes: storage.listMcpNotes.bind(storage),
    getMcpNote: storage.getMcpNote.bind(storage),
    hasMcpNote: storage.hasMcpNote.bind(storage),
    listMcpChunks: storage.listMcpChunks.bind(storage),
    iterateMcpVectors: storage.iterateMcpVectors.bind(storage),
    getMcpChunkTexts: storage.getMcpChunkTexts.bind(storage),
  });
}
