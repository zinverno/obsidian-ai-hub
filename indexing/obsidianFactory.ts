import type { App } from "obsidian";
import type { ChunkingStrategy } from "../chunking";
import type { EmbeddingProvider } from "../embeddings/types";
import {
  LocalVectorStore,
  ObsidianVectorStorePersistence,
} from "../vectorStore";
import { IndexingService } from "./indexingService";
import type { EmbeddingSpaceDescriptorInput } from "./types";

export interface ObsidianIndexingServiceOptions {
  app: App;
  embeddingProvider: EmbeddingProvider;
  embeddingSpace: EmbeddingSpaceDescriptorInput;
  chunker: ChunkingStrategy;
  basePath?: string;
  embeddingBatchSize?: number;
  previewMaxCodePoints?: number;
}

export async function createObsidianIndexingService(
  options: ObsidianIndexingServiceOptions,
): Promise<IndexingService> {
  const persistence = new ObsidianVectorStorePersistence(
    options.app.vault.adapter,
  );
  const basePath =
    options.basePath ??
    `${options.app.vault.configDir}/plugins/ai-knowledge-hub/semantic-index`;
  const service = new IndexingService({
    chunker: options.chunker,
    embeddingProvider: options.embeddingProvider,
    embeddingSpace: options.embeddingSpace,
    embeddingBatchSize: options.embeddingBatchSize,
    previewMaxCodePoints: options.previewMaxCodePoints,
    vectorStoreFactory: ({ dimensions, embeddingSpaceId }) =>
      new LocalVectorStore({
        dimensions,
        embeddingSpaceId,
        persistence,
        basePath,
      }),
  });
  await service.initialize();
  return service;
}
