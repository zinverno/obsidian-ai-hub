import type {
  ChunkingStrategy,
  MarkdownChunkInput,
} from "../chunking/types";
import type { EmbeddingProvider } from "../embeddings/types";
import type { VectorStore } from "../vectorStore/types";

export interface IndexDocumentInput {
  path: string;
  content: string;
  cache?: MarkdownChunkInput["cache"];
}

export interface IndexingRunResult {
  mode: "partial" | "reconcile" | "delete";
  documentsSeen: number;
  documentsChanged: number;
  documentsUnchanged: number;
  documentsDeleted: number;
  chunksSeen: number;
  chunksEmbedded: number;
  chunksDeleted: number;
  generationBefore: number;
  generationAfter: number;
}

export interface IndexingServiceStats {
  initialized: boolean;
  dimensions: number;
  embeddingSpaceId: string;
  vectorCount: number;
  vectorGeneration: number;
}

export interface EmbeddingSpaceDescriptorInput {
  providerId: string;
  model: string;
  baseUrl: string;
}

export interface EmbeddingSpaceDescriptor
  extends EmbeddingSpaceDescriptorInput {
  dimensions: number;
}

export type VectorStoreFactory = (input: {
  dimensions: number;
  embeddingSpaceId: string;
}) => VectorStore;

export interface IndexingServiceOptions {
  chunker: ChunkingStrategy;
  embeddingProvider: EmbeddingProvider;
  embeddingSpace: EmbeddingSpaceDescriptorInput;
  vectorStoreFactory: VectorStoreFactory;
  embeddingBatchSize?: number;
  previewMaxCodePoints?: number;
}

export interface MarkdownDocumentSource {
  readAll(): Promise<IndexDocumentInput[]>;
}
