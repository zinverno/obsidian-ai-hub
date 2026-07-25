import type { ChunkSourceRange } from "../chunking/types";
import type {
  IndexDocumentInput,
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

export interface SemanticRuntimeStats {
  initialized: boolean;
  indexing: boolean;
  vectorCount: number;
  vectorGeneration: number;
  dimensions: number;
  embeddingSpaceId: string;
}

export interface SemanticRuntime {
  initialize(): Promise<void>;
  indexVault(): Promise<IndexingRunResult>;
  indexDocument(document: IndexDocumentInput): Promise<IndexingRunResult>;
  search(
    query: string,
    options?: SemanticSearchOptions,
  ): Promise<SemanticDocumentResult[]>;
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
