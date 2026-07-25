import type { App } from "obsidian";
import { MarkdownChunker } from "../chunking";
import { createEmbeddingProvider } from "../embeddings/factory";
import type {
  EmbeddingProvider,
  EmbeddingSettings,
} from "../embeddings/types";
import {
  IndexingCompatibilityError,
  IndexingService,
  ObsidianMarkdownDocumentSource,
} from "../indexing";
import {
  LocalVectorStore,
  ObsidianVectorStorePersistence,
  VectorStoreCorruptionError,
  VectorStorePersistenceError,
} from "../vectorStore";
import type { VectorStore } from "../vectorStore";
import {
  SemanticCompatibilityError,
  SemanticNotReadyError,
  SemanticStorageError,
} from "./errors";
import { LazySemanticRuntime } from "./semanticRuntime";
import { SemanticSearchService } from "./semanticSearchService";
import type { SemanticStoreRegistry } from "./semanticStoreRegistry";
import type { SemanticIndexDescriptor } from "./semanticIndexProbe";
import type { SemanticRuntime } from "./types";

export interface ObsidianSemanticRuntimeOptions {
  app: App;
  settings: EmbeddingSettings;
  basePath: string;
  storeRegistry: SemanticStoreRegistry;
  existingDescriptor?: SemanticIndexDescriptor;
}

export function createObsidianSemanticRuntime(
  options: ObsidianSemanticRuntimeOptions,
): SemanticRuntime {
  const settings: EmbeddingSettings = { ...options.settings };
  return new LazySemanticRuntime(async () => {
    const descriptor = options.existingDescriptor;
    let actualProvider: EmbeddingProvider | null = null;
    const provider: EmbeddingProvider = descriptor
      ? {
          id: settings.embeddingProvider,
          model: settings.embeddingModel.trim(),
          dimensions: async () => descriptor.dimensions,
          embed: (texts) => {
            actualProvider ??= createEmbeddingProvider(settings);
            return actualProvider.embed(texts);
          },
        }
      : createEmbeddingProvider(settings);
    const persistence = new ObsidianVectorStorePersistence(
      options.app.vault.adapter,
    );
    let vectorStore: VectorStore | null = null;
    const indexingService = new IndexingService({
      chunker: new MarkdownChunker(),
      embeddingProvider: provider,
      embeddingSpace: {
        providerId: provider.id,
        model: provider.model,
        baseUrl: settings.embeddingBaseUrl,
      },
      vectorStoreFactory: ({ dimensions, embeddingSpaceId }) => {
        if (
          descriptor &&
          (descriptor.dimensions !== dimensions ||
            descriptor.embeddingSpaceId !== embeddingSpaceId)
        ) {
          throw new SemanticCompatibilityError();
        }
        if (vectorStore) {
          throw new SemanticNotReadyError(
            "Semantic VectorStore factory was called more than once.",
          );
        }
        vectorStore = options.storeRegistry.getOrCreateStore({
          basePath: options.basePath,
          dimensions,
          embeddingSpaceId,
          create: () =>
            new LocalVectorStore({
              dimensions,
              embeddingSpaceId,
              persistence,
              basePath: options.basePath,
            }),
        });
        return vectorStore;
      },
    });

    try {
      await indexingService.initialize();
    } catch (error) {
      if (error instanceof IndexingCompatibilityError) {
        throw new SemanticCompatibilityError(error);
      }
      if (
        error instanceof VectorStoreCorruptionError ||
        error instanceof VectorStorePersistenceError
      ) {
        throw new SemanticStorageError(
          "Existing semantic index could not be opened safely.",
          error,
        );
      }
      throw error;
    }

    const stats = indexingService.getStats();
    const store = vectorStore as VectorStore | null;
    if (
      !store ||
      !stats.initialized ||
      !store.getStats().initialized ||
      stats.dimensions <= 0
    ) {
      throw new SemanticNotReadyError(
        "Semantic VectorStore was not initialized.",
      );
    }
    const searchService = new SemanticSearchService(
      provider,
      store,
      stats.dimensions,
    );
    return {
      indexingService,
      searchService,
      vectorStore: store,
      source: new ObsidianMarkdownDocumentSource(options.app),
    };
  });
}
