import { describe, expect, it, vi } from "vitest";
import type {
  VectorChunkMetadata,
  VectorSearchOptions,
  VectorSearchResult,
  VectorStore,
  VectorStoreMutation,
  VectorStoreStats,
} from "../vectorStore/types";
import { SemanticCompatibilityError } from "./errors";
import { SemanticStoreRegistry } from "./semanticStoreRegistry";

class FakeStore implements VectorStore {
  initializeCalls = 0;
  initializeImpl: () => Promise<void> = async () => {};

  initialize(): Promise<void> {
    this.initializeCalls++;
    return this.initializeImpl();
  }
  listMetadata(): VectorChunkMetadata[] {
    return [];
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
      initialized: true,
      count: 0,
      dimensions: 3,
      embeddingSpaceId: "space-a",
      generation: 0,
      binaryBytes: 0,
    };
  }
}

function request(create: () => FakeStore, embeddingSpaceId = "space-a") {
  return {
    basePath: ".obsidian/plugins/ai-knowledge-hub/semantic-index",
    dimensions: 3,
    embeddingSpaceId,
    create,
  };
}

describe("SemanticStoreRegistry", () => {
  it("returns one object identity for one compatible basePath", () => {
    const registry = new SemanticStoreRegistry();
    const create = vi.fn(() => new FakeStore());
    const first = registry.getOrCreateStore(request(create));
    const second = registry.getOrCreateStore(request(create));
    expect(first).toBe(second);
    expect(create).toHaveBeenCalledOnce();
    expect(registry.size).toBe(1);
  });

  it("single-flights initialization on the shared store", async () => {
    const registry = new SemanticStoreRegistry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new FakeStore();
    store.initializeImpl = () => gate;
    registry.getOrCreateStore(request(() => store));
    const first = store.initialize();
    const second = store.initialize();
    expect(first).toBe(second);
    expect(store.initializeCalls).toBe(1);
    expect(registry.peek(request(() => store).basePath)?.lifecycle).toBe(
      "initializing",
    );
    release();
    await Promise.all([first, second]);
    expect(registry.peek(request(() => store).basePath)?.lifecycle).toBe(
      "ready",
    );
  });

  it("rejects an incompatible storage identity without creating a store", () => {
    const registry = new SemanticStoreRegistry();
    registry.getOrCreateStore(request(() => new FakeStore()));
    const incompatibleCreate = vi.fn(() => new FakeStore());
    expect(() =>
      registry.getOrCreateStore(request(incompatibleCreate, "space-b")),
    ).toThrow(SemanticCompatibilityError);
    expect(incompatibleCreate).not.toHaveBeenCalled();
    expect(registry.size).toBe(1);
  });

  it("evicts a failed initialization and permits a fresh retry", async () => {
    const registry = new SemanticStoreRegistry();
    const failed = new FakeStore();
    failed.initializeImpl = async () => {
      throw new Error("failed");
    };
    const first = registry.getOrCreateStore(request(() => failed));
    await expect(first.initialize()).rejects.toThrow("failed");
    expect(registry.size).toBe(0);

    const recovered = new FakeStore();
    const second = registry.getOrCreateStore(request(() => recovered));
    expect(second).not.toBe(first);
    await expect(second.initialize()).resolves.toBeUndefined();
    expect(registry.size).toBe(1);
  });

  it("evicts an initializer that throws synchronously", async () => {
    const registry = new SemanticStoreRegistry();
    const failed = new FakeStore();
    failed.initializeImpl = () => {
      throw new Error("synchronous failure");
    };
    const first = registry.getOrCreateStore(request(() => failed));
    await expect(first.initialize()).rejects.toThrow("synchronous failure");
    expect(registry.size).toBe(0);

    const recovered = registry.getOrCreateStore(
      request(() => new FakeStore()),
    );
    await expect(recovered.initialize()).resolves.toBeUndefined();
    expect(registry.size).toBe(1);
  });

  it("deletes only the normalized requested entry", () => {
    const registry = new SemanticStoreRegistry();
    const store = registry.getOrCreateStore(request(() => new FakeStore()));
    expect(registry.delete(".obsidian//plugins/ai-knowledge-hub/semantic-index/"))
      .toBe(true);
    expect(registry.size).toBe(0);
    const replacement = registry.getOrCreateStore(
      request(() => new FakeStore()),
    );
    expect(replacement).not.toBe(store);
  });
});
