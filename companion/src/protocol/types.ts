export const PROTOCOL_VERSION = 1 as const;
export const PROTOCOL_HEADER = "x-companion-protocol-version";

export interface SemanticDescriptor {
  providerId: string;
  model: string;
  baseUrl: string;
  dimensions: number;
  embeddingSpaceId: string;
  normalized: true;
}

export interface ChunkSourceRange {
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}

export interface NoteManifestEntry {
  path: string;
  contentHash: string;
  chunks: Array<{ chunkId: string; contentHash: string }>;
}

export interface MirroredChunk {
  chunkId: string;
  notePath: string;
  ordinal: number;
  headingPath: string[];
  text: string;
  contentHash: string;
  source: ChunkSourceRange;
  embedding: number[];
}

export interface MirroredNote {
  path: string;
  content: string;
  contentHash: string;
  metadata: Record<string, unknown>;
  chunks: MirroredChunk[];
}

export interface ReconciliationPlanRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  generation: number;
  descriptor: SemanticDescriptor;
  notes: NoteManifestEntry[];
}

export interface ReconciliationPlanResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  generation: number;
  serverGeneration: number;
  replaceVault: boolean;
  uploadPaths: string[];
  deletePaths: string[];
  unchangedPaths: string[];
}

export type SyncOperation =
  | { type: "UPSERT"; note: MirroredNote }
  | { type: "DELETE"; path: string }
  | { type: "RENAME"; oldPath: string; note: MirroredNote };

export interface SyncBatchRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  generation: number;
  descriptor: SemanticDescriptor;
  replaceVault?: boolean;
  operations: SyncOperation[];
}

export interface SyncBatchResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  generation: number;
  applied: boolean;
  stale: boolean;
  operationsApplied: number;
}

export interface ServerStatus {
  status: "ok";
  protocolVersion: typeof PROTOCOL_VERSION;
  vaultCount: number;
}

export interface VaultStatus {
  protocolVersion: typeof PROTOCOL_VERSION;
  vaultId: string;
  exists: boolean;
  generation: number;
  noteCount: number;
  chunkCount: number;
  descriptor: SemanticDescriptor | null;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}
