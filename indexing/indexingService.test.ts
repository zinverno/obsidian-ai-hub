import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (value: string) => value,
}));

import { MarkdownChunker } from "../chunking";
import type {
  ChunkingStrategy,
  MarkdownChunkInput,
  NoteChunk,
} from "../chunking";
import type { EmbeddingProvider } from "../embeddings/types";
import {
  LocalVectorStore,
  VectorStoreCompatibilityError,
  VectorStorePersistenceError,
} from "../vectorStore";
import type {
  VectorChunkMetadata,
  VectorStore,
  VectorStoreMutation,
  VectorStorePersistence,
  VectorStoreStats,
} from "../vectorStore";
import {
  buildEmbeddingSpaceId,
  normalizeEmbeddingBaseUrl,
} from "./embeddingSpace";
import {
  IndexingCompatibilityError,
  IndexingNotInitializedError,
  IndexingProviderContractError,
  IndexingProviderError,
  IndexingSourceError,
  IndexingValidationError,
} from "./errors";
import { IndexingService } from "./indexingService";
import { ObsidianMarkdownDocumentSource } from "./obsidianDocumentSource";
import { createObsidianIndexingService } from "./obsidianFactory";
import type {
  IndexDocumentInput,
  IndexingServiceOptions,
} from "./types";

const BASE = ".config/plugins/ai-knowledge-hub/semantic-index";

type StoredValue =
  | { kind: "text"; value: string }
  | { kind: "binary"; value: ArrayBuffer };

class MemoryPersistence implements VectorStorePersistence {
  readonly files = new Map<string, StoredValue>();
  readonly directories = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async readText(path: string): Promise<string> {
    const stored = this.files.get(path);
    if (stored?.kind !== "text") throw new Error("missing text");
    return stored.value;
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const stored = this.files.get(path);
    if (stored?.kind !== "binary") throw new Error("missing binary");
    return stored.value.slice(0);
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
    if (!this.files.delete(path)) throw new Error("missing file");
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    const stored = this.files.get(fromPath);
    if (!stored) throw new Error("missing source");
    this.files.set(toPath, stored);
    this.files.delete(fromPath);
  }
}

class RecordingVectorStore implements VectorStore {
  readonly mutations: VectorStoreMutation[] = [];
  failNextMutation: Error | null = null;

  constructor(readonly delegate: LocalVectorStore) {}

  initialize(): Promise<void> {
    return this.delegate.initialize();
  }

  listMetadata(): VectorChunkMetadata[] {
    return this.delegate.listMetadata();
  }

  async applyChanges(mutation: VectorStoreMutation): Promise<void> {
    this.mutations.push({
      deletePaths: [...(mutation.deletePaths ?? [])],
      deleteIds: [...(mutation.deleteIds ?? [])],
      upserts: (mutation.upserts ?? []).map((entry) => ({
        ...entry,
        headingPath: [...entry.headingPath],
        source: { ...entry.source },
        vector: new Float32Array(entry.vector),
      })),
    });
    if (this.failNextMutation) {
      const error = this.failNextMutation;
      this.failNextMutation = null;
      throw error;
    }
    await this.delegate.applyChanges(mutation);
  }

  search(query: Float32Array, options: { limit: number }) {
    return this.delegate.search(query, options);
  }

  clear(): Promise<void> {
    return this.delegate.clear();
  }

  getStats(): VectorStoreStats {
    return this.delegate.getStats();
  }
}

class FakeProvider implements EmbeddingProvider {
  readonly id = "openai-compatible" as const;
  readonly model = "test-model";
  dimensionsCalls = 0;
  readonly embedCalls: string[][] = [];
  dimensionsImpl: () => Promise<number> = async () => 3;
  embedImpl: (texts: string[]) => Promise<Float32Array[]> = async (texts) =>
    texts.map((text) => vectorForText(text));

  async dimensions(): Promise<number> {
    this.dimensionsCalls++;
    return this.dimensionsImpl();
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.embedCalls.push([...texts]);
    return this.embedImpl(texts);
  }
}

class FakeChunker implements ChunkingStrategy {
  readonly calls: Array<{
    path: string;
    content: string;
    cachedHeading?: string;
  }> = [];
  resolver: (input: MarkdownChunkInput) => NoteChunk[] = () => [];

  chunk(input: MarkdownChunkInput): NoteChunk[] {
    this.calls.push({
      path: input.path,
      content: input.content,
      cachedHeading: input.cache?.headings?.[0]?.heading,
    });
    return this.resolver(input);
  }
}

interface Harness {
  service: IndexingService;
  provider: FakeProvider;
  chunker: FakeChunker;
  persistence: MemoryPersistence;
  store(): RecordingVectorStore;
  factoryCalls: Array<{ dimensions: number; embeddingSpaceId: string }>;
}

function vectorForText(text: string): Float32Array {
  const normalized = text.toLowerCase();
  if (normalized.includes("beta") || normalized.includes("second")) {
    return new Float32Array([0, 1, 0]);
  }
  if (normalized.includes("gamma") || normalized.includes("third")) {
    return new Float32Array([0, 0, 1]);
  }
  return new Float32Array([1, 0, 0]);
}

function noteChunk(
  id: string,
  path: string,
  ordinal: number,
  text: string,
  contentHash = `hash-${id}`,
): NoteChunk {
  return {
    id,
    path,
    ordinal,
    headingPath: ["Root", id],
    text,
    contentHash,
    source: {
      startOffset: 0,
      endOffset: 0,
      startLine: ordinal,
      endLine: ordinal,
    },
  };
}

function createHarness(
  overrides: Partial<IndexingServiceOptions> = {},
): Harness {
  const provider =
    (overrides.embeddingProvider as FakeProvider | undefined) ??
    new FakeProvider();
  const chunker =
    (overrides.chunker as FakeChunker | undefined) ?? new FakeChunker();
  const persistence = new MemoryPersistence();
  const factoryCalls: Array<{
    dimensions: number;
    embeddingSpaceId: string;
  }> = [];
  let recordingStore: RecordingVectorStore | undefined;
  const service = new IndexingService({
    chunker,
    embeddingProvider: provider,
    embeddingSpace: {
      providerId: provider.id,
      model: provider.model,
      baseUrl: "https://EXAMPLE.com/v1/?api_key=must-not-leak#fragment",
    },
    vectorStoreFactory: ({ dimensions, embeddingSpaceId }) => {
      factoryCalls.push({ dimensions, embeddingSpaceId });
      recordingStore = new RecordingVectorStore(
        new LocalVectorStore({
          dimensions,
          embeddingSpaceId,
          persistence,
          basePath: BASE,
        }),
      );
      return recordingStore;
    },
    ...overrides,
  });
  return {
    service,
    provider,
    chunker,
    persistence,
    factoryCalls,
    store(): RecordingVectorStore {
      if (!recordingStore) throw new Error("store was not created");
      return recordingStore;
    },
  };
}

function manualGate(): {
  entered: Promise<void>;
  wait(): Promise<void>;
  release(): void;
} {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    async wait(): Promise<void> {
      enter();
      await blocked;
    },
    release,
  };
}

async function searchIds(
  store: RecordingVectorStore,
  query: Float32Array,
): Promise<string[]> {
  return (await store.search(query, { limit: 20 })).map((result) => result.id);
}

function document(path: string, content = "content"): IndexDocumentInput {
  return { path, content, cache: null };
}

describe("embeddingSpace", () => {
  const descriptor = {
    providerId: "openai-compatible",
    model: "model|with=delimiters",
    baseUrl: " HTTPS://Example.COM/v1/ ",
    dimensions: 3,
  };

  it("is deterministic, versioned and normalizes the endpoint", () => {
    const first = buildEmbeddingSpaceId(descriptor);
    const second = buildEmbeddingSpaceId({ ...descriptor });
    expect(second).toBe(first);
    expect(first).toContain("embedding-space:v1|");
    expect(first).toContain("model=model%7Cwith%3Ddelimiters");
    expect(first).toContain(
      "endpoint=https%3A%2F%2Fexample.com%2Fv1",
    );
  });

  it("changes with provider, model, endpoint and dimensions", () => {
    const original = buildEmbeddingSpaceId(descriptor);
    for (const changed of [
      { ...descriptor, providerId: "ollama" },
      { ...descriptor, model: "other" },
      { ...descriptor, baseUrl: "https://other.example/v1" },
      { ...descriptor, dimensions: 4 },
    ]) {
      expect(buildEmbeddingSpaceId(changed)).not.toBe(original);
    }
  });

  it("ignores query and hash without leaking secrets", () => {
    const clean = buildEmbeddingSpaceId({
      ...descriptor,
      baseUrl: "https://example.com/v1",
    });
    const unsafe = buildEmbeddingSpaceId({
      ...descriptor,
      baseUrl: "https://example.com/v1?api_key=sk-secret#Bearer-secret",
      apiKey: "another-secret",
    } as typeof descriptor & { apiKey: string });
    expect(unsafe).toBe(clean);
    expect(unsafe).not.toContain("secret");
    expect(unsafe).not.toContain("api_key");
  });

  it("rejects credentials and ambiguous or invalid components", () => {
    expect(() => normalizeEmbeddingBaseUrl("https://user:pass@example.com/v1"))
      .toThrow(IndexingValidationError);
    expect(() => buildEmbeddingSpaceId({ ...descriptor, dimensions: 0 }))
      .toThrow(IndexingValidationError);
    expect(() => buildEmbeddingSpaceId({ ...descriptor, providerId: " " }))
      .toThrow(IndexingValidationError);
  });

  it("encodes delimiter injection without collisions", () => {
    expect(
      buildEmbeddingSpaceId({ ...descriptor, providerId: "a|model=b" }),
    ).not.toBe(
      buildEmbeddingSpaceId({ ...descriptor, providerId: "a", model: "b" }),
    );
  });
});

describe("IndexingService initialization", () => {
  it("initializes once and passes safe dimensions and space id to the factory", async () => {
    const harness = createHarness();
    await harness.service.initialize();
    await harness.service.initialize();
    expect(harness.provider.dimensionsCalls).toBe(1);
    expect(harness.factoryCalls).toHaveLength(1);
    expect(harness.factoryCalls[0].dimensions).toBe(3);
    expect(harness.factoryCalls[0].embeddingSpaceId).not.toContain("api_key");
    expect(harness.factoryCalls[0].embeddingSpaceId).not.toContain("must-not-leak");
    expect(harness.service.getStats()).toMatchObject({
      initialized: true,
      dimensions: 3,
      vectorCount: 0,
      vectorGeneration: 0,
    });
  });

  it("shares one concurrent initialize promise", async () => {
    const harness = createHarness();
    const gate = manualGate();
    harness.provider.dimensionsImpl = async () => {
      await gate.wait();
      return 3;
    };
    const first = harness.service.initialize();
    const second = harness.service.initialize();
    expect(second).toBe(first);
    await gate.entered;
    expect(harness.provider.dimensionsCalls).toBe(1);
    gate.release();
    await Promise.all([first, second]);
    expect(harness.factoryCalls).toHaveLength(1);
  });

  it("retries after a dimensions failure", async () => {
    const harness = createHarness();
    let attempt = 0;
    harness.provider.dimensionsImpl = async () => {
      if (attempt++ === 0) throw new Error("secret provider body");
      return 3;
    };
    await expect(harness.service.initialize()).rejects.toBeInstanceOf(
      IndexingProviderError,
    );
    await harness.service.initialize();
    expect(harness.provider.dimensionsCalls).toBe(2);
    expect(harness.factoryCalls).toHaveLength(1);
  });

  it("retries store creation without re-requesting dimensions", async () => {
    const provider = new FakeProvider();
    let factoryCalls = 0;
    const service = new IndexingService({
      chunker: new FakeChunker(),
      embeddingProvider: provider,
      embeddingSpace: {
        providerId: provider.id,
        model: provider.model,
        baseUrl: "https://example.com/v1",
      },
      vectorStoreFactory: ({ dimensions, embeddingSpaceId }) => {
        factoryCalls++;
        const store = new LocalVectorStore({
          dimensions,
          embeddingSpaceId,
          persistence: new MemoryPersistence(),
          basePath: BASE,
        });
        if (factoryCalls === 1) {
          const failing = new RecordingVectorStore(store);
          failing.initialize = async () => {
            throw new Error("first initialize fails");
          };
          return failing;
        }
        return store;
      },
    });
    await expect(service.initialize()).rejects.toThrow("first initialize fails");
    await service.initialize();
    expect(factoryCalls).toBe(2);
    expect(provider.dimensionsCalls).toBe(1);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid provider dimensions %s",
    async (dimensions) => {
      const harness = createHarness();
      harness.provider.dimensionsImpl = async () => dimensions;
      await expect(harness.service.initialize()).rejects.toBeInstanceOf(
        IndexingValidationError,
      );
      expect(harness.factoryCalls).toHaveLength(0);
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid embeddingBatchSize %s",
    (embeddingBatchSize) => {
      expect(() => createHarness({ embeddingBatchSize })).toThrow(
        IndexingValidationError,
      );
    },
  );

  it("rejects methods before completed initialization", async () => {
    const harness = createHarness();
    expect(() => harness.service.indexDocument(document("A.md"))).toThrow(
      IndexingNotInitializedError,
    );
    expect(() => harness.service.reconcileAll([])).toThrow(
      IndexingNotInitializedError,
    );
    expect(() => harness.service.deleteDocuments(["A.md"])).toThrow(
      IndexingNotInitializedError,
    );
  });

  it("wraps compatibility errors without clearing the store", async () => {
    const provider = new FakeProvider();
    let clearCalls = 0;
    const incompatible: VectorStore = {
      initialize: async () => {
        throw new VectorStoreCompatibilityError("old space");
      },
      listMetadata: () => [],
      applyChanges: async () => {},
      search: async () => [],
      clear: async () => {
        clearCalls++;
      },
      getStats: () => ({
        initialized: false,
        count: 0,
        dimensions: 3,
        embeddingSpaceId: "old",
        generation: 0,
        binaryBytes: 0,
      }),
    };
    const service = new IndexingService({
      chunker: new FakeChunker(),
      embeddingProvider: provider,
      embeddingSpace: {
        providerId: provider.id,
        model: provider.model,
        baseUrl: "https://example.com/v1",
      },
      vectorStoreFactory: () => incompatible,
    });
    await expect(service.initialize()).rejects.toBeInstanceOf(
      IndexingCompatibilityError,
    );
    expect(clearCalls).toBe(0);
  });
});

describe("IndexingService delta pipeline", () => {
  it("indexes one document with exact text inputs, metadata, previews and vectors", async () => {
    const harness = createHarness({ previewMaxCodePoints: 12 });
    harness.chunker.resolver = ({ path }) => [
      noteChunk("b", path, 1, "  Beta   second text  "),
      noteChunk("a", path, 0, "Alpha 😀😀😀 tail"),
    ];
    await harness.service.initialize();
    const result = await harness.service.indexDocument(
      document("Notes/A.md", "long enough content"),
    );

    expect(harness.provider.embedCalls).toEqual([
      ["Alpha 😀😀😀 tail", "  Beta   second text  "],
    ]);
    expect(harness.store().mutations).toHaveLength(1);
    expect(result).toMatchObject({
      mode: "partial",
      documentsSeen: 1,
      documentsChanged: 1,
      documentsUnchanged: 0,
      chunksSeen: 2,
      chunksEmbedded: 2,
      chunksDeleted: 0,
      generationBefore: 0,
      generationAfter: 1,
    });
    const metadata = harness.store().listMetadata();
    expect(metadata.map((value) => value.id)).toEqual(["a", "b"]);
    expect(metadata[0]).toMatchObject({
      path: "Notes/A.md",
      headingPath: ["Root", "a"],
      ordinal: 0,
      contentHash: "hash-a",
      source: { startOffset: 0, endOffset: 0, startLine: 0, endLine: 0 },
      preview: "Alpha 😀😀😀 ta",
    });
    expect(metadata[0]).not.toHaveProperty("vector");
    expect(await searchIds(harness.store(), new Float32Array([1, 0, 0])))
      .toEqual(["a", "b"]);
    expect((await harness.store().search(new Float32Array([0, 1, 0]), { limit: 2 }))[0].id)
      .toBe("b");
  });

  it("uses real MarkdownChunker without adding metadata to embedding input", async () => {
    const provider = new FakeProvider();
    const harness = createHarness({
      chunker: new MarkdownChunker({
        targetChars: 80,
        maxChars: 120,
        overlapChars: 0,
      }),
      embeddingProvider: provider,
    });
    await harness.service.initialize();
    await harness.service.indexDocument({
      path: "Folder/Real.md",
      content: "# Heading\n\nAlpha paragraph for embedding.",
      cache: null,
    });
    expect(provider.embedCalls.flat()).toHaveLength(1);
    expect(provider.embedCalls[0][0]).toBe("Heading\n\nAlpha paragraph for embedding.");
    expect(provider.embedCalls[0][0]).not.toContain("Folder/Real.md");
  });

  it("sorts documents and chunks deterministically and uses one mutation", async () => {
    const harness = createHarness({ embeddingBatchSize: 2 });
    harness.chunker.resolver = ({ path }) =>
      path === "A.md"
        ? [
            noteChunk("a-2", path, 1, "Beta"),
            noteChunk("a-1", path, 0, "Alpha"),
          ]
        : [noteChunk("b-1", path, 0, "Gamma")];
    await harness.service.initialize();
    const result = await harness.service.indexDocuments([
      document("B.md"),
      document("A.md"),
    ]);
    expect(harness.chunker.calls.map((call) => call.path)).toEqual([
      "A.md",
      "B.md",
    ]);
    expect(harness.provider.embedCalls).toEqual([
      ["Alpha", "Beta"],
      ["Gamma"],
    ]);
    expect(harness.store().mutations).toHaveLength(1);
    expect(result).toMatchObject({ documentsSeen: 2, chunksSeen: 3, chunksEmbedded: 3 });
  });

  it("rejects duplicate document paths and global chunk ids", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path }) => [noteChunk("same", path, 0, "Alpha")];
    await harness.service.initialize();
    expect(() =>
      harness.service.indexDocuments([document("A.md"), document("A.md")]),
    ).toThrow(IndexingValidationError);
    expect(() =>
      harness.service.indexDocuments([document("A.md"), document("B.md")]),
    ).toThrow(IndexingValidationError);
    expect(harness.provider.embedCalls).toHaveLength(0);
  });

  it("makes an unchanged second run a true no-op", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path }) => [
      noteChunk("a", path, 0, "Alpha"),
    ];
    await harness.service.initialize();
    await harness.service.indexDocument(document("A.md"));
    const firstGeneration = harness.store().getStats().generation;
    const second = await harness.service.indexDocument(document("A.md"));
    expect(harness.provider.embedCalls).toEqual([["Alpha"]]);
    expect(harness.store().mutations).toHaveLength(1);
    expect(harness.store().getStats().generation).toBe(firstGeneration);
    expect(second).toMatchObject({
      documentsChanged: 0,
      documentsUnchanged: 1,
      chunksEmbedded: 0,
      generationBefore: 1,
      generationAfter: 1,
    });
  });

  it("embeds and upserts only one changed chunk", async () => {
    const harness = createHarness();
    let changed = false;
    harness.chunker.resolver = ({ path }) => [
      noteChunk("a", path, 0, "Alpha", "stable-a"),
      noteChunk("b", path, 1, changed ? "Beta changed" : "Beta", changed ? "changed-b" : "stable-b"),
    ];
    await harness.service.initialize();
    await harness.service.indexDocument(document("A.md"));
    changed = true;
    const result = await harness.service.indexDocument(document("A.md"));
    expect(harness.provider.embedCalls[1]).toEqual(["Beta changed"]);
    expect(harness.store().mutations[1].upserts?.map((entry) => entry.id)).toEqual(["b"]);
    expect(harness.store().mutations[1].deleteIds).toEqual([]);
    expect(result.chunksEmbedded).toBe(1);
    expect((await harness.store().search(new Float32Array([1, 0, 0]), { limit: 2 }))[0].id).toBe("a");
  });

  it("deletes a removed chunk without re-embedding unchanged chunks", async () => {
    const harness = createHarness();
    let removed = false;
    harness.chunker.resolver = ({ path }) =>
      removed
        ? [noteChunk("a", path, 0, "Alpha")]
        : [
            noteChunk("a", path, 0, "Alpha"),
            noteChunk("b", path, 1, "Beta"),
          ];
    await harness.service.initialize();
    await harness.service.indexDocument(document("A.md"));
    removed = true;
    const result = await harness.service.indexDocument(document("A.md"));
    expect(harness.provider.embedCalls).toEqual([["Alpha", "Beta"]]);
    expect(harness.store().mutations[1].deleteIds).toEqual(["b"]);
    expect(harness.store().listMetadata().map((value) => value.id)).toEqual(["a"]);
    expect(result.chunksDeleted).toBe(1);
  });

  it("deletes old path chunks when a document now yields zero chunks", async () => {
    const harness = createHarness();
    let empty = false;
    harness.chunker.resolver = ({ path }) =>
      empty ? [] : [noteChunk("a", path, 0, "Alpha")];
    await harness.service.initialize();
    await harness.service.indexDocument(document("A.md"));
    empty = true;
    await harness.service.indexDocument(document("A.md"));
    expect(harness.provider.embedCalls).toEqual([["Alpha"]]);
    expect(harness.store().mutations[1].deleteIds).toEqual(["a"]);
    expect(harness.store().listMetadata()).toEqual([]);
  });

  it("keeps unrelated paths during partial indexing", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path, content }) => [
      noteChunk(path, path, 0, content, `hash-${content}`),
    ];
    await harness.service.initialize();
    await harness.service.indexDocuments([
      document("A.md", "Alpha"),
      document("B.md", "Beta"),
    ]);
    await harness.service.indexDocument(document("A.md", "Alpha changed"));
    expect(harness.store().listMetadata().map((value) => value.path)).toEqual([
      "A.md",
      "B.md",
    ]);
    expect(harness.store().mutations[1].deletePaths).toEqual([]);
  });

  it("reconcileAll deletes missing paths and embeds only changed input paths", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path, content }) => [
      noteChunk(path, path, 0, content, `hash-${content}`),
    ];
    await harness.service.initialize();
    await harness.service.indexDocuments([
      document("A.md", "Alpha"),
      document("B.md", "Beta"),
    ]);
    const result = await harness.service.reconcileAll([
      document("A.md", "Alpha changed"),
    ]);
    expect(harness.provider.embedCalls[1]).toEqual(["Alpha changed"]);
    expect(harness.store().mutations[1].deletePaths).toEqual(["B.md"]);
    expect(harness.store().mutations[1].upserts?.map((entry) => entry.id)).toEqual(["A.md"]);
    expect(result).toMatchObject({ documentsDeleted: 1, chunksDeleted: 1, chunksEmbedded: 1 });
    expect(harness.store().listMetadata().map((value) => value.path)).toEqual(["A.md"]);
  });

  it("deleteDocuments deduplicates paths without chunking or embedding", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path }) => [noteChunk(path, path, 0, path === "A.md" ? "Alpha" : "Beta")];
    await harness.service.initialize();
    await harness.service.indexDocuments([document("A.md"), document("B.md")]);
    const chunkCalls = harness.chunker.calls.length;
    const embedCalls = harness.provider.embedCalls.length;
    const result = await harness.service.deleteDocuments(["A.md", "A.md", "Missing.md"]);
    expect(harness.chunker.calls).toHaveLength(chunkCalls);
    expect(harness.provider.embedCalls).toHaveLength(embedCalls);
    expect(harness.store().mutations[1].deletePaths).toEqual(["A.md"]);
    expect(harness.store().listMetadata().map((value) => value.path)).toEqual(["B.md"]);
    expect(result).toMatchObject({ documentsSeen: 2, documentsDeleted: 1, chunksDeleted: 1 });
  });
});


describe("IndexingService atomic document-change batches", () => {
  it("commits rename delete and destination upsert in one generation", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path, content }) => [
      noteChunk(`${path}:0`, path, 0, content, `hash-${content}`),
    ];
    await harness.service.initialize();
    await harness.service.indexDocument(document("A.md", "Alpha"));
    const generation = harness.store().getStats().generation;

    const result = await harness.service.syncDocuments({
      upsertDocuments: [document("B.md", "Beta")],
      deletePaths: ["A.md"],
    });

    expect(result).toMatchObject({
      mode: "sync",
      documentsSeen: 2,
      documentsChanged: 1,
      documentsDeleted: 1,
      chunksEmbedded: 1,
      chunksDeleted: 1,
      generationBefore: generation,
      generationAfter: generation + 1,
    });
    expect(harness.store().mutations.at(-1)).toMatchObject({
      deletePaths: ["A.md"],
      upserts: [{ path: "B.md" }],
    });
    expect(harness.store().listMetadata().map((value) => value.path)).toEqual([
      "B.md",
    ]);
  });

  it("commits multiple creates with at most one generation increment", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path, content }) => [
      noteChunk(path, path, 0, content, `hash-${content}`),
    ];
    await harness.service.initialize();
    const result = await harness.service.syncDocuments({
      upsertDocuments: [
        document("B.md", "Beta"),
        document("A.md", "Alpha"),
      ],
      deletePaths: [],
    });
    expect(result).toMatchObject({ generationBefore: 0, generationAfter: 1 });
    expect(harness.store().mutations).toHaveLength(1);
    expect(harness.store().listMetadata().map((value) => value.path)).toEqual([
      "A.md",
      "B.md",
    ]);
  });

  it("makes unchanged upserts and missing deletes a true no-op", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path, content }) => [
      noteChunk(path, path, 0, content, `hash-${content}`),
    ];
    await harness.service.initialize();
    await harness.service.indexDocument(document("A.md", "Alpha"));
    const generation = harness.store().getStats().generation;
    const mutations = harness.store().mutations.length;
    const embedCalls = harness.provider.embedCalls.length;
    const result = await harness.service.syncDocuments({
      upsertDocuments: [document("A.md", "Alpha")],
      deletePaths: ["Missing.md"],
    });
    expect(result).toMatchObject({
      documentsChanged: 0,
      documentsDeleted: 0,
      chunksEmbedded: 0,
      generationBefore: generation,
      generationAfter: generation,
    });
    expect(harness.store().mutations).toHaveLength(mutations);
    expect(harness.provider.embedCalls).toHaveLength(embedCalls);
  });

  it("deletes paths without invoking the provider", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path }) => [
      noteChunk(path, path, 0, "Alpha"),
    ];
    await harness.service.initialize();
    await harness.service.indexDocument(document("A.md"));
    const embedCalls = harness.provider.embedCalls.length;
    await harness.service.syncDocuments({
      upsertDocuments: [],
      deletePaths: ["A.md"],
    });
    expect(harness.provider.embedCalls).toHaveLength(embedCalls);
    expect(harness.store().listMetadata()).toEqual([]);
  });

  it("preserves the committed snapshot on provider failure and then recovers", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path, content }) => [
      noteChunk(path, path, 0, content, `hash-${content}`),
    ];
    await harness.service.initialize();
    await harness.service.indexDocument(document("A.md", "Alpha"));
    const generation = harness.store().getStats().generation;
    harness.provider.embedImpl = async () => {
      throw new Error("Authorization: Bearer secret response body");
    };
    await expect(
      harness.service.syncDocuments({
        upsertDocuments: [document("B.md", "Beta")],
        deletePaths: ["A.md"],
      }),
    ).rejects.toBeInstanceOf(IndexingProviderError);
    expect(harness.store().getStats().generation).toBe(generation);
    expect(harness.store().listMetadata().map((value) => value.path)).toEqual([
      "A.md",
    ]);

    harness.provider.embedImpl = async (texts) => texts.map(vectorForText);
    await harness.service.syncDocuments({
      upsertDocuments: [document("B.md", "Beta")],
      deletePaths: ["A.md"],
    });
    expect(harness.store().listMetadata().map((value) => value.path)).toEqual([
      "B.md",
    ]);
    expect(harness.store().getStats().generation).toBe(generation + 1);
  });

  it("checks the commit guard only after embeddings and leaves no mutation", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path }) => [
      noteChunk(path, path, 0, "Alpha"),
    ];
    await harness.service.initialize();
    const shouldCommit = vi.fn(() => false);
    const result = await harness.service.syncDocuments(
      {
        upsertDocuments: [document("A.md")],
        deletePaths: [],
      },
      { shouldCommit },
    );
    expect(harness.provider.embedCalls).toEqual([["Alpha"]]);
    expect(shouldCommit).toHaveBeenCalledOnce();
    expect(harness.store().mutations).toHaveLength(0);
    expect(harness.store().listMetadata()).toEqual([]);
    expect(result).toMatchObject({ generationBefore: 0, generationAfter: 0 });
  });

  it("rejects an overlapping upsert/delete path before provider work", async () => {
    const harness = createHarness();
    await harness.service.initialize();
    expect(() =>
      harness.service.syncDocuments({
        upsertDocuments: [document("A.md")],
        deletePaths: ["A.md"],
      }),
    ).toThrow(IndexingValidationError);
    expect(harness.provider.embedCalls).toEqual([]);
    expect(harness.store().mutations).toEqual([]);
  });
});

describe("IndexingService provider atomicity", () => {
  it.each([
    ["wrong result count", async () => []],
    ["number arrays", async () => [[1, 0, 0]] as unknown as Float32Array[]],
    ["wrong dimensions", async () => [new Float32Array([1, 0])]],
    ["NaN", async () => [new Float32Array([Number.NaN, 0, 0])]],
    ["Infinity", async () => [new Float32Array([Number.POSITIVE_INFINITY, 0, 0])]],
    ["zero vector", async () => [new Float32Array([0, 0, 0])]],
  ] as const)("rejects %s before any VectorStore mutation", async (_name, response) => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path }) => [noteChunk("a", path, 0, "private markdown text")];
    harness.provider.embedImpl = response;
    await harness.service.initialize();
    const before = harness.service.getStats();

    const failure = harness.service.indexDocument(document("A.md"));
    await expect(failure).rejects.toBeInstanceOf(
      IndexingProviderContractError,
    );
    await expect(failure).rejects.not.toThrow("private markdown text");
    expect(harness.store().mutations).toHaveLength(0);
    expect(harness.service.getStats()).toEqual(before);
  });

  it("sanitizes provider rejection and preserves the old index", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path }) => [noteChunk("a", path, 0, "Alpha")];
    await harness.service.initialize();
    await harness.service.indexDocument(document("A.md"));
    const before = harness.store().listMetadata();
    harness.chunker.resolver = ({ path }) => [noteChunk("a", path, 0, "secret chunk", "changed")];
    harness.provider.embedImpl = async () => {
      throw new Error("Authorization: Bearer sk-secret; secret chunk");
    };

    let error: unknown;
    try {
      await harness.service.indexDocument(document("A.md"));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(IndexingProviderError);
    expect((error as Error).message).not.toContain("secret");
    expect((error as Error).message).not.toContain("Authorization");
    expect(harness.store().listMetadata()).toEqual(before);
    expect(harness.store().mutations).toHaveLength(1);
  });

  it("does not mutate the store when the second batch fails", async () => {
    const harness = createHarness({ embeddingBatchSize: 2 });
    harness.chunker.resolver = ({ path }) => [
      noteChunk("a", path, 0, "Alpha"),
      noteChunk("b", path, 1, "Beta"),
      noteChunk("c", path, 2, "Gamma"),
    ];
    let batch = 0;
    harness.provider.embedImpl = async (texts) => {
      if (batch++ === 1) throw new Error("second batch body");
      return texts.map(vectorForText);
    };
    await harness.service.initialize();
    await expect(
      harness.service.indexDocument(document("A.md")),
    ).rejects.toBeInstanceOf(IndexingProviderError);
    expect(harness.provider.embedCalls).toEqual([
      ["Alpha", "Beta"],
      ["Gamma"],
    ]);
    expect(harness.store().mutations).toHaveLength(0);
    expect(harness.store().listMetadata()).toEqual([]);
  });

  it("copies shared-buffer subarrays before applying the mutation", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path }) => [
      noteChunk("a", path, 0, "Alpha"),
      noteChunk("b", path, 1, "Beta"),
    ];
    const shared = new Float32Array([1, 0, 0, 0, 1, 0]);
    harness.provider.embedImpl = async () => [
      shared.subarray(0, 3),
      shared.subarray(3, 6),
    ];
    await harness.service.initialize();
    await harness.service.indexDocument(document("A.md"));
    shared.fill(0);

    expect((await harness.store().search(new Float32Array([1, 0, 0]), { limit: 2 }))[0].id).toBe("a");
    expect((await harness.store().search(new Float32Array([0, 1, 0]), { limit: 2 }))[0].id).toBe("b");
  });
});

describe("IndexingService queue and input snapshots", () => {
  it("serializes two concurrent indexDocument operations", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path }) => [
      noteChunk(path, path, 0, path === "A.md" ? "Alpha" : "Beta"),
    ];
    const gate = manualGate();
    let call = 0;
    harness.provider.embedImpl = async (texts) => {
      if (call++ === 0) await gate.wait();
      return texts.map(vectorForText);
    };
    await harness.service.initialize();

    const first = harness.service.indexDocument(document("A.md"));
    await gate.entered;
    const second = harness.service.indexDocument(document("B.md"));
    await Promise.resolve();
    expect(harness.provider.embedCalls).toEqual([["Alpha"]]);
    expect(harness.store().listMetadata()).toEqual([]);
    gate.release();
    await Promise.all([first, second]);
    expect(harness.provider.embedCalls).toEqual([["Alpha"], ["Beta"]]);
    expect(harness.store().getStats().generation).toBe(2);
    expect(harness.store().listMetadata().map((value) => value.path)).toEqual(["A.md", "B.md"]);
  });

  it("serializes indexing with deleteDocuments", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path, content }) => [
      noteChunk(path, path, 0, content, `hash-${content}`),
    ];
    await harness.service.initialize();
    await harness.service.indexDocuments([
      document("A.md", "Alpha"),
      document("B.md", "Beta"),
    ]);
    const gate = manualGate();
    harness.provider.embedImpl = async (texts) => {
      await gate.wait();
      return texts.map(vectorForText);
    };
    const indexing = harness.service.indexDocument(
      document("A.md", "Alpha changed"),
    );
    await gate.entered;
    const deleting = harness.service.deleteDocuments(["B.md"]);
    expect(harness.store().listMetadata().map((value) => value.path)).toEqual(["A.md", "B.md"]);
    gate.release();
    await Promise.all([indexing, deleting]);
    expect(harness.store().listMetadata().map((value) => value.path)).toEqual(["A.md"]);
    expect(harness.store().getStats().generation).toBe(3);
  });

  it("serializes reconcileAll with a following partial index", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path, content }) => [
      noteChunk(path, path, 0, content, `hash-${content}`),
    ];
    await harness.service.initialize();
    await harness.service.indexDocuments([
      document("A.md", "Alpha"),
      document("B.md", "Beta"),
    ]);
    const gate = manualGate();
    let gated = true;
    harness.provider.embedImpl = async (texts) => {
      if (gated) {
        gated = false;
        await gate.wait();
      }
      return texts.map(vectorForText);
    };
    const reconcile = harness.service.reconcileAll([
      document("A.md", "Alpha changed"),
    ]);
    await gate.entered;
    const partial = harness.service.indexDocument(document("B.md", "Beta new"));
    gate.release();
    await Promise.all([reconcile, partial]);
    expect(harness.store().listMetadata().map((value) => value.path)).toEqual(["A.md", "B.md"]);
    expect(harness.store().getStats().generation).toBe(3);
  });

  it("recovers the queue after provider and VectorStore failures", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path, content }) => [
      noteChunk(path, path, 0, content, `hash-${content}`),
    ];
    await harness.service.initialize();
    let rejectProvider = true;
    harness.provider.embedImpl = async (texts) => {
      if (rejectProvider) {
        rejectProvider = false;
        throw new Error("provider failure");
      }
      return texts.map(vectorForText);
    };
    await expect(
      harness.service.indexDocument(document("A.md", "Alpha")),
    ).rejects.toBeInstanceOf(IndexingProviderError);
    await harness.service.indexDocument(document("A.md", "Alpha"));

    harness.store().failNextMutation = new VectorStorePersistenceError("disk failure");
    await expect(
      harness.service.indexDocument(document("B.md", "Beta")),
    ).rejects.toBeInstanceOf(VectorStorePersistenceError);
    await harness.service.indexDocument(document("B.md", "Beta"));
    expect(harness.store().listMetadata().map((value) => value.path)).toEqual(["A.md", "B.md"]);
    expect(harness.store().getStats().generation).toBe(2);
  });

  it("snapshots caller documents, cache and chunk output before awaiting", async () => {
    const harness = createHarness();
    const rawChunk = noteChunk("original", "Original.md", 0, "Alpha");
    harness.chunker.resolver = () => [rawChunk];
    const cache = {
      headings: [
        {
          heading: "Original heading",
          level: 1,
          position: {
            start: { line: 0, col: 0, offset: 0 },
            end: { line: 0, col: 1, offset: 1 },
          },
        },
      ],
    };
    const input: IndexDocumentInput = {
      path: "Original.md",
      content: "Original content",
      cache,
    };
    const documents = [input];
    const gate = manualGate();
    harness.provider.embedImpl = async (texts) => {
      await gate.wait();
      return texts.map(vectorForText);
    };
    await harness.service.initialize();
    const operation = harness.service.indexDocuments(documents);
    expect(harness.chunker.calls[0]).toMatchObject({
      path: "Original.md",
      content: "Original content",
      cachedHeading: "Original heading",
    });
    documents.length = 0;
    input.path = "Mutated.md";
    input.content = "Mutated content";
    cache.headings[0].heading = "Mutated heading";
    rawChunk.id = "mutated";
    rawChunk.path = "Mutated.md";
    rawChunk.text = "mutated text";
    await gate.entered;
    gate.release();
    await operation;
    expect(harness.provider.embedCalls).toEqual([["Alpha"]]);
    expect(harness.store().listMetadata()[0]).toMatchObject({
      id: "original",
      path: "Original.md",
    });
  });

  it("returns detached result and stats objects", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path }) => [noteChunk("a", path, 0, "Alpha")];
    await harness.service.initialize();
    const result = await harness.service.indexDocument(document("A.md"));
    result.generationAfter = 999;
    const stats = harness.service.getStats();
    stats.vectorCount = 999;
    expect(harness.service.getStats()).toMatchObject({
      vectorCount: 1,
      vectorGeneration: 1,
    });
  });
});

describe("input and chunk contract validation", () => {
  it.each([
    "",
    " /A.md",
    "/A.md",
    "A\\B.md",
    "A/../B.md",
    "A/./B.md",
    "A//B.md",
    "A\0B.md",
  ])("rejects non-canonical path %j", async (path) => {
    const harness = createHarness();
    await harness.service.initialize();
    expect(() => harness.service.indexDocument(document(path))).toThrow(
      IndexingValidationError,
    );
  });

  it.each([
    ["wrong path", (chunk: NoteChunk) => { chunk.path = "Other.md"; }],
    ["negative ordinal", (chunk: NoteChunk) => { chunk.ordinal = -1; }],
    ["empty hash", (chunk: NoteChunk) => { chunk.contentHash = ""; }],
    ["bad heading", (chunk: NoteChunk) => { chunk.headingPath = [1 as unknown as string]; }],
    ["range past content", (chunk: NoteChunk) => { chunk.source.endOffset = 999; }],
    ["reversed lines", (chunk: NoteChunk) => { chunk.source.startLine = 2; chunk.source.endLine = 1; }],
  ] as const)("rejects chunk with %s", async (_name, mutate) => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path }) => {
      const chunk = noteChunk("a", path, 0, "Alpha");
      mutate(chunk);
      return [chunk];
    };
    await harness.service.initialize();
    expect(() => harness.service.indexDocument(document("A.md"))).toThrow(
      IndexingValidationError,
    );
    expect(harness.provider.embedCalls).toHaveLength(0);
  });
});

describe("Obsidian adapters and browser boundaries", () => {
  it("reads only Markdown files in deterministic order with caches", async () => {
    const files = [
      { path: "B.md" },
      { path: "asset.txt" },
      { path: "A.md" },
    ];
    const reads: string[] = [];
    const eventSubscriptions = vi.fn();
    const caches = new Map<string, unknown>([
      ["A.md", { headings: [] }],
      ["B.md", null],
    ]);
    const source = new ObsidianMarkdownDocumentSource({
      vault: {
        getMarkdownFiles: () => files as never[],
        cachedRead: async (file) => {
          reads.push(file.path);
          return `content:${file.path}`;
        },
        on: eventSubscriptions,
      } as never,
      metadataCache: {
        getFileCache: (file) => caches.get(file.path) as never,
        on: eventSubscriptions,
      } as never,
    });
    const documents = await source.readAll();
    expect(documents.map((value) => value.path)).toEqual(["A.md", "B.md"]);
    expect(reads).toEqual(["A.md", "B.md"]);
    expect(documents[0].cache).toEqual({ headings: [] });
    expect(documents[1].cache).toBeNull();
    expect(eventSubscriptions).not.toHaveBeenCalled();
  });

  it("wraps source read failures without leaking note content", async () => {
    const source = new ObsidianMarkdownDocumentSource({
      vault: {
        getMarkdownFiles: () => [{ path: "Secret.md" }] as never[],
        cachedRead: async () => {
          throw new Error("full secret note body");
        },
      },
      metadataCache: { getFileCache: () => null },
    });
    let error: unknown;
    try {
      await source.readAll();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(IndexingSourceError);
    expect((error as Error).message).toContain("Secret.md");
    expect((error as Error).message).not.toContain("note body");
  });

  it("creates and initializes LocalVectorStore under the real configDir", async () => {
    const persistence = new MemoryPersistence();
    const adapter = {
      exists: (path: string) => persistence.exists(path),
      read: (path: string) => persistence.readText(path),
      readBinary: (path: string) => persistence.readBinary(path),
      write: (path: string, data: string) => persistence.writeText(path, data),
      writeBinary: (path: string, data: ArrayBuffer) => persistence.writeBinary(path, data),
      mkdir: (path: string) => persistence.createDirectory(path),
      remove: (path: string) => persistence.remove(path),
      rename: (from: string, to: string) => persistence.rename(from, to),
    };
    const provider = new FakeProvider();
    const chunker = new FakeChunker();
    chunker.resolver = ({ path }) => [noteChunk("a", path, 0, "Alpha")];
    const service = await createObsidianIndexingService({
      app: {
        vault: { adapter, configDir: ".custom-config" },
      } as never,
      embeddingProvider: provider,
      embeddingSpace: {
        providerId: provider.id,
        model: provider.model,
        baseUrl: "https://example.com/v1",
      },
      chunker,
    });
    await service.indexDocument(document("A.md"));
    expect(provider.dimensionsCalls).toBe(1);
    expect(
      [...persistence.files.keys()].every((path) =>
        path.startsWith(
          ".custom-config/plugins/ai-knowledge-hub/semantic-index/",
        ),
      ),
    ).toBe(true);
  });

  it("keeps production indexing core free of Node and Obsidian runtime imports", () => {
    const core = readFileSync("indexing/indexingService.ts", "utf8");
    for (const forbidden of [
      'from "node:',
      'from "fs"',
      'from "path"',
      'from "obsidian"',
      'from "../vectorStore"',
      "Buffer",
      "process.",
      "worker_threads",
      "node:stream",
      'import { App',
      'import { Vault',
      'import { TFile',
    ]) {
      expect(core).not.toContain(forbidden);
    }
  });
});


describe("adversarial regression contracts", () => {
  it.each([
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
    0x1_0000_0000,
    0x1_0000_0001,
  ])("rejects out-of-range provider dimensions %s before the factory", async (dimensions) => {
    const harness = createHarness();
    harness.provider.dimensionsImpl = async () => dimensions;
    let error: unknown;
    try {
      await harness.service.initialize();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(IndexingValidationError);
    expect((error as Error).message).not.toContain("secret");
    expect(harness.factoryCalls).toHaveLength(0);
    expect(harness.provider.embedCalls).toHaveLength(0);
    expect(harness.service.getStats().initialized).toBe(false);
  });

  it("accepts UINT32_MAX dimensions and passes the boundary to the factory", async () => {
    const harness = createHarness();
    harness.provider.dimensionsImpl = async () => 0xffff_ffff;
    await harness.service.initialize();
    expect(harness.factoryCalls).toHaveLength(1);
    expect(harness.factoryCalls[0].dimensions).toBe(0xffff_ffff);
    expect(harness.service.getStats()).toMatchObject({
      initialized: true,
      dimensions: 0xffff_ffff,
    });
  });

  it("retries initialization after an out-of-range dimensions result", async () => {
    const harness = createHarness();
    let attempt = 0;
    harness.provider.dimensionsImpl = async () =>
      attempt++ === 0 ? 0x1_0000_0000 : 3;
    await expect(harness.service.initialize()).rejects.toBeInstanceOf(
      IndexingValidationError,
    );
    expect(harness.factoryCalls).toHaveLength(0);
    await harness.service.initialize();
    expect(harness.provider.dimensionsCalls).toBe(2);
    expect(harness.factoryCalls).toHaveLength(1);
    expect(harness.service.getStats().initialized).toBe(true);
  });

  it.each([
    ["providerId", { providerId: "ollama", model: "model-a" }],
    ["model", { providerId: "openrouter", model: "model-b" }],
  ] as const)("rejects a descriptor %s mismatch before store creation", async (_field, descriptor) => {
    let dimensionsCalls = 0;
    let embedCalls = 0;
    let factoryCalls = 0;
    const provider: EmbeddingProvider = {
      id: "openrouter",
      model: "model-a",
      async dimensions() {
        dimensionsCalls++;
        return 3;
      },
      async embed() {
        embedCalls++;
        return [new Float32Array([1, 0, 0])];
      },
    };
    const service = new IndexingService({
      chunker: new FakeChunker(),
      embeddingProvider: provider,
      embeddingSpace: {
        ...descriptor,
        baseUrl: "https://example.com/v1",
      },
      vectorStoreFactory: () => {
        factoryCalls++;
        throw new Error("factory must not run");
      },
    });

    await expect(service.initialize()).rejects.toBeInstanceOf(
      IndexingValidationError,
    );
    expect(dimensionsCalls).toBe(1);
    expect(embedCalls).toBe(0);
    expect(factoryCalls).toBe(0);
    expect(service.getStats().initialized).toBe(false);
  });

  it("initializes when descriptor provider and model exactly match", async () => {
    const provider: EmbeddingProvider = {
      id: "openrouter",
      model: "model-a",
      dimensions: async () => 3,
      embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0])),
    };
    const persistence = new MemoryPersistence();
    const factoryCalls: Array<{ dimensions: number; embeddingSpaceId: string }> = [];
    const service = new IndexingService({
      chunker: new FakeChunker(),
      embeddingProvider: provider,
      embeddingSpace: {
        providerId: "openrouter",
        model: "model-a",
        baseUrl: "https://example.com/v1",
      },
      vectorStoreFactory: (input) => {
        factoryCalls.push(input);
        return new LocalVectorStore({ ...input, persistence, basePath: BASE });
      },
    });
    await service.initialize();
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0].embeddingSpaceId).toContain("provider=openrouter");
    expect(factoryCalls[0].embeddingSpaceId).toContain("model=model-a");
  });

  it("copies a shared-buffer subarray before awaiting the next provider batch", async () => {
    const harness = createHarness({ embeddingBatchSize: 1 });
    harness.chunker.resolver = ({ path }) => [
      noteChunk("chunk-a", path, 0, "Alpha"),
      noteChunk("chunk-b", path, 1, "Beta"),
    ];
    const shared = new Float32Array([9, 1, 0, 0, 0, 1, 0, 9]);
    const vectorA = shared.subarray(1, 4);
    const vectorB = shared.subarray(4, 7);
    const firstOutput = [vectorA];
    const secondGate = manualGate();
    let batch = 0;
    harness.provider.embedImpl = async () => {
      if (batch++ === 0) return firstOutput;
      await secondGate.wait();
      return [vectorB];
    };
    await harness.service.initialize();
    const operation = harness.service.indexDocument(document("A.md"));
    await secondGate.entered;
    vectorA.set([0, 1, 0]);
    firstOutput.length = 0;
    secondGate.release();
    const result = await operation;

    expect(vectorA.byteOffset).toBeGreaterThan(0);
    expect(vectorB.byteOffset).toBeGreaterThan(0);
    expect(harness.store().mutations).toHaveLength(1);
    expect(result).toMatchObject({ generationBefore: 0, generationAfter: 1 });
    expect((await harness.store().search(new Float32Array([1, 0, 0]), { limit: 1 }))[0].id)
      .toBe("chunk-a");
    expect((await harness.store().search(new Float32Array([0, 1, 0]), { limit: 1 }))[0].id)
      .toBe("chunk-b");
  });

  it("treats reconcileAll([]) on an empty store as a true no-op", async () => {
    const harness = createHarness();
    await harness.service.initialize();
    const result = await harness.service.reconcileAll([]);
    expect(result).toEqual({
      mode: "reconcile",
      documentsSeen: 0,
      documentsChanged: 0,
      documentsUnchanged: 0,
      documentsDeleted: 0,
      chunksSeen: 0,
      chunksEmbedded: 0,
      chunksDeleted: 0,
      generationBefore: 0,
      generationAfter: 0,
    });
    expect(harness.chunker.calls).toHaveLength(0);
    expect(harness.provider.embedCalls).toHaveLength(0);
    expect(harness.store().mutations).toHaveLength(0);
  });

  it("reconcileAll([]) removes every stored path once and reloads empty", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path }) =>
      path === "A.md"
        ? [noteChunk("a-1", path, 0, "Alpha"), noteChunk("a-2", path, 1, "Beta")]
        : [noteChunk("b-1", path, 0, "Gamma")];
    await harness.service.initialize();
    await harness.service.indexDocuments([document("B.md"), document("A.md")]);
    const chunkCalls = harness.chunker.calls.length;
    const embedCalls = harness.provider.embedCalls.length;
    const result = await harness.service.reconcileAll([]);

    expect(harness.chunker.calls).toHaveLength(chunkCalls);
    expect(harness.provider.embedCalls).toHaveLength(embedCalls);
    expect(harness.store().mutations).toHaveLength(2);
    expect(harness.store().mutations[1]).toMatchObject({
      deletePaths: ["A.md", "B.md"],
      deleteIds: [],
      upserts: [],
    });
    expect(result).toEqual({
      mode: "reconcile",
      documentsSeen: 0,
      documentsChanged: 0,
      documentsUnchanged: 0,
      documentsDeleted: 2,
      chunksSeen: 0,
      chunksEmbedded: 0,
      chunksDeleted: 3,
      generationBefore: 1,
      generationAfter: 2,
    });
    const stats = harness.service.getStats();
    const reloaded = new LocalVectorStore({
      dimensions: stats.dimensions,
      embeddingSpaceId: stats.embeddingSpaceId,
      persistence: harness.persistence,
      basePath: BASE,
    });
    await reloaded.initialize();
    expect(reloaded.listMetadata()).toEqual([]);
    expect(reloaded.getStats().generation).toBe(2);
  });

  it("rejects all mutations while initialize is pending, then remains usable", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path }) => [noteChunk("a", path, 0, "Alpha")];
    const gate = manualGate();
    harness.provider.dimensionsImpl = async () => {
      await gate.wait();
      return 3;
    };
    const initialization = harness.service.initialize();
    await gate.entered;

    expect(() => harness.service.indexDocument(document("A.md"))).toThrow(
      IndexingNotInitializedError,
    );
    expect(() => harness.service.indexDocuments([])).toThrow(
      IndexingNotInitializedError,
    );
    expect(() => harness.service.reconcileAll([])).toThrow(
      IndexingNotInitializedError,
    );
    expect(() => harness.service.deleteDocuments([])).toThrow(
      IndexingNotInitializedError,
    );
    expect(harness.service.getStats()).toEqual({
      initialized: false,
      dimensions: 0,
      embeddingSpaceId: "",
      vectorCount: 0,
      vectorGeneration: 0,
    });

    gate.release();
    await initialization;
    expect(harness.factoryCalls).toHaveLength(1);
    await harness.service.indexDocument(document("A.md"));
    expect(harness.store().listMetadata().map((value) => value.id)).toEqual(["a"]);
  });

  it("retries after VectorStoreFactory itself throws", async () => {
    const provider = new FakeProvider();
    const chunker = new FakeChunker();
    chunker.resolver = ({ path }) => [noteChunk("a", path, 0, "Alpha")];
    const persistence = new MemoryPersistence();
    let factoryCalls = 0;
    let store: LocalVectorStore | undefined;
    const service = new IndexingService({
      chunker,
      embeddingProvider: provider,
      embeddingSpace: {
        providerId: provider.id,
        model: provider.model,
        baseUrl: "https://example.com/v1",
      },
      vectorStoreFactory: ({ dimensions, embeddingSpaceId }) => {
        factoryCalls++;
        if (factoryCalls === 1) throw new Error("factory failed safely");
        store = new LocalVectorStore({
          dimensions,
          embeddingSpaceId,
          persistence,
          basePath: BASE,
        });
        return store;
      },
    });

    await expect(service.initialize()).rejects.toThrow("factory failed safely");
    expect(service.getStats().initialized).toBe(false);
    expect(provider.dimensionsCalls).toBe(1);
    expect(factoryCalls).toBe(1);
    await service.initialize();
    expect(provider.dimensionsCalls).toBe(1);
    expect(factoryCalls).toBe(2);
    expect(service.getStats().initialized).toBe(true);
    await service.indexDocument(document("A.md"));
    expect(store?.listMetadata().map((value) => value.id)).toEqual(["a"]);
  });

  it("keeps empty and missing-path operations as true no-ops", async () => {
    const harness = createHarness();
    await harness.service.initialize();
    const emptyIndex = await harness.service.indexDocuments([]);
    const emptyDelete = await harness.service.deleteDocuments([]);
    expect(emptyIndex).toMatchObject({
      mode: "partial",
      documentsSeen: 0,
      documentsChanged: 0,
      generationBefore: 0,
      generationAfter: 0,
    });
    expect(emptyDelete).toMatchObject({
      mode: "delete",
      documentsSeen: 0,
      documentsDeleted: 0,
      chunksDeleted: 0,
      generationBefore: 0,
      generationAfter: 0,
    });
    expect(harness.chunker.calls).toHaveLength(0);
    expect(harness.provider.embedCalls).toHaveLength(0);
    expect(harness.store().mutations).toHaveLength(0);

    harness.chunker.resolver = ({ path }) => [noteChunk("b", path, 0, "Beta")];
    await harness.service.indexDocument(document("B.md"));
    const generation = harness.store().getStats().generation;
    const metadata = harness.store().listMetadata();
    const missing = await harness.service.deleteDocuments(["Missing.md"]);
    expect(missing).toMatchObject({
      documentsSeen: 1,
      documentsUnchanged: 1,
      documentsDeleted: 0,
      chunksDeleted: 0,
      generationBefore: generation,
      generationAfter: generation,
    });
    expect(harness.store().mutations).toHaveLength(1);
    expect(harness.store().listMetadata()).toEqual(metadata);

    const embedCalls = harness.provider.embedCalls.length;
    const unchanged = await harness.service.indexDocuments([document("B.md")]);
    expect(unchanged).toMatchObject({
      documentsChanged: 0,
      documentsUnchanged: 1,
      generationBefore: generation,
      generationAfter: generation,
    });
    expect(harness.provider.embedCalls).toHaveLength(embedCalls);
    expect(harness.store().mutations).toHaveLength(1);
  });

  const metadataFieldCases: Array<[string, (chunk: NoteChunk) => void]> = [
    ["headingPath", (chunk) => { chunk.headingPath = ["Changed"]; }],
    ["ordinal", (chunk) => { chunk.ordinal = 2; }],
    ["contentHash", (chunk) => { chunk.contentHash = "changed-hash"; }],
    ["source.startOffset", (chunk) => { chunk.source.startOffset = 1; }],
    ["source.endOffset", (chunk) => { chunk.source.endOffset = 3; }],
    ["source.startLine", (chunk) => { chunk.source.startLine = 1; }],
    ["source.endLine", (chunk) => { chunk.source.endLine = 2; }],
    ["preview", (chunk) => { chunk.text = "Target changed preview"; }],
  ];

  it.each(metadataFieldCases)("re-embeds when only metadata field %s changes", async (_field, mutate) => {
    const harness = createHarness();
    let changed = false;
    harness.chunker.resolver = ({ path }) => {
      const target = noteChunk("target", path, 0, "Target", "target-hash");
      target.headingPath = ["Root", "Target"];
      target.source = { startOffset: 0, endOffset: 2, startLine: 0, endLine: 1 };
      const stable = noteChunk("stable", path, 1, "Stable", "stable-hash");
      stable.source = { startOffset: 3, endOffset: 5, startLine: 1, endLine: 2 };
      if (changed) mutate(target);
      return [target, stable];
    };
    await harness.service.initialize();
    await harness.service.indexDocument(
      document("A.md", "0123456789\nline two\nline three"),
    );
    changed = true;
    const result = await harness.service.indexDocument(
      document("A.md", "0123456789\nline two\nline three"),
    );

    expect(harness.provider.embedCalls).toHaveLength(2);
    expect(harness.provider.embedCalls[1]).toHaveLength(1);
    expect(harness.provider.embedCalls[1][0]).toBe(
      _field === "preview" ? "Target changed preview" : "Target",
    );
    expect(harness.store().mutations).toHaveLength(2);
    expect(harness.store().mutations[1].upserts?.map((entry) => entry.id)).toEqual(["target"]);
    expect(result).toMatchObject({
      documentsChanged: 1,
      documentsUnchanged: 0,
      chunksEmbedded: 1,
      generationBefore: 1,
      generationAfter: 2,
    });
  });

  it("keeps an exact full-metadata match as a no-op", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path }) => {
      const value = noteChunk("target", path, 0, "Target", "target-hash");
      value.source = { startOffset: 0, endOffset: 2, startLine: 0, endLine: 1 };
      return [value];
    };
    await harness.service.initialize();
    await harness.service.indexDocument(document("A.md", "0123456789"));
    const result = await harness.service.indexDocument(document("A.md", "0123456789"));
    expect(harness.provider.embedCalls).toHaveLength(1);
    expect(harness.store().mutations).toHaveLength(1);
    expect(result).toMatchObject({
      documentsChanged: 0,
      documentsUnchanged: 1,
      generationBefore: 1,
      generationAfter: 1,
    });
  });

  it("rejects an existing cross-path chunk-id collision before embedding", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path }) => [noteChunk("shared-id", path, 0, "Alpha")];
    await harness.service.initialize();
    await harness.service.indexDocument(document("A.md"));
    const embedCalls = harness.provider.embedCalls.length;
    const mutationCalls = harness.store().mutations.length;
    const generation = harness.store().getStats().generation;
    harness.chunker.resolver = ({ path }) => [
      noteChunk("shared-id", path, 0, "private collision text"),
    ];
    let error: unknown;
    try {
      await harness.service.indexDocument(document("B.md"));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(IndexingValidationError);
    expect((error as Error).message).not.toContain("private collision text");
    expect(harness.provider.embedCalls).toHaveLength(embedCalls);
    expect(harness.store().mutations).toHaveLength(mutationCalls);
    expect(harness.store().getStats().generation).toBe(generation);
    expect(harness.store().listMetadata()).toMatchObject([
      { id: "shared-id", path: "A.md" },
    ]);
  });

  it("rejects duplicate chunk IDs from two new documents before embedding", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path }) => [noteChunk("shared-id", path, 0, "private")];
    await harness.service.initialize();
    expect(() =>
      harness.service.indexDocuments([document("A.md"), document("B.md")]),
    ).toThrow(IndexingValidationError);
    expect(harness.provider.embedCalls).toHaveLength(0);
    expect(harness.store().mutations).toHaveLength(0);
    expect(harness.store().getStats().generation).toBe(0);
  });

  it.each([
    "",
    "   ",
    "/a.md",
    "\\a.md",
    "C:/a.md",
    "c:/a.md",
    "Z:/folder/a.md",
    "C:\\a.md",
    "z:\\folder\\file.md",
    "./a.md",
    "a/./b.md",
    "a/../b.md",
    "../a.md",
    "a//b.md",
    "a\\folder.md",
    "a\0b.md",
  ])("rejects invalid path matrix entry %j without side effects", async (path) => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path: chunkPath }) => [
      noteChunk("unexpected", chunkPath, 0, "private markdown"),
    ];
    await harness.service.initialize();
    expect(() =>
      harness.service.indexDocument({ path, content: "private markdown" }),
    ).toThrow(IndexingValidationError);
    expect(harness.chunker.calls).toHaveLength(0);
    expect(harness.provider.embedCalls).toHaveLength(0);
    expect(harness.store().mutations).toHaveLength(0);
    expect(harness.store().getStats().generation).toBe(0);
  });

  it.each([
    "a.md",
    "folder/a.md",
    "folder/sub/a.md",
    "a",
    "notes/Физика.md",
  ])("accepts canonical vault-relative path %j", async (path) => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path: chunkPath }) => [
      noteChunk(chunkPath, chunkPath, 0, "Alpha"),
    ];
    await harness.service.initialize();
    await harness.service.indexDocument({ path, content: "content" });
    expect(harness.store().listMetadata()[0].path).toBe(path);
  });

  it.each([
    ["empty", "", 4, undefined],
    ["whitespace", " \t\r\n ", 4, undefined],
    ["collapsed whitespace", "  alpha\t beta\r\n gamma  ", 20, "alpha beta gamma"],
    ["exact boundary", "abcd", 4, "abcd"],
    ["one past boundary", "abcde", 4, "abcd"],
    ["emoji boundary", "abc😀z", 4, "abc😀"],
    ["multiple emoji", "😀😀😀😀😀", 4, "😀😀😀😀"],
    ["combining mark", "a\u0301bcde", 4, "a\u0301bc"],
  ] as const)("builds a code-point-safe preview for %s", async (_name, text, max, expected) => {
    const harness = createHarness({ previewMaxCodePoints: max });
    harness.chunker.resolver = ({ path }) => [noteChunk("a", path, 0, text)];
    await harness.service.initialize();
    await harness.service.indexDocument(document("A.md", "long enough content"));
    expect(harness.provider.embedCalls).toEqual([[text]]);
    const metadata = harness.store().listMetadata()[0];
    if (expected === undefined) expect(metadata).not.toHaveProperty("preview");
    else expect(metadata.preview).toBe(expected);
  });

  it("reports exact counters for a zero-chunk replacement", async () => {
    const harness = createHarness();
    let empty = false;
    harness.chunker.resolver = ({ path }) =>
      empty
        ? []
        : [noteChunk("a", path, 0, "Alpha"), noteChunk("b", path, 1, "Beta")];
    await harness.service.initialize();
    await harness.service.indexDocument(document("A.md"));
    empty = true;
    const result = await harness.service.indexDocument(document("A.md"));
    expect(result).toEqual({
      mode: "partial",
      documentsSeen: 1,
      documentsChanged: 1,
      documentsUnchanged: 0,
      documentsDeleted: 0,
      chunksSeen: 0,
      chunksEmbedded: 0,
      chunksDeleted: 2,
      generationBefore: 1,
      generationAfter: 2,
    });
  });

  it("reports exact counters for existing and missing deletes", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path }) =>
      path === "A.md"
        ? [noteChunk("a-1", path, 0, "Alpha"), noteChunk("a-2", path, 1, "Beta")]
        : [noteChunk("b-1", path, 0, "Gamma")];
    await harness.service.initialize();
    await harness.service.indexDocuments([document("A.md"), document("B.md")]);
    const deleted = await harness.service.deleteDocuments(["A.md"]);
    expect(deleted).toEqual({
      mode: "delete",
      documentsSeen: 1,
      documentsChanged: 0,
      documentsUnchanged: 0,
      documentsDeleted: 1,
      chunksSeen: 0,
      chunksEmbedded: 0,
      chunksDeleted: 2,
      generationBefore: 1,
      generationAfter: 2,
    });
    const missing = await harness.service.deleteDocuments(["Missing.md"]);
    expect(missing).toEqual({
      mode: "delete",
      documentsSeen: 1,
      documentsChanged: 0,
      documentsUnchanged: 1,
      documentsDeleted: 0,
      chunksSeen: 0,
      chunksEmbedded: 0,
      chunksDeleted: 0,
      generationBefore: 2,
      generationAfter: 2,
    });
    expect(harness.store().listMetadata().map((value) => value.path)).toEqual(["B.md"]);
  });

  it("reports exact counters when reconcile removes an unchanged path", async () => {
    const harness = createHarness();
    harness.chunker.resolver = ({ path }) =>
      path === "A.md"
        ? [noteChunk("a-1", path, 0, "Alpha")]
        : [noteChunk("b-1", path, 0, "Beta"), noteChunk("b-2", path, 1, "Gamma")];
    await harness.service.initialize();
    await harness.service.indexDocuments([document("A.md"), document("B.md")]);
    const result = await harness.service.reconcileAll([document("A.md")]);
    expect(result).toEqual({
      mode: "reconcile",
      documentsSeen: 1,
      documentsChanged: 0,
      documentsUnchanged: 1,
      documentsDeleted: 1,
      chunksSeen: 1,
      chunksEmbedded: 0,
      chunksDeleted: 2,
      generationBefore: 1,
      generationAfter: 2,
    });
  });

  it("redacts provider Markdown, credentials, vectors and response bodies", async () => {
    const harness = createHarness();
    const markdown = "private markdown body";
    harness.chunker.resolver = ({ path }) => [
      noteChunk("a", path, 0, markdown, "changed"),
    ];
    harness.provider.embedImpl = async () => {
      throw new Error(
        "Authorization: Bearer sk-secret api_key=key-secret vector=[1,0,0] response=full-body private markdown body",
      );
    };
    await harness.service.initialize();
    const generation = harness.store().getStats().generation;
    let error: unknown;
    try {
      await harness.service.indexDocument(document("A.md"));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(IndexingProviderError);
    expect(error).not.toBeInstanceOf(IndexingProviderContractError);
    expect((error as IndexingProviderError).cause).toBeUndefined();
    for (const secret of [
      markdown,
      "Bearer",
      "sk-secret",
      "key-secret",
      "[1,0,0]",
      "full-body",
    ]) {
      expect((error as Error).message).not.toContain(secret);
    }
    expect(harness.store().mutations).toHaveLength(0);
    expect(harness.store().getStats().generation).toBe(generation);
  });

  it("redacts content-like source read failures", async () => {
    const source = new ObsidianMarkdownDocumentSource({
      vault: {
        getMarkdownFiles: () => [{ path: "Safe.md" }] as never[],
        cachedRead: async () => {
          throw new Error("private markdown sk-secret full response");
        },
      },
      metadataCache: { getFileCache: () => null },
    });
    let error: unknown;
    try {
      await source.readAll();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(IndexingSourceError);
    expect((error as IndexingSourceError).cause).toBeUndefined();
    expect((error as Error).message).toBe(
      'Failed to read Markdown document "Safe.md".',
    );
  });
});
