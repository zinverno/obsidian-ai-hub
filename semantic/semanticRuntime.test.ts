import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (value: string) => value,
}));
import type {
  ChunkingStrategy,
  MarkdownChunkInput,
  NoteChunk,
} from "../chunking";
import type { EmbeddingProvider } from "../embeddings/types";
import {
  IndexingProviderError,
  IndexingService,
} from "../indexing";
import type {
  IndexDocumentInput,
  MarkdownDocumentSource,
} from "../indexing";
import {
  LocalVectorStore,
} from "../vectorStore";
import type {
  VectorStorePersistence,
} from "../vectorStore";
import { LazySemanticRuntime } from "./semanticRuntime";
import { SemanticSearchService } from "./semanticSearchService";
import {
  resetSemanticStorage,
  semanticIndexBasePath,
  SEMANTIC_INDEX_ARTIFACTS,
} from "./semanticStorageMaintenance";
import { SemanticStorageError } from "./errors";

type Stored =
  | { kind: "text"; value: string }
  | { kind: "binary"; value: ArrayBuffer };

class MemoryPersistence implements VectorStorePersistence {
  readonly files = new Map<string, Stored>();
  readonly directories = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }
  async readText(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value?.kind !== "text") throw new Error("missing");
    return value.value;
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.files.get(path);
    if (value?.kind !== "binary") throw new Error("missing");
    return value.value.slice(0);
  }
  async writeText(path: string, data: string): Promise<void> {
    this.files.set(path, { kind: "text", value: data });
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, { kind: "binary", value: data.slice(0) });
  }
  async createDirectory(path: string): Promise<void> {
    this.directories.add(path);
  }
  async remove(path: string): Promise<void> {
    if (!this.files.delete(path)) throw new Error("missing");
  }
  async rename(fromPath: string, toPath: string): Promise<void> {
    const value = this.files.get(fromPath);
    if (!value) throw new Error("missing");
    this.files.set(toPath, value);
    this.files.delete(fromPath);
  }
}

class FakeProvider implements EmbeddingProvider {
  readonly id = "openai-compatible" as const;
  readonly model = "semantic-test";
  dimensionsCalls = 0;
  readonly embedCalls: string[][] = [];
  failEmbed = false;

  async dimensions(): Promise<number> {
    this.dimensionsCalls++;
    return 3;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.embedCalls.push([...texts]);
    if (this.failEmbed) {
      throw new Error(`provider body ${texts.join(" ")} sk-secret`);
    }
    return texts.map((text) => {
      const normalized = text.toLowerCase();
      if (normalized.includes("beta")) {
        return new Float32Array([0, 1, 0]);
      }
      if (normalized.includes("gamma")) {
        return new Float32Array([0, 0, 1]);
      }
      return new Float32Array([1, 0, 0]);
    });
  }
}

class OneChunkStrategy implements ChunkingStrategy {
  chunk(input: MarkdownChunkInput): NoteChunk[] {
    if (!input.content.trim()) return [];
    return [
      {
        id: `${input.path}:0`,
        path: input.path,
        headingPath: [input.path.replace(/\.md$/, "")],
        ordinal: 0,
        text: input.content,
        contentHash: `hash:${input.content}`,
        source: {
          startOffset: 0,
          endOffset: input.content.length,
          startLine: 0,
          endLine: 0,
        },
      },
    ];
  }
}

class FakeSource implements MarkdownDocumentSource {
  calls = 0;
  documents: IndexDocumentInput[] = [
    { path: "Alpha.md", content: "alpha text" },
  ];

  async readAll(): Promise<IndexDocumentInput[]> {
    this.calls++;
    return this.documents.map((document) => ({ ...document }));
  }

  async readPaths(paths: readonly string[]): Promise<{
    documents: IndexDocumentInput[];
    missingPaths: string[];
  }> {
    this.calls++;
    const requested = new Set(paths);
    const documents = this.documents
      .filter((document) => requested.has(document.path))
      .map((document) => ({ ...document }));
    const found = new Set(documents.map((document) => document.path));
    return {
      documents,
      missingPaths: paths.filter((path) => !found.has(path)),
    };
  }
}

function createIntegrationHarness() {
  const provider = new FakeProvider();
  const source = new FakeSource();
  const persistence = new MemoryPersistence();
  let initializerCalls = 0;
  let storeCreations = 0;
  let createdStore: LocalVectorStore | null = null;

  const runtime = new LazySemanticRuntime(async () => {
    initializerCalls++;
    const indexingService = new IndexingService({
      chunker: new OneChunkStrategy(),
      embeddingProvider: provider,
      embeddingSpace: {
        providerId: provider.id,
        model: provider.model,
        baseUrl: "https://example.test/v1",
      },
      vectorStoreFactory: ({ dimensions, embeddingSpaceId }) => {
        storeCreations++;
        createdStore = new LocalVectorStore({
          dimensions,
          embeddingSpaceId,
          persistence,
          basePath: ".config/plugins/ai-knowledge-hub/semantic-index",
        });
        return createdStore;
      },
    });
    await indexingService.initialize();
    const stats = indexingService.getStats();
    const vectorStore = createdStore;
    if (!vectorStore) throw new Error("store missing");
    return {
      indexingService,
      vectorStore,
      searchService: new SemanticSearchService(
        provider,
        vectorStore,
        stats.dimensions,
      ),
      source,
    };
  });

  return {
    runtime,
    provider,
    source,
    initializerCalls: () => initializerCalls,
    storeCreations: () => storeCreations,
    store: () => createdStore,
  };
}

describe("LazySemanticRuntime", () => {
  it("does no provider, storage, or source work during construction", () => {
    const harness = createIntegrationHarness();
    expect(harness.initializerCalls()).toBe(0);
    expect(harness.provider.dimensionsCalls).toBe(0);
    expect(harness.provider.embedCalls).toEqual([]);
    expect(harness.source.calls).toBe(0);
    expect(harness.runtime.getStats().initialized).toBe(false);
  });

  it("single-flights concurrent initialization and resolves dimensions once", async () => {
    const harness = createIntegrationHarness();
    await Promise.all([
      harness.runtime.initialize(),
      harness.runtime.initialize(),
      harness.runtime.initialize(),
    ]);
    expect(harness.initializerCalls()).toBe(1);
    expect(harness.provider.dimensionsCalls).toBe(1);
    expect(harness.storeCreations()).toBe(1);
  });

  it("shares one LocalVectorStore between indexing and search", async () => {
    const harness = createIntegrationHarness();
    const indexed = await harness.runtime.indexVault();
    const results = await harness.runtime.search("alpha");
    expect(indexed.chunksEmbedded).toBe(1);
    expect(results[0].path).toBe("Alpha.md");
    expect(harness.storeCreations()).toBe(1);
    expect(harness.store()?.getStats().count).toBe(1);
    expect(harness.provider.dimensionsCalls).toBe(1);
    expect(harness.provider.embedCalls).toEqual([
      ["alpha text"],
      ["alpha"],
    ]);
  });

  it("uses existing vectors for Similar Notes and duplicates without provider calls", async () => {
    const harness = createIntegrationHarness();
    const content = "alpha semantic content with enough meaningful characters";
    await harness.runtime.indexDocument({
      path: "Source.md",
      content,
    });
    await harness.runtime.indexDocument({
      path: "Near.md",
      content: `${content} again`,
    });
    const providerCalls = harness.provider.embedCalls.length;
    const generation = harness.runtime.getStats().vectorGeneration;

    const similar = await harness.runtime.findSimilarNotes("Source.md");
    const duplicates = await harness.runtime.findPotentialDuplicates();

    expect(similar.map((result) => result.path)).toEqual(["Near.md"]);
    expect(duplicates.map((pair) => [pair.leftPath, pair.rightPath])).toEqual([
      ["Near.md", "Source.md"],
    ]);
    expect(harness.provider.embedCalls).toHaveLength(providerCalls);
    expect(harness.runtime.getStats().vectorGeneration).toBe(generation);
  });

  it("uses readAll plus reconcileAll for full indexing", async () => {
    const harness = createIntegrationHarness();
    const first = await harness.runtime.indexVault();
    const second = await harness.runtime.indexVault();
    expect(harness.source.calls).toBe(2);
    expect(first.mode).toBe("reconcile");
    expect(second.documentsUnchanged).toBe(1);
    expect(second.chunksEmbedded).toBe(0);
  });

  it("indexes one document without reading or reconciling unrelated paths", async () => {
    const harness = createIntegrationHarness();
    await harness.runtime.indexDocument({
      path: "Only.md",
      content: "beta text",
    });
    expect(harness.source.calls).toBe(0);
    expect(harness.runtime.getStats().vectorCount).toBe(1);
    const results = await harness.runtime.search("beta");
    expect(results.map((result) => result.path)).toEqual(["Only.md"]);
  });

  it("clears the compatible store and reports updated stats", async () => {
    const harness = createIntegrationHarness();
    await harness.runtime.indexVault();
    const generation = harness.runtime.getStats().vectorGeneration;
    await harness.runtime.clear();
    const stats = harness.runtime.getStats();
    expect(stats.vectorCount).toBe(0);
    expect(stats.vectorGeneration).toBe(generation + 1);
    expect(stats.dimensions).toBe(3);
  });

  it("retries initialization after a failure", async () => {
    let calls = 0;
    const successful = createIntegrationHarness();
    const runtime = new LazySemanticRuntime(async () => {
      calls++;
      if (calls === 1) throw new Error("transient");
      await successful.runtime.initialize();
      const store = successful.store();
      if (!store) throw new Error("store missing");
      const provider = successful.provider;
      const indexingService = new IndexingService({
        chunker: new OneChunkStrategy(),
        embeddingProvider: provider,
        embeddingSpace: {
          providerId: provider.id,
          model: provider.model,
          baseUrl: "https://example.test/v1",
        },
        vectorStoreFactory: () => store,
      });
      await indexingService.initialize();
      return {
        indexingService,
        vectorStore: store,
        searchService: new SemanticSearchService(provider, store, 3),
        source: successful.source,
      };
    });
    await expect(runtime.initialize()).rejects.toThrow("transient");
    await expect(runtime.initialize()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it("does not expose document content when indexing provider fails", async () => {
    const harness = createIntegrationHarness();
    harness.provider.failEmbed = true;
    let caught: unknown;
    try {
      await harness.runtime.indexDocument({
        path: "Private.md",
        content: "markdown-super-secret",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IndexingProviderError);
    expect(String(caught)).not.toContain("markdown-super-secret");
    expect(String(caught)).not.toContain("sk-secret");
  });
});

describe("explicit semantic storage maintenance", () => {
  it("builds a vault-relative path from the actual config directory", () => {
    expect(
      semanticIndexBasePath(".custom-config", "ai-knowledge-hub"),
    ).toBe(
      ".custom-config/plugins/ai-knowledge-hub/semantic-index",
    );
  });

  it.each([
    "/absolute",
    "C:\\absolute",
    "../outside",
    ".config/../../outside",
  ])("rejects unsafe config path %s", (configDir) => {
    expect(() =>
      semanticIndexBasePath(configDir, "ai-knowledge-hub"),
    ).toThrow(SemanticStorageError);
  });

  it("removes only known artifacts and treats missing files as no-op", async () => {
    const base = ".config/plugins/ai-knowledge-hub/semantic-index";
    const existing = new Set([
      `${base}/${SEMANTIC_INDEX_ARTIFACTS[0]}`,
      `${base}/${SEMANTIC_INDEX_ARTIFACTS[3]}`,
      `${base}/unrelated.txt`,
    ]);
    const removed: string[] = [];
    const adapter = {
      exists: async (path: string) => existing.has(path),
      remove: async (path: string) => {
        removed.push(path);
        existing.delete(path);
      },
    } as never;
    await resetSemanticStorage(adapter, base);
    expect(removed).toEqual([
      `${base}/${SEMANTIC_INDEX_ARTIFACTS[0]}`,
      `${base}/${SEMANTIC_INDEX_ARTIFACTS[3]}`,
    ]);
    expect(existing.has(`${base}/unrelated.txt`)).toBe(true);
  });

  it("reports a safe typed partial failure", async () => {
    const base = ".config/plugins/ai-knowledge-hub/semantic-index";
    const adapter = {
      exists: async () => true,
      remove: async () => {
        throw new Error("secret adapter details");
      },
    } as never;
    let caught: unknown;
    try {
      await resetSemanticStorage(adapter, base);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SemanticStorageError);
    expect(String(caught)).not.toContain("secret adapter details");
  });
});
