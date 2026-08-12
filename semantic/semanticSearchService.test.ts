import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "../embeddings/types";
import type {
  VectorChunkMetadata,
  VectorSearchOptions,
  VectorSearchResult,
  VectorStore,
  VectorStoreMutation,
  VectorStoreStats,
} from "../vectorStore";
import {
  SemanticProviderError,
  SemanticValidationError,
} from "./errors";
import {
  MAX_QUERY_CODE_POINTS,
  SemanticSearchService,
} from "./semanticSearchService";

class FakeProvider implements EmbeddingProvider {
  readonly id = "openai-compatible" as const;
  readonly model = "test";
  readonly calls: string[][] = [];
  result: unknown = [new Float32Array([1, 0, 0])];

  async dimensions(): Promise<number> {
    return 3;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls.push([...texts]);
    if (this.result instanceof Error) throw this.result;
    return this.result as Float32Array[];
  }
}

class FakeStore implements VectorStore {
  results: VectorSearchResult[] = [];
  count = 1;
  lastQuery: Float32Array | null = null;
  lastOptions: VectorSearchOptions | null = null;

  async initialize(): Promise<void> {}
  listMetadata(): VectorChunkMetadata[] {
    return [];
  }
  readSnapshot() {
    return {
      generation: 1,
      dimensions: 3,
      embeddingSpaceId: "test",
      metadata: [],
      vectors: new Float32Array(0),
    };
  }
  async applyChanges(_mutation: VectorStoreMutation): Promise<void> {}
  async search(
    query: Float32Array,
    options: VectorSearchOptions,
  ): Promise<VectorSearchResult[]> {
    this.lastQuery = query;
    this.lastOptions = {
      ...options,
      excludePaths: [...(options.excludePaths ?? [])],
    };
    return this.results.slice(0, options.limit);
  }
  async clear(): Promise<void> {}
  getStats(): VectorStoreStats {
    return {
      initialized: true,
      count: this.count,
      dimensions: 3,
      embeddingSpaceId: "test",
      generation: 1,
      binaryBytes: 0,
    };
  }
}

function match(
  id: string,
  path: string,
  score: number,
  ordinal = 0,
): VectorSearchResult {
  return {
    id,
    path,
    headingPath: ["Root", id],
    ordinal,
    contentHash: `hash-${id}`,
    source: {
      startOffset: ordinal,
      endOffset: ordinal + 1,
      startLine: ordinal,
      endLine: ordinal,
    },
    preview: `preview ${id}`,
    score,
  };
}

function harness() {
  const provider = new FakeProvider();
  const store = new FakeStore();
  const service = new SemanticSearchService(provider, store, 3);
  return { provider, store, service };
}

describe("SemanticSearchService construction and validation", () => {
  it("rejects invalid dependencies and dimensions", () => {
    const provider = new FakeProvider();
    const store = new FakeStore();
    expect(
      () => new SemanticSearchService(null as never, store, 3),
    ).toThrow(SemanticValidationError);
    expect(
      () => new SemanticSearchService(provider, null as never, 3),
    ).toThrow(SemanticValidationError);
    expect(() => new SemanticSearchService(provider, store, 0)).toThrow(
      SemanticValidationError,
    );
  });

  it.each([
    ["", {}],
    [" \n\t ", {}],
    ["bad\0query", {}],
    ["ok", { limit: 0 }],
    ["ok", { limit: 101 }],
    ["ok", { matchesPerDocument: 0 }],
    ["ok", { minScore: Number.NaN }],
    ["ok", { excludePaths: "x" as never }],
    ["ok", { excludePaths: ["/absolute.md"] }],
    ["ok", { excludePaths: ["a/../b.md"] }],
  ])("rejects invalid query/options %#", async (query, options) => {
    const { service } = harness();
    await expect(service.search(query, options)).rejects.toBeInstanceOf(
      SemanticValidationError,
    );
  });

  it("rejects a query above the code-point limit without truncation", async () => {
    const { provider, service } = harness();
    await expect(
      service.search("😀".repeat(MAX_QUERY_CODE_POINTS + 1)),
    ).rejects.toBeInstanceOf(SemanticValidationError);
    expect(provider.calls).toEqual([]);
  });

  it("embeds exactly the trimmed query and snapshots excludes", async () => {
    const { provider, store, service } = harness();
    store.results = [match("a", "A.md", 1)];
    const excludes = ["Other.md"];
    const pending = service.search("  exact query \n", {
      excludePaths: excludes,
    });
    excludes[0] = "Changed.md";
    await pending;
    expect(provider.calls).toEqual([["exact query"]]);
    expect(store.lastOptions?.excludePaths).toEqual(["Other.md"]);
  });
});

describe("SemanticSearchService provider contract", () => {
  it.each([
    null,
    [],
    [new Float32Array([1, 0, 0]), new Float32Array([0, 1, 0])],
    [[1, 0, 0]],
    [new Float32Array([1, 0])],
    [new Float32Array([Number.NaN, 0, 0])],
    [new Float32Array([Number.POSITIVE_INFINITY, 0, 0])],
    [new Float32Array([0, 0, 0])],
  ])("wraps malformed provider output %#", async (output) => {
    const { provider, service } = harness();
    provider.result = output;
    await expect(service.search("secret query")).rejects.toBeInstanceOf(
      SemanticProviderError,
    );
  });

  it("redacts provider rejection details from its public message", async () => {
    const { provider, service } = harness();
    provider.result = new Error(
      "Authorization Bearer sk-secret response-body secret query",
    );
    let caught: unknown;
    try {
      await service.search("secret query");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SemanticProviderError);
    expect(String(caught)).not.toContain("secret");
    expect(String(caught)).not.toContain("Authorization");
    expect(String(caught)).not.toContain("response-body");
    expect((caught as SemanticProviderError).cause).toBeUndefined();
  });

  it("copies a subarray before passing it to the store", async () => {
    const { provider, store, service } = harness();
    const shared = new Float32Array([9, 1, 0, 0, 9]);
    provider.result = [shared.subarray(1, 4)];
    store.results = [match("a", "A.md", 1)];
    await service.search("copy");
    expect(store.lastQuery).toEqual(new Float32Array([1, 0, 0]));
    expect(store.lastQuery?.buffer).not.toBe(shared.buffer);
  });

  it("copies provider output before an asynchronously observed mutation", async () => {
    const { provider, store, service } = harness();
    const vector = new Float32Array([1, 0, 0]);
    provider.result = [vector];
    store.results = [match("a", "A.md", 1)];
    const searchSpy = vi
      .spyOn(store, "search")
      .mockImplementation(async (query, options) => {
        vector[0] = 0;
        vector[1] = 1;
        store.lastQuery = new Float32Array(query);
        store.lastOptions = options;
        return store.results;
      });
    await service.search("copy");
    expect(searchSpy).toHaveBeenCalledOnce();
    expect(store.lastQuery).toEqual(new Float32Array([1, 0, 0]));
  });
});

describe("SemanticSearchService document grouping", () => {
  it("returns an empty store without a provider request", async () => {
    const { provider, store, service } = harness();
    store.count = 0;
    await expect(service.search("anything")).resolves.toEqual([]);
    expect(provider.calls).toEqual([]);
  });

  it("groups chunks by path with max score and bounded matches", async () => {
    const { store, service } = harness();
    store.count = 5;
    store.results = [
      match("a1", "A.md", 0.9, 0),
      match("a2", "A.md", 0.8, 1),
      match("b1", "B.md", 0.7, 0),
      match("a3", "A.md", 0.6, 2),
      match("a4", "A.md", 0.5, 3),
    ];
    const result = await service.search("query", {
      matchesPerDocument: 2,
    });
    expect(result.map((item) => [item.path, item.score])).toEqual([
      ["A.md", 0.9],
      ["B.md", 0.7],
    ]);
    expect(result[0].matches.map((item) => item.id)).toEqual(["a1", "a2"]);
    expect(store.lastOptions?.limit).toBe(5);
  });

  it("fills the document limit even when one path owns top chunks", async () => {
    const { store, service } = harness();
    store.count = 8;
    store.results = [
      match("a1", "A.md", 1),
      match("a2", "A.md", 0.99),
      match("a3", "A.md", 0.98),
      match("a4", "A.md", 0.97),
      match("b", "B.md", 0.7),
      match("c", "C.md", 0.6),
      match("d", "D.md", 0.5),
      match("e", "E.md", 0.4),
    ];
    const result = await service.search("query", { limit: 4 });
    expect(result.map((item) => item.path)).toEqual([
      "A.md",
      "B.md",
      "C.md",
      "D.md",
    ]);
    expect(store.lastOptions?.limit).toBe(8);
  });

  it("uses UTF-16 path order for deterministic score ties", async () => {
    const { store, service } = harness();
    store.count = 3;
    store.results = [
      match("z", "z.md", 0.5),
      match("upper", "A.md", 0.5),
      match("lower", "a.md", 0.5),
    ];
    const result = await service.search("query");
    expect(result.map((item) => item.path)).toEqual([
      "A.md",
      "a.md",
      "z.md",
    ]);
  });

  it("passes negative minScore and excludes through unchanged", async () => {
    const { store, service } = harness();
    store.results = [match("a", "A.md", -0.25)];
    const result = await service.search("query", {
      minScore: -0.5,
      excludePaths: ["Excluded.md"],
    });
    expect(result[0].score).toBe(-0.25);
    expect(store.lastOptions).toMatchObject({
      minScore: -0.5,
      excludePaths: ["Excluded.md"],
    });
  });

  it("returns deep defensive copies without vectors", async () => {
    const { store, service } = harness();
    store.results = [match("a", "A.md", 0.9)];
    const first = await service.search("query");
    expect(first[0].matches[0]).not.toHaveProperty("vector");
    first[0].matches[0].headingPath[0] = "mutated";
    first[0].matches[0].source.startLine = 99;
    const second = await service.search("query");
    expect(second[0].matches[0].headingPath[0]).toBe("Root");
    expect(second[0].matches[0].source.startLine).toBe(0);
  });
});
