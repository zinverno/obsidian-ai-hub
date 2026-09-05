import type { SemanticDescriptor } from "../protocol/types.js";
import type { SearchSnapshot } from "../storage/mcpReadStorage.js";

export interface VectorCandidate { chunkId: string; score: number }
export interface SearchContext { snapshot: SearchSnapshot; queryVector: Float32Array }
export interface VectorSearchBackend { search(context: SearchContext, limit: number): Promise<VectorCandidate[]> }
export interface DerivedVectorBackend extends VectorSearchBackend {
  available(snapshot: SearchSnapshot): boolean;
  invalidate(): void;
  recordBackend(backend: "sqlite" | "qdrant"): void;
}
export function compareCandidates(left: VectorCandidate, right: VectorCandidate): number {
  if (right.score !== left.score) return right.score - left.score;
  return left.chunkId < right.chunkId ? -1 : left.chunkId > right.chunkId ? 1 : 0;
}
export function sameSpace(left: SemanticDescriptor | null, right: SemanticDescriptor | null): boolean {
  if (!left || !right) return left === right;
  return left.providerId === right.providerId && left.model === right.model && left.baseUrl === right.baseUrl &&
    left.dimensions === right.dimensions && left.embeddingSpaceId === right.embeddingSpaceId && left.normalized === right.normalized;
}
export function sameSnapshot(left: SearchSnapshot, right: SearchSnapshot): boolean {
  return left.vaultId === right.vaultId && left.generation === right.generation && left.revision === right.revision &&
    left.exists === right.exists && left.chunkCount === right.chunkCount && sameSpace(left.descriptor, right.descriptor);
}
