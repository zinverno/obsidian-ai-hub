import type {
  VectorSearchOptions,
  VectorSearchResult,
  VectorStore,
  VectorStoreMutation,
  VectorStoreStats,
} from "./types";

/**
 * Deliberately permissive disabled-mode implementation. All operations are
 * no-ops and search is empty, even when initialize was not called.
 */
export class NullVectorStore implements VectorStore {
  private initialized = false;

  constructor(
    private readonly dimensions = 0,
    private readonly embeddingSpaceId = "disabled",
  ) {}

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async applyChanges(_mutation: VectorStoreMutation): Promise<void> {}

  async search(
    _query: Float32Array,
    _options: VectorSearchOptions,
  ): Promise<VectorSearchResult[]> {
    return [];
  }

  async clear(): Promise<void> {}

  getStats(): VectorStoreStats {
    return {
      initialized: this.initialized,
      count: 0,
      dimensions: this.dimensions,
      embeddingSpaceId: this.embeddingSpaceId,
      generation: 0,
      binaryBytes: 0,
    };
  }
}
