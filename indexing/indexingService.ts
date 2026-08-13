import type {
  VectorChunkMetadata,
  VectorEntry,
  VectorStore,
  VectorStoreMutation,
} from "../vectorStore/types";
import { VectorStoreCompatibilityError } from "../vectorStore/errors";
import {
  IndexingCompatibilityError,
  IndexingNotInitializedError,
  IndexingProviderContractError,
  IndexingProviderError,
  IndexingValidationError,
} from "./errors";
import { buildEmbeddingSpaceId } from "./embeddingSpace";
import type {
  IndexDocumentInput,
  IndexingDocumentChanges,
  IndexingExecutionOptions,
  IndexingRunResult,
  IndexingServiceOptions,
  IndexingServiceStats,
} from "./types";

const DEFAULT_EMBEDDING_BATCH_SIZE = 32;
const DEFAULT_PREVIEW_MAX_CODE_POINTS = 240;
const MIN_VECTOR_NORM_SQUARED = 1e-24;
const UINT32_MAX = 0xffff_ffff;

interface PreparedChunk {
  metadata: VectorChunkMetadata;
  text: string;
}

interface PreparedDocument {
  path: string;
  chunks: PreparedChunk[];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function cloneMetadata(metadata: VectorChunkMetadata): VectorChunkMetadata {
  const copy: VectorChunkMetadata = {
    id: metadata.id,
    path: metadata.path,
    headingPath: [...metadata.headingPath],
    ordinal: metadata.ordinal,
    contentHash: metadata.contentHash,
    source: { ...metadata.source },
  };
  if (metadata.preview !== undefined) copy.preview = metadata.preview;
  return copy;
}

function metadataEqual(
  left: VectorChunkMetadata,
  right: VectorChunkMetadata,
): boolean {
  if (
    left.id !== right.id ||
    left.path !== right.path ||
    left.ordinal !== right.ordinal ||
    left.contentHash !== right.contentHash ||
    left.preview !== right.preview ||
    left.headingPath.length !== right.headingPath.length ||
    left.source.startOffset !== right.source.startOffset ||
    left.source.endOffset !== right.source.endOffset ||
    left.source.startLine !== right.source.startLine ||
    left.source.endLine !== right.source.endLine
  ) {
    return false;
  }
  for (let index = 0; index < left.headingPath.length; index++) {
    if (left.headingPath[index] !== right.headingPath[index]) return false;
  }
  return true;
}

function validatePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.includes("\\")
  ) {
    throw new IndexingValidationError(
      "Document path must be a canonical vault-relative path.",
    );
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new IndexingValidationError(
      `Document path "${value}" is not canonical.`,
    );
  }
  return value;
}

function previewFromText(text: string, maxCodePoints: number): string | undefined {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  const codePoints = Array.from(normalized);
  return codePoints.length <= maxCodePoints
    ? normalized
    : codePoints.slice(0, maxCodePoints).join("");
}

function validateChunk(
  raw: unknown,
  document: { path: string; content: string },
  previewMaxCodePoints: number,
): PreparedChunk {
  if (!isObject(raw)) {
    throw new IndexingValidationError(
      `Chunking strategy returned an invalid chunk for "${document.path}".`,
    );
  }
  const id = raw.id;
  const path = raw.path;
  const ordinal = raw.ordinal;
  const text = raw.text;
  const contentHash = raw.contentHash;
  const headingPath = raw.headingPath;
  const source = raw.source;
  if (typeof id !== "string" || id.length === 0) {
    throw new IndexingValidationError(
      `Chunk id is invalid for "${document.path}".`,
    );
  }
  if (path !== document.path) {
    throw new IndexingValidationError(
      `Chunk path does not match document "${document.path}".`,
    );
  }
  if (!isNonNegativeSafeInteger(ordinal)) {
    throw new IndexingValidationError(
      `Chunk ordinal is invalid for "${document.path}".`,
    );
  }
  if (typeof text !== "string") {
    throw new IndexingValidationError(
      `Chunk text is invalid for "${document.path}".`,
    );
  }
  if (typeof contentHash !== "string" || contentHash.length === 0) {
    throw new IndexingValidationError(
      `Chunk contentHash is invalid for "${document.path}".`,
    );
  }
  if (
    !Array.isArray(headingPath) ||
    headingPath.some((heading) => typeof heading !== "string")
  ) {
    throw new IndexingValidationError(
      `Chunk headingPath is invalid for "${document.path}".`,
    );
  }
  if (!isObject(source)) {
    throw new IndexingValidationError(
      `Chunk source range is invalid for "${document.path}".`,
    );
  }
  const startOffset = source.startOffset;
  const endOffset = source.endOffset;
  const startLine = source.startLine;
  const endLine = source.endLine;
  if (
    !isNonNegativeSafeInteger(startOffset) ||
    !isNonNegativeSafeInteger(endOffset) ||
    !isNonNegativeSafeInteger(startLine) ||
    !isNonNegativeSafeInteger(endLine) ||
    startOffset > endOffset ||
    endOffset > document.content.length ||
    startLine > endLine
  ) {
    throw new IndexingValidationError(
      `Chunk source range is invalid for "${document.path}".`,
    );
  }

  const metadata: VectorChunkMetadata = {
    id,
    path: document.path,
    headingPath: [...(headingPath as string[])],
    ordinal,
    contentHash,
    source: { startOffset, endOffset, startLine, endLine },
  };
  const preview = previewFromText(text, previewMaxCodePoints);
  if (preview !== undefined) metadata.preview = preview;
  return { metadata, text };
}

export class IndexingService {
  private readonly options: IndexingServiceOptions;
  private readonly embeddingBatchSize: number;
  private readonly previewMaxCodePoints: number;
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private resolvedDimensions: number | undefined;
  private resolvedEmbeddingSpaceId: string | undefined;
  private dimensionsValue = 0;
  private embeddingSpaceIdValue = "";
  private vectorStore: VectorStore | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: IndexingServiceOptions) {
    if (!options?.chunker || typeof options.chunker.chunk !== "function") {
      throw new IndexingValidationError("A chunking strategy is required.");
    }
    if (
      !options.embeddingProvider ||
      typeof options.embeddingProvider.embed !== "function" ||
      typeof options.embeddingProvider.dimensions !== "function"
    ) {
      throw new IndexingValidationError("An embedding provider is required.");
    }
    if (typeof options.vectorStoreFactory !== "function") {
      throw new IndexingValidationError("A VectorStore factory is required.");
    }
    this.embeddingBatchSize =
      options.embeddingBatchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE;
    this.previewMaxCodePoints =
      options.previewMaxCodePoints ?? DEFAULT_PREVIEW_MAX_CODE_POINTS;
    if (
      !Number.isSafeInteger(this.embeddingBatchSize) ||
      this.embeddingBatchSize <= 0
    ) {
      throw new IndexingValidationError(
        "embeddingBatchSize must be a positive safe integer.",
      );
    }
    if (
      !Number.isSafeInteger(this.previewMaxCodePoints) ||
      this.previewMaxCodePoints <= 0
    ) {
      throw new IndexingValidationError(
        "previewMaxCodePoints must be a positive safe integer.",
      );
    }
    this.options = options;
  }

  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
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

  indexDocument(document: IndexDocumentInput): Promise<IndexingRunResult> {
    return this.indexDocuments([document]);
  }

  indexDocuments(
    documents: readonly IndexDocumentInput[],
  ): Promise<IndexingRunResult> {
    this.requireInitialized();
    const prepared = this.prepareDocuments(documents);
    return this.enqueue(() => this.executeDocuments("partial", prepared));
  }

  reconcileAll(
    documents: readonly IndexDocumentInput[],
    options: IndexingExecutionOptions = {},
  ): Promise<IndexingRunResult> {
    this.requireInitialized();
    const prepared = this.prepareDocuments(documents);
    return this.enqueue(() =>
      this.executeDocuments("reconcile", prepared, [], options),
    );
  }

  syncDocuments(
    changes: IndexingDocumentChanges,
    options: IndexingExecutionOptions = {},
  ): Promise<IndexingRunResult> {
    this.requireInitialized();
    if (!isObject(changes)) {
      throw new IndexingValidationError("Document changes are invalid.");
    }
    const prepared = this.prepareDocuments(changes.upsertDocuments);
    if (!Array.isArray(changes.deletePaths)) {
      throw new IndexingValidationError("Document paths must be an array.");
    }
    const deletePathSet = new Set<string>();
    for (const path of changes.deletePaths) {
      deletePathSet.add(validatePath(path));
    }
    for (const document of prepared) {
      if (deletePathSet.has(document.path)) {
        throw new IndexingValidationError(
          `Document path "${document.path}" cannot be upserted and deleted in one batch.`,
        );
      }
    }
    const deletePaths = [...deletePathSet].sort(compareStrings);
    return this.enqueue(() =>
      this.executeDocuments("sync", prepared, deletePaths, options),
    );
  }

  deleteDocuments(paths: readonly string[]): Promise<IndexingRunResult> {
    this.requireInitialized();
    if (!Array.isArray(paths)) {
      throw new IndexingValidationError("Document paths must be an array.");
    }
    const unique = new Set<string>();
    for (const path of paths) unique.add(validatePath(path));
    const preparedPaths = [...unique].sort(compareStrings);
    return this.enqueue(() => this.executeDelete(preparedPaths));
  }

  getStats(): IndexingServiceStats {
    const stats = this.vectorStore?.getStats();
    return {
      initialized: this.initialized,
      dimensions: this.initialized ? this.dimensionsValue : 0,
      embeddingSpaceId: this.initialized ? this.embeddingSpaceIdValue : "",
      vectorCount: this.initialized ? stats?.count ?? 0 : 0,
      vectorGeneration: this.initialized ? stats?.generation ?? 0 : 0,
    };
  }

  private async performInitialize(): Promise<void> {
    let dimensions = this.resolvedDimensions;
    if (dimensions === undefined) {
      try {
        dimensions = await this.options.embeddingProvider.dimensions();
      } catch {
        throw new IndexingProviderError(
          "Embedding provider dimensions request failed.",
        );
      }
      if (
        !Number.isSafeInteger(dimensions) ||
        dimensions <= 0 ||
        dimensions > UINT32_MAX
      ) {
        throw new IndexingValidationError(
          "Embedding provider dimensions must be a positive safe integer.",
        );
      }
      this.resolvedDimensions = dimensions;
    }

    const providerId = this.options.embeddingProvider.id;
    const model = this.options.embeddingProvider.model;
    if (
      !this.options.embeddingSpace ||
      typeof this.options.embeddingSpace.providerId !== "string" ||
      typeof this.options.embeddingSpace.model !== "string" ||
      this.options.embeddingSpace.providerId.trim() !== providerId ||
      this.options.embeddingSpace.model.trim() !== model
    ) {
      throw new IndexingValidationError(
        "Embedding space descriptor must match the provider id and model.",
      );
    }
    const embeddingSpaceId =
      this.resolvedEmbeddingSpaceId ??
      buildEmbeddingSpaceId({
        ...this.options.embeddingSpace,
        dimensions,
      });
    this.resolvedEmbeddingSpaceId = embeddingSpaceId;

    let store: VectorStore;
    try {
      store = this.options.vectorStoreFactory({
        dimensions,
        embeddingSpaceId,
      });
      if (!store || typeof store.initialize !== "function") {
        throw new Error("Invalid VectorStore factory result.");
      }
      await store.initialize();
    } catch (error) {
      if (error instanceof VectorStoreCompatibilityError) {
        throw new IndexingCompatibilityError(
          "Stored semantic index is incompatible with the current embedding space and requires an explicit rebuild.",
          error,
        );
      }
      throw error;
    }

    const stats = store.getStats();
    if (
      !stats.initialized ||
      stats.dimensions !== dimensions ||
      stats.embeddingSpaceId !== embeddingSpaceId
    ) {
      throw new IndexingCompatibilityError(
        "VectorStore stats do not match the configured embedding space.",
      );
    }
    this.vectorStore = store;
    this.dimensionsValue = dimensions;
    this.embeddingSpaceIdValue = embeddingSpaceId;
    this.initialized = true;
  }

  private prepareDocuments(
    documents: readonly IndexDocumentInput[],
  ): PreparedDocument[] {
    if (!Array.isArray(documents)) {
      throw new IndexingValidationError("Documents must be an array.");
    }
    const snapshots: Array<{
      path: string;
      content: string;
      cache: IndexDocumentInput["cache"];
    }> = [];
    const paths = new Set<string>();
    for (const rawDocument of documents) {
      if (!isObject(rawDocument)) {
        throw new IndexingValidationError("Document input is invalid.");
      }
      const path = validatePath(rawDocument.path);
      if (paths.has(path)) {
        throw new IndexingValidationError(
          `Duplicate document path "${path}".`,
        );
      }
      paths.add(path);
      if (typeof rawDocument.content !== "string") {
        throw new IndexingValidationError(
          `Document content is invalid for "${path}".`,
        );
      }
      snapshots.push({
        path,
        content: rawDocument.content,
        cache: rawDocument.cache as IndexDocumentInput["cache"],
      });
    }
    snapshots.sort((left, right) => compareStrings(left.path, right.path));

    const chunkIds = new Set<string>();
    return snapshots.map((document) => {
      let rawChunks: unknown;
      try {
        rawChunks = this.options.chunker.chunk({
          path: document.path,
          content: document.content,
          cache: document.cache,
        });
      } catch {
        throw new IndexingValidationError(
          `Chunking failed for "${document.path}".`,
        );
      }
      if (!Array.isArray(rawChunks)) {
        throw new IndexingValidationError(
          `Chunking strategy returned a non-array for "${document.path}".`,
        );
      }
      const chunks = rawChunks.map((chunk) =>
        validateChunk(chunk, document, this.previewMaxCodePoints),
      );
      chunks.sort(
        (left, right) =>
          left.metadata.ordinal - right.metadata.ordinal ||
          compareStrings(left.metadata.id, right.metadata.id),
      );
      for (const chunk of chunks) {
        if (chunkIds.has(chunk.metadata.id)) {
          throw new IndexingValidationError(
            `Duplicate chunk id "${chunk.metadata.id}".`,
          );
        }
        chunkIds.add(chunk.metadata.id);
      }
      return { path: document.path, chunks };
    });
  }

  private async executeDocuments(
    mode: "partial" | "reconcile" | "sync",
    documents: readonly PreparedDocument[],
    explicitDeletePaths: readonly string[] = [],
    options: IndexingExecutionOptions = {},
  ): Promise<IndexingRunResult> {
    const store = this.requireStore();
    const generationBefore = store.getStats().generation;
    const existing = store.listMetadata();
    const existingById = new Map<string, VectorChunkMetadata>();
    const existingByPath = new Map<string, VectorChunkMetadata[]>();
    for (const metadata of existing) {
      existingById.set(metadata.id, metadata);
      const records = existingByPath.get(metadata.path) ?? [];
      records.push(metadata);
      existingByPath.set(metadata.path, records);
    }

    const documentPaths = new Set(documents.map((document) => document.path));
    const requestedDeletePaths =
      mode === "reconcile"
        ? [...existingByPath.keys()]
            .filter((path) => !documentPaths.has(path))
            .sort(compareStrings)
        : explicitDeletePaths;
    const deletePaths = requestedDeletePaths.filter((path) =>
      existingByPath.has(path),
    );
    const deleteIds: string[] = [];
    const changedChunks: PreparedChunk[] = [];
    const changedDocuments = new Set<string>();
    let chunksSeen = 0;

    for (const document of documents) {
      chunksSeen += document.chunks.length;
      const expectedIds = new Set(
        document.chunks.map((chunk) => chunk.metadata.id),
      );
      for (const previous of existingByPath.get(document.path) ?? []) {
        if (!expectedIds.has(previous.id)) {
          deleteIds.push(previous.id);
          changedDocuments.add(document.path);
        }
      }
      for (const chunk of document.chunks) {
        const previous = existingById.get(chunk.metadata.id);
        if (previous && previous.path !== chunk.metadata.path) {
          throw new IndexingValidationError(
            `Chunk id "${chunk.metadata.id}" collides with another document.`,
          );
        }
        if (!previous || !metadataEqual(previous, chunk.metadata)) {
          changedChunks.push(chunk);
          changedDocuments.add(document.path);
        }
      }
    }
    deleteIds.sort(compareStrings);

    const vectors = await this.embedChangedChunks(changedChunks);
    const upserts: VectorEntry[] = changedChunks.map((chunk, index) => ({
      ...cloneMetadata(chunk.metadata),
      vector: vectors[index],
    }));
    const chunksDeleted =
      deleteIds.length +
      deletePaths.reduce(
        (total, path) => total + (existingByPath.get(path)?.length ?? 0),
        0,
      );
    const mutation: VectorStoreMutation = { deletePaths, deleteIds, upserts };
    const hasMutation =
      mutation.deletePaths!.length > 0 ||
      mutation.deleteIds!.length > 0 ||
      mutation.upserts!.length > 0;
    if (hasMutation && (options.shouldCommit?.() ?? true)) {
      try {
        await store.applyChanges(mutation);
      } catch (error) {
        if (error instanceof VectorStoreCompatibilityError) {
          throw new IndexingCompatibilityError(
            "VectorStore became incompatible during indexing.",
            error,
          );
        }
        throw error;
      }
    }
    const generationAfter = store.getStats().generation;
    return {
      mode,
      documentsSeen: documents.length + explicitDeletePaths.length,
      documentsChanged: changedDocuments.size,
      documentsUnchanged:
        documents.length - changedDocuments.size +
        (mode === "sync"
          ? explicitDeletePaths.length - deletePaths.length
          : 0),
      documentsDeleted: deletePaths.length,
      chunksSeen,
      chunksEmbedded: changedChunks.length,
      chunksDeleted,
      generationBefore,
      generationAfter,
    };
  }

  private async executeDelete(paths: readonly string[]): Promise<IndexingRunResult> {
    const store = this.requireStore();
    const generationBefore = store.getStats().generation;
    const existingByPath = new Map<string, number>();
    for (const metadata of store.listMetadata()) {
      existingByPath.set(
        metadata.path,
        (existingByPath.get(metadata.path) ?? 0) + 1,
      );
    }
    const deletePaths = paths.filter((path) => existingByPath.has(path));
    const chunksDeleted = deletePaths.reduce(
      (total, path) => total + (existingByPath.get(path) ?? 0),
      0,
    );
    if (deletePaths.length > 0) {
      try {
        await store.applyChanges({ deletePaths, deleteIds: [], upserts: [] });
      } catch (error) {
        if (error instanceof VectorStoreCompatibilityError) {
          throw new IndexingCompatibilityError(
            "VectorStore became incompatible during deletion.",
            error,
          );
        }
        throw error;
      }
    }
    return {
      mode: "delete",
      documentsSeen: paths.length,
      documentsChanged: 0,
      documentsUnchanged: paths.length - deletePaths.length,
      documentsDeleted: deletePaths.length,
      chunksSeen: 0,
      chunksEmbedded: 0,
      chunksDeleted,
      generationBefore,
      generationAfter: store.getStats().generation,
    };
  }

  private async embedChangedChunks(
    chunks: readonly PreparedChunk[],
  ): Promise<Float32Array[]> {
    const result: Float32Array[] = [];
    for (
      let start = 0;
      start < chunks.length;
      start += this.embeddingBatchSize
    ) {
      const batch = chunks.slice(start, start + this.embeddingBatchSize);
      const texts = batch.map((chunk) => chunk.text);
      let rawVectors: unknown;
      try {
        rawVectors = await this.options.embeddingProvider.embed(texts);
      } catch {
        throw new IndexingProviderError("Embedding provider request failed.");
      }
      if (!Array.isArray(rawVectors) || rawVectors.length !== batch.length) {
        throw new IndexingProviderContractError(
          "Embedding provider returned an invalid vector count.",
        );
      }
      for (const rawVector of rawVectors) {
        if (!(rawVector instanceof Float32Array)) {
          throw new IndexingProviderContractError(
            "Embedding provider must return Float32Array vectors.",
          );
        }
        if (rawVector.length !== this.dimensionsValue) {
          throw new IndexingProviderContractError(
            "Embedding provider returned a vector with incompatible dimensions.",
          );
        }
        let normSquared = 0;
        for (let index = 0; index < rawVector.length; index++) {
          const value = rawVector[index];
          if (!Number.isFinite(value)) {
            throw new IndexingProviderContractError(
              "Embedding provider returned a non-finite vector.",
            );
          }
          normSquared += value * value;
        }
        if (
          !Number.isFinite(normSquared) ||
          normSquared <= MIN_VECTOR_NORM_SQUARED
        ) {
          throw new IndexingProviderContractError(
            "Embedding provider returned a zero or invalid vector.",
          );
        }
        result.push(new Float32Array(rawVector));
      }
    }
    return result;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operationQueue.then(operation);
    this.operationQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new IndexingNotInitializedError();
  }

  private requireStore(): VectorStore {
    this.requireInitialized();
    if (!this.vectorStore) throw new IndexingNotInitializedError();
    return this.vectorStore;
  }
}
