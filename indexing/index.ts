export {
  IndexingCompatibilityError,
  IndexingError,
  IndexingNotInitializedError,
  IndexingProviderContractError,
  IndexingProviderError,
  IndexingSourceError,
  IndexingValidationError,
} from "./errors";
export {
  buildEmbeddingSpaceId,
  normalizeEmbeddingBaseUrl,
} from "./embeddingSpace";
export { IndexingService } from "./indexingService";
export {
  isMarkdownPath,
  isMarkdownTFile,
  ObsidianMarkdownDocumentSource,
} from "./obsidianDocumentSource";
export type { ObsidianMarkdownSourceApp } from "./obsidianDocumentSource";
export {
  createObsidianIndexingService,
} from "./obsidianFactory";
export type { ObsidianIndexingServiceOptions } from "./obsidianFactory";
export type {
  EmbeddingSpaceDescriptor,
  EmbeddingSpaceDescriptorInput,
  IndexDocumentInput,
  IndexingDocumentChanges,
  IndexingExecutionOptions,
  IndexingRunResult,
  IndexingServiceOptions,
  IndexingServiceStats,
  MarkdownDocumentSource,
  VectorStoreFactory,
} from "./types";
