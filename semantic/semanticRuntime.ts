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
}

export type SemanticRuntimeInitializer =
  () => Promise<SemanticRuntimeComponents>;

export class LazySemanticRuntime implements SemanticRuntime {
  private readonly initializer: SemanticRuntimeInitializer;
  private components: SemanticRuntimeComponents | null = null;
  private initializePromise: Promise<void> | null = null;
  private indexing = false;
  private discoveryService: SemanticDiscoveryService | null = null;

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
        !components.source
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
      this.components = components;
    } catch (error) {
      this.components = null;
      this.discoveryService = null;
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
}
