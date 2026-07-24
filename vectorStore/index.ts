export {
  decodeVectorBinary,
  encodeVectorBinary,
  vectorBinaryByteLength,
  VECTOR_BINARY_HEADER_BYTES,
  VECTOR_BINARY_MAGIC,
  VECTOR_BINARY_VERSION,
} from "./binaryCodec";
export type { DecodedVectorBinary } from "./binaryCodec";
export {
  VectorStoreCompatibilityError,
  VectorStoreCorruptionError,
  VectorStoreError,
  VectorStoreNotInitializedError,
  VectorStorePersistenceError,
  VectorValidationError,
} from "./errors";
export {
  LocalVectorStore,
  normalizeVectorStoreBasePath,
  VECTOR_BINARY_BACKUP_FILE,
  VECTOR_BINARY_FILE,
  VECTOR_BINARY_TEMP_FILE,
  VECTOR_MANIFEST_BACKUP_FILE,
  VECTOR_MANIFEST_FILE,
  VECTOR_MANIFEST_SCHEMA_VERSION,
  VECTOR_MANIFEST_TEMP_FILE,
} from "./localVectorStore";
export { NullVectorStore } from "./nullVectorStore";
export { ObsidianVectorStorePersistence } from "./obsidianPersistence";
export type {
  LocalVectorStoreOptions,
  VectorChunkMetadata,
  VectorEntry,
  VectorSearchOptions,
  VectorSearchResult,
  VectorStore,
  VectorStoreManifest,
  VectorStoreMutation,
  VectorStorePersistence,
  VectorStoreStats,
} from "./types";
