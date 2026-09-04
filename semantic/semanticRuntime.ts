import type { RagContextBuilder } from "../rag/ragContextBuilder";
import type { RagContext } from "../rag/types";
import { stableHash } from "../chunking/hash";
import type { ChunkingStrategy, NoteChunk } from "../chunking/types";
import type {
  CompanionNote,
  CompanionSemanticDescriptor,
  CompanionSnapshot,
} from "../companionSync/types";
import type {
  IndexDocumentInput,
  IndexingExecutionOptions,
  IndexingRunResult,
  MarkdownDocumentSource,
} from "../indexing/types";
import type { IndexingService } from "../indexing/indexingService";
import { IndexingCompatibilityError } from "../indexing/errors";
import type { VectorStore } from "../vectorStore/types";
import {
  SemanticCompatibilityError,
  SemanticNotReadyError,
} from "./errors";
import type { SemanticSearchService } from "./semanticSearchService";
import { SemanticDiscoveryService } from "./semanticDiscoveryService";
import type {
  SemanticDocumentResult,
  SemanticDocumentSimilarity,
  SemanticDuplicateOptions,
  SemanticDuplicatePair,
  SemanticRuntime,
  SemanticRuntimeStats,
  SemanticPathChanges,
  SemanticSearchOptions,
  SemanticSimilarNotesOptions,
} from "./types";

export interface SemanticRuntimeComponents {
  indexingService: IndexingService;
  searchService: SemanticSearchService;
  discoveryService?: SemanticDiscoveryService;
  vectorStore: VectorStore;
  source: MarkdownDocumentSource;
  ragContextBuilder: RagContextBuilder;
  chunker?: ChunkingStrategy;
  companionDescriptor?: CompanionSemanticDescriptor;
}

export type SemanticRuntimeInitializer =
  () => Promise<SemanticRuntimeComponents>;

export class LazySemanticRuntime implements SemanticRuntime {
  private readonly initializer: SemanticRuntimeInitializer;
  private components: SemanticRuntimeComponents | null = null;
  private initializePromise: Promise<void> | null = null;
  private indexing = false;
  private discoveryService: SemanticDiscoveryService | null = null;
  private ragContextBuilder: RagContextBuilder | null = null;

  constructor(initializer: SemanticRuntimeInitializer) {
    if (typeof initializer !== "function") {
      throw new SemanticNotReadyError(
        "Semantic runtime initializer is required.",
      );
    }
    this.initializer = initializer;
  }

  initialize(): Promise<void> {
    if (this.components) return Promise.resolve();
    if (this.initializePromise) return this.initializePromise;
    const pending = this.performInitialize();
    this.initializePromise = pending;
    void pending.then(
      () => {
        this.initializePromise = null;
      },
      () => {
        this.initializePromise = null;
      },
    );
    return pending;
  }

  async indexVault(
    options: IndexingExecutionOptions = {},
  ): Promise<IndexingRunResult> {
    await this.initialize();
    const components = this.requireComponents();
    this.indexing = true;
    try {
      const documents = await components.source.readAll();
      return await components.indexingService.reconcileAll(documents, options);
    } finally {
      this.indexing = false;
    }
  }

  async syncPaths(
    changes: SemanticPathChanges,
    options: IndexingExecutionOptions = {},
  ): Promise<IndexingRunResult> {
    await this.initialize();
    const components = this.requireComponents();
    this.indexing = true;
    try {
      const selection = await components.source.readPaths(changes.upsertPaths);
      const deletePaths = [
        ...new Set([...changes.deletePaths, ...selection.missingPaths]),
      ];
      return await components.indexingService.syncDocuments(
        {
          upsertDocuments: selection.documents,
          deletePaths,
        },
        options,
      );
    } finally {
      this.indexing = false;
    }
  }

  async indexDocument(
    document: IndexDocumentInput,
  ): Promise<IndexingRunResult> {
    await this.initialize();
    const components = this.requireComponents();
    this.indexing = true;
    try {
      return await components.indexingService.indexDocument(document);
    } finally {
      this.indexing = false;
    }
  }

  async search(
    query: string,
    options?: SemanticSearchOptions,
  ): Promise<SemanticDocumentResult[]> {
    await this.initialize();
    return this.requireComponents().searchService.search(query, options);
  }

  async buildRagContext(question: string): Promise<RagContext> {
    await this.initialize();
    if (!this.ragContextBuilder) throw new SemanticNotReadyError();
    return this.ragContextBuilder.build(question);
  }

  async findSimilarNotes(
    sourcePath: string,
    options?: SemanticSimilarNotesOptions,
  ): Promise<SemanticDocumentSimilarity[]> {
    await this.initialize();
    return this.requireDiscoveryService().findSimilarNotes(sourcePath, options);
  }

  async findPotentialDuplicates(
    options?: SemanticDuplicateOptions,
  ): Promise<SemanticDuplicatePair[]> {
    await this.initialize();
    return this.requireDiscoveryService().findPotentialDuplicates(options);
  }

  async captureCompanionSnapshot(
    paths?: readonly string[],
  ): Promise<CompanionSnapshot> {
    await this.initialize();
    const components = this.requireComponents();
    if (!components.chunker || !components.companionDescriptor) {
      throw new SemanticNotReadyError("Semantic mirror capture is unavailable.");
    }
    const chunker = components.chunker;
    const companionDescriptor = components.companionDescriptor;
    const snapshot = components.vectorStore.readSnapshot();
    const indexedPaths = new Set(snapshot.metadata.map((item) => item.path));
    const requestedPaths = paths
      ? [...new Set(paths)].filter((path) => indexedPaths.has(path)).sort()
      : [...indexedPaths].sort();
    const selection = await components.source.readPaths(requestedPaths);
    const vectorsById = new Map<string, number[]>();
    for (let index = 0; index < snapshot.metadata.length; index++) {
      const metadata = snapshot.metadata[index];
      if (!metadata) continue;
      const start = index * snapshot.dimensions;
      vectorsById.set(
        metadata.id,
        Array.from(snapshot.vectors.slice(start, start + snapshot.dimensions)),
      );
    }
    const metadataByPath = new Map<string, typeof snapshot.metadata>();
    for (const metadata of snapshot.metadata) {
      const current = metadataByPath.get(metadata.path) ?? [];
      current.push(metadata);
      metadataByPath.set(metadata.path, current);
    }
    const notes: CompanionNote[] = [];
    for (const document of selection.documents.sort((left, right) => left.path.localeCompare(right.path))) {
      const chunks = chunker.chunk(document);
      const stored = metadataByPath.get(document.path) ?? [];
      if (chunks.length !== stored.length || !chunks.every((chunk) => this.chunkMatchesStored(chunk, stored))) {
        continue;
      }
      notes.push({
        path: document.path,
        content: document.content,
        contentHash: stableHash(document.content),
        metadata: {},
        chunks: chunks.map((chunk) => ({
          chunkId: chunk.id,
          notePath: chunk.path,
          ordinal: chunk.ordinal,
          headingPath: [...chunk.headingPath],
          text: chunk.text,
          contentHash: chunk.contentHash,
          source: { ...chunk.source },
          embedding: [...(vectorsById.get(chunk.id) ?? [])],
        })),
      });
    }
    return {
      generation: snapshot.generation,
      descriptor: { ...companionDescriptor },
      notes,
    };
  }

  async clear(): Promise<void> {
    await this.initialize();
    await this.requireComponents().vectorStore.clear();
  }

  getStats(): SemanticRuntimeStats {
    const components = this.components;
    if (!components) {
      return {
        initialized: false,
        indexing: this.indexing,
        vectorCount: 0,
        vectorGeneration: 0,
        dimensions: 0,
        embeddingSpaceId: "",
      };
    }
    const stats = components.indexingService.getStats();
    return {
      initialized: stats.initialized,
      indexing: this.indexing,
      vectorCount: stats.vectorCount,
      vectorGeneration: stats.vectorGeneration,
      dimensions: stats.dimensions,
      embeddingSpaceId: stats.embeddingSpaceId,
    };
  }

  private async performInitialize(): Promise<void> {
    try {
      const components = await this.initializer();
      if (
        !components?.indexingService ||
        !components.searchService ||
        !components.vectorStore ||
        !components.source ||
        !components.ragContextBuilder
      ) {
        throw new SemanticNotReadyError(
          "Semantic runtime initializer returned invalid components.",
        );
      }
      const stats = components.vectorStore.getStats();
      this.discoveryService =
        components.discoveryService ??
        new SemanticDiscoveryService(
          components.vectorStore,
          stats.dimensions,
        );
      this.ragContextBuilder = components.ragContextBuilder;
      this.components = components;
    } catch (error) {
      this.components = null;
      this.discoveryService = null;
      this.ragContextBuilder = null;
      if (error instanceof IndexingCompatibilityError) {
        throw new SemanticCompatibilityError(error);
      }
      throw error;
    }
  }

  private requireComponents(): SemanticRuntimeComponents {
    if (!this.components) throw new SemanticNotReadyError();
    return this.components;
  }

  private requireDiscoveryService(): SemanticDiscoveryService {
    if (!this.discoveryService) throw new SemanticNotReadyError();
    return this.discoveryService;
  }

  private chunkMatchesStored(
    chunk: NoteChunk,
    stored: ReturnType<VectorStore["listMetadata"]>,
  ): boolean {
    const metadata = stored.find((item) => item.id === chunk.id);
    return Boolean(
      metadata &&
      metadata.path === chunk.path &&
      metadata.ordinal === chunk.ordinal &&
      metadata.contentHash === chunk.contentHash &&
      metadata.headingPath.length === chunk.headingPath.length &&
      metadata.headingPath.every((heading, index) => heading === chunk.headingPath[index]) &&
      metadata.source.startOffset === chunk.source.startOffset &&
      metadata.source.endOffset === chunk.source.endOffset &&
      metadata.source.startLine === chunk.source.startLine &&
      metadata.source.endLine === chunk.source.endLine
    );
  }
}
