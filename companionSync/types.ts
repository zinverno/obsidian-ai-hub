export const COMPANION_PROTOCOL_VERSION = 1 as const;
export const COMPANION_PROTOCOL_HEADER = "x-companion-protocol-version";

export interface CompanionSettings {
  enabled: boolean;
  endpoint: string;
  token: string;
  timeoutMs: number;
  vaultId: string;
}

export interface CompanionSemanticDescriptor {
  providerId: string;
  model: string;
  baseUrl: string;
  dimensions: number;
  embeddingSpaceId: string;
  normalized: true;
}

export interface CompanionChunk {
  chunkId: string;
  notePath: string;
  ordinal: number;
  headingPath: string[];
  text: string;
  contentHash: string;
  source: {
    startOffset: number;
    endOffset: number;
    startLine: number;
    endLine: number;
  };
  embedding: number[];
}

export interface CompanionNote {
  path: string;
  content: string;
  contentHash: string;
  metadata: Record<string, unknown>;
  chunks: CompanionChunk[];
}

export interface CompanionSnapshot {
  generation: number;
  descriptor: CompanionSemanticDescriptor;
  notes: CompanionNote[];
}

export interface CompanionReconciliationPlan {
  protocolVersion: typeof COMPANION_PROTOCOL_VERSION;
  generation: number;
  serverGeneration: number;
  replaceVault: boolean;
  uploadPaths: string[];
  deletePaths: string[];
  unchangedPaths: string[];
}

export type CompanionSyncOperation =
  | { type: "UPSERT"; note: CompanionNote }
  | { type: "DELETE"; path: string }
  | { type: "RENAME"; oldPath: string; note: CompanionNote };

export interface CompanionSyncBatch {
  protocolVersion: typeof COMPANION_PROTOCOL_VERSION;
  generation: number;
  descriptor: CompanionSemanticDescriptor;
  replaceVault?: boolean;
  operations: CompanionSyncOperation[];
}

export interface CompanionSyncBatchResult {
  protocolVersion: typeof COMPANION_PROTOCOL_VERSION;
  generation: number;
  applied: boolean;
  stale: boolean;
  operationsApplied: number;
}

export interface CompanionServerStatus {
  status: "ok";
  protocolVersion: typeof COMPANION_PROTOCOL_VERSION;
  vaultCount: number;
}

export interface CompanionConnectionStatus {
  kind: "disabled" | "idle" | "syncing" | "ready" | "error";
  code?: string;
  lastSuccessAt?: number;
}

export interface CompanionIncrementalChange {
  snapshot: CompanionSnapshot;
  deletePaths: readonly string[];
  renames?: readonly { oldPath: string; newPath: string }[];
}
