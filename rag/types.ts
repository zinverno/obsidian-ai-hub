import type { ChunkSourceRange } from "../chunking/types";

export interface RagSource {
  readonly id: string;
  readonly path: string;
  readonly headingPath: readonly string[];
  readonly chunkId: string;
  readonly contentHash: string;
  readonly source: Readonly<ChunkSourceRange>;
  readonly score: number;
  readonly text: string;
}

/** Fully materialized, immutable request context used after retrieval ends. */
export interface RagContext {
  readonly sources: readonly RagSource[];
  readonly usedCodePoints: number;
}

export interface RagContextBuildOptions {
  candidateDocumentLimit?: number;
  candidateChunksPerDocument?: number;
  maxDocuments?: number;
  maxChunksPerDocument?: number;
  maxContextCodePoints?: number;
}

export interface RagAskCallbacks {
  onContext?: (context: RagContext) => void;
  onToken?: (token: string) => void;
}

export interface RagGenerationRequest {
  system: string;
  user: string;
  onToken: (token: string) => void;
  signal?: AbortSignal;
}

export type RagGenerator = (request: RagGenerationRequest) => Promise<void>;

export interface RagAskOptions extends RagAskCallbacks {
  generate: RagGenerator;
  signal?: AbortSignal;
}

export interface RagAskResult {
  readonly answer: string;
  readonly context: RagContext;
  readonly citedSourceIds: readonly string[];
  readonly unknownCitationIds: readonly string[];
}
