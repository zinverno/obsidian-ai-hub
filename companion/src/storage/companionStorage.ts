import type {
  MirroredNote,
  NoteManifestEntry,
  ReconciliationPlanResponse,
  SemanticDescriptor,
  SyncBatchRequest,
  SyncBatchResponse,
  VaultStatus,
} from "../protocol/types.js";

export interface StoredVaultSnapshot {
  vaultId: string;
  generation: number;
  descriptor: SemanticDescriptor;
  notes: MirroredNote[];
}

export interface CommitNotice {
  vaultId: string;
  generation: number;
  previousRevision: number;
  revision: number;
  replaceVault: boolean;
  paths: readonly string[];
}

export interface CompanionStorage {
  subscribeCommits(listener: (notice: CommitNotice) => void): () => void;
  initialize(): Promise<void>;
  close(): Promise<void>;
  getServerStatus(): Promise<{ vaultCount: number }>;
  getVaultStatus(vaultId: string): Promise<VaultStatus>;
  planReconciliation(
    vaultId: string,
    generation: number,
    descriptor: SemanticDescriptor,
    notes: readonly NoteManifestEntry[],
  ): Promise<ReconciliationPlanResponse>;
  applyBatch(vaultId: string, batch: SyncBatchRequest): Promise<SyncBatchResponse>;
  readVault(vaultId: string): Promise<StoredVaultSnapshot | null>;
}
