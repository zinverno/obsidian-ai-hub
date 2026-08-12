import type { ChunkSourceRange } from "../chunking/types";
import type {
  IndexDocumentInput,
  IndexingExecutionOptions,
  IndexingRunResult,
} from "../indexing/types";

export interface SemanticSearchOptions {
  limit?: number;
  minScore?: number;
  matchesPerDocument?: number;
  excludePaths?: readonly string[];
}

export interface SemanticChunkMatch {
  id: string;
  path: string;
  headingPath: string[];
  ordinal: number;
  preview?: string;
  source: ChunkSourceRange;
  score: number;
}

export interface SemanticDocumentResult {
  path: string;
  score: number;
  matches: SemanticChunkMatch[];
}

export interface SemanticSimilarNotesOptions {
  limit?: number;
  matchesPerDocument?: number;
}

/** Document-centroid similarity with chunk-level evidence for navigation. */
export interface SemanticDocumentSimilarity {
  path: string;
  score: number;
  matches: SemanticChunkMatch[];
}

export interface SemanticDuplicateOptions {
  limit?: number;
  matchesPerDocument?: number;
}

export interface SemanticDuplicatePair {
  leftPath: string;
  rightPath: string;
  score: number;
  leftMatches: SemanticChunkMatch[];
  rightMatches: SemanticChunkMatch[];
}

export interface SemanticRuntimeStats {
  initialized: boolean;
  indexing: boolean;
  vectorCount: number;
  vectorGeneration: number;
  dimensions: number;
  embeddingSpaceId: string;
}

export interface SemanticPathChanges {
  upsertPaths: readonly string[];
  deletePaths: readonly string[];
}

export interface SemanticRuntime {
  initialize(): Promise<void>;
  indexVault(options?: IndexingExecutionOptions): Promise<IndexingRunResult>;
  indexDocument(document: IndexDocumentInput): Promise<IndexingRunResult>;
  syncPaths(
    changes: SemanticPathChanges,
    options?: IndexingExecutionOptions,
  ): Promise<IndexingRunResult>;
  search(
    query: string,
    options?: SemanticSearchOptions,
  ): Promise<SemanticDocumentResult[]>;
  /**
   * Rejects with SemanticSourceNotIndexedError when a non-empty compatible
   * index does not contain the requested source; UI boundaries render that
   * typed domain rejection as a controlled localized state.
   */
  findSimilarNotes(
    sourcePath: string,
    options?: SemanticSimilarNotesOptions,
  ): Promise<SemanticDocumentSimilarity[]>;
  findPotentialDuplicates(
    options?: SemanticDuplicateOptions,
  ): Promise<SemanticDuplicatePair[]>;
  clear(): Promise<void>;
  getStats(): SemanticRuntimeStats;
}

export type SemanticStatusKind =
  | "disabled"
  | "not-initialized"
  | "initializing"
  | "ready"
  | "indexing"
  | "incompatible"
  | "error";

export interface SemanticStatus {
  kind: SemanticStatusKind;
  vectorCount: number;
  vectorGeneration: number;
  dimensions: number;
  providerLabel: string;
  model: string;
}
