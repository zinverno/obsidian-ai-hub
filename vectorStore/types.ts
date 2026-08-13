import type { ChunkSourceRange } from "../chunking/types";

export interface VectorChunkMetadata {
  id: string;
  path: string;
  headingPath: string[];
  ordinal: number;
  contentHash: string;
  source: ChunkSourceRange;
  preview?: string;
}

export interface VectorEntry extends VectorChunkMetadata {
  vector: Float32Array;
}

export interface VectorSearchOptions {
  limit: number;
  /** Inclusive bound; above 1 matches none, below -1 admits all cosine scores. */
  minScore?: number;
  excludeIds?: readonly string[];
  excludePaths?: readonly string[];
}

export interface VectorSearchResult extends VectorChunkMetadata {
  score: number;
}

export interface VectorStoreMutation {
  deleteIds?: readonly string[];
  deletePaths?: readonly string[];
  upserts?: readonly VectorEntry[];
}

export interface VectorStoreStats {
  initialized: boolean;
  count: number;
  dimensions: number;
  embeddingSpaceId: string;
  generation: number;
  binaryBytes: number;
}

/**
 * Isolated, row-aligned view of one committed store generation.
 *
 * Implementations must return defensive copies: callers may retain or mutate
 * this value without observing a later commit or changing store state.
 */
export interface VectorStoreSnapshot {
  generation: number;
  dimensions: number;
  embeddingSpaceId: string;
  metadata: VectorChunkMetadata[];
  vectors: Float32Array;
}

export interface VectorStore {
  initialize: (this: VectorStore) => Promise<void>;

  listMetadata(): VectorChunkMetadata[];

  readSnapshot(): VectorStoreSnapshot;

  /**
   * Applies one durable mutation. An empty mutation is still a successful
   * snapshot commit and advances generation.
   */
  applyChanges(mutation: VectorStoreMutation): Promise<void>;

  search(
    query: Float32Array,
    options: VectorSearchOptions,
  ): Promise<VectorSearchResult[]>;

  clear(): Promise<void>;

  getStats(): VectorStoreStats;
}

/**
 * Platform-neutral persistence operations used by LocalVectorStore.
 *
 * Paths are normalized vault-relative paths. `rename` receives the source
 * first and the destination second. `createDirectory` must be idempotent.
 */
export interface VectorStorePersistence {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeText(path: string, data: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  createDirectory(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(fromPath: string, toPath: string): Promise<void>;
}

export interface LocalVectorStoreOptions {
  dimensions: number;
  embeddingSpaceId: string;
  persistence: VectorStorePersistence;
  basePath: string;
}

export interface VectorStoreManifest {
  schemaVersion: number;
  generation: number;
  dimensions: number;
  embeddingSpaceId: string;
  normalized: true;
  count: number;
  binaryFile: string;
  records: VectorChunkMetadata[];
}
