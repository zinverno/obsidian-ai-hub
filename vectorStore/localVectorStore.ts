import {
  decodeVectorBinary,
  encodeVectorBinary,
} from "./binaryCodec";
import {
  VectorStoreCompatibilityError,
  VectorStoreCorruptionError,
  VectorStoreNotInitializedError,
  VectorStorePersistenceError,
  VectorValidationError,
} from "./errors";
import type {
  LocalVectorStoreOptions,
  VectorChunkMetadata,
  VectorEntry,
  VectorSearchOptions,
  VectorSearchResult,
  VectorStore,
  VectorStoreManifest,
  VectorStoreMutation,
  VectorStoreStats,
} from "./types";

export const VECTOR_MANIFEST_SCHEMA_VERSION = 1;
export const VECTOR_MANIFEST_FILE = "vector-manifest.json";
export const VECTOR_BINARY_FILE = "vector-index.bin";
export const VECTOR_MANIFEST_TEMP_FILE = `${VECTOR_MANIFEST_FILE}.tmp`;
export const VECTOR_BINARY_TEMP_FILE = `${VECTOR_BINARY_FILE}.tmp`;
export const VECTOR_MANIFEST_BACKUP_FILE = `${VECTOR_MANIFEST_FILE}.bak`;
export const VECTOR_BINARY_BACKUP_FILE = `${VECTOR_BINARY_FILE}.bak`;

const UINT32_MAX = 0xffff_ffff;
const MIN_VECTOR_NORM = 1e-12;
const STORED_UNIT_NORM_TOLERANCE = 1e-4;

interface StoreState {
  generation: number;
  metadata: readonly VectorChunkMetadata[];
  vectors: Float32Array;
  idToRow: ReadonlyMap<string, number>;
  binaryBytes: number;
}

interface PreparedUpsert {
  metadata: VectorChunkMetadata;
  vector: Float32Array;
}

interface PreparedMutation {
  deleteIds: readonly string[];
  deletePaths: readonly string[];
  upserts: readonly PreparedUpsert[];
}

interface PendingRow {
  metadata: VectorChunkMetadata;
  currentRow?: number;
  vector?: Float32Array;
}

interface StorePaths {
  manifest: string;
  binary: string;
  manifestTemp: string;
  binaryTemp: string;
  manifestBackup: string;
  binaryBackup: string;
}

interface Snapshot {
  rawManifest: string;
  binaryBuffer: ArrayBuffer;
  state: StoreState;
}

interface SerializedSnapshot {
  rawManifest: string;
  binaryBuffer: ArrayBuffer;
}

type SnapshotPairInspection =
  | {
      kind: "absent";
      manifestExists: false;
      binaryExists: false;
    }
  | {
      kind: "incomplete";
      manifestExists: boolean;
      binaryExists: boolean;
    }
  | {
      kind: "invalid";
      manifestExists: true;
      binaryExists: true;
      error: VectorStoreCompatibilityError | VectorStoreCorruptionError;
    }
  | {
      kind: "valid";
      manifestExists: true;
      binaryExists: true;
      snapshot: Snapshot;
    };

interface SnapshotPairPaths {
  manifest: string;
  binary: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function cloneMetadata(metadata: VectorChunkMetadata): VectorChunkMetadata {
  const copy: VectorChunkMetadata = {
    id: metadata.id,
    path: metadata.path,
    headingPath: [...metadata.headingPath],
    ordinal: metadata.ordinal,
    contentHash: metadata.contentHash,
    source: {
      startOffset: metadata.source.startOffset,
      endOffset: metadata.source.endOffset,
      startLine: metadata.source.startLine,
      endLine: metadata.source.endLine,
    },
  };
  if (metadata.preview !== undefined) copy.preview = metadata.preview;
  return copy;
}

function metadataProblem(value: unknown): string | null {
  if (!isObject(value)) return "metadata must be an object";
  if (!isNonEmptyString(value.id)) return "id must be a non-empty string";
  if (!isNonEmptyString(value.path)) return "path must be a non-empty string";
  if (
    !Array.isArray(value.headingPath) ||
    !value.headingPath.every((part) => typeof part === "string")
  ) {
    return "headingPath must be an array of strings";
  }
  if (!isNonNegativeSafeInteger(value.ordinal)) {
    return "ordinal must be a non-negative safe integer";
  }
  if (!isNonEmptyString(value.contentHash)) {
    return "contentHash must be a non-empty string";
  }
  if (!isObject(value.source)) return "source must be an object";

  const { startOffset, endOffset, startLine, endLine } = value.source;
  if (
    !isNonNegativeSafeInteger(startOffset) ||
    !isNonNegativeSafeInteger(endOffset) ||
    !isNonNegativeSafeInteger(startLine) ||
    !isNonNegativeSafeInteger(endLine) ||
    startOffset > endOffset ||
    startLine > endLine
  ) {
    return "source range is invalid";
  }
  if (value.preview !== undefined && typeof value.preview !== "string") {
    return "preview must be a string";
  }
  return null;
}

function validatedMetadata(value: unknown): VectorChunkMetadata {
  const problem = metadataProblem(value);
  if (problem) {
    throw new VectorValidationError(`Invalid vector metadata: ${problem}.`);
  }
  return cloneMetadata(value as unknown as VectorChunkMetadata);
}

function loadedMetadata(value: unknown): VectorChunkMetadata {
  const problem = metadataProblem(value);
  if (problem) {
    throw new VectorStoreCorruptionError(
      `Vector manifest contains invalid metadata: ${problem}.`,
    );
  }
  return cloneMetadata(value as unknown as VectorChunkMetadata);
}

function normalizedVectorCopy(
  value: unknown,
  dimensions: number,
  label: string,
): Float32Array {
  if (!(value instanceof Float32Array)) {
    throw new VectorValidationError(`${label} must be a Float32Array.`);
  }
  if (value.length !== dimensions) {
    throw new VectorValidationError(
      `${label} dimensions do not match the vector store.`,
    );
  }

  let squaredNorm = 0;
  for (let index = 0; index < value.length; index++) {
    const component = value[index];
    if (!Number.isFinite(component)) {
      throw new VectorValidationError(`${label} contains a non-finite value.`);
    }
    squaredNorm += component * component;
  }
  const norm = Math.sqrt(squaredNorm);
  if (!Number.isFinite(norm) || norm <= MIN_VECTOR_NORM) {
    throw new VectorValidationError(`${label} has a zero or near-zero norm.`);
  }

  const normalized = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index++) {
    normalized[index] = value[index] / norm;
  }
  return normalized;
}

function assertLoadedUnitVectors(
  vectors: Float32Array,
  count: number,
  dimensions: number,
): void {
  for (let row = 0; row < count; row++) {
    let squaredNorm = 0;
    const start = row * dimensions;
    for (let column = 0; column < dimensions; column++) {
      const value = vectors[start + column];
      if (!Number.isFinite(value)) {
        throw new VectorStoreCorruptionError(
          "Stored vector contains a non-finite value.",
        );
      }
      squaredNorm += value * value;
    }
    const norm = Math.sqrt(squaredNorm);
    if (
      !Number.isFinite(norm) ||
      norm <= MIN_VECTOR_NORM ||
      Math.abs(norm - 1) > STORED_UNIT_NORM_TOLERANCE
    ) {
      throw new VectorStoreCorruptionError(
        "Stored vector is not unit-normalized.",
      );
    }
  }
}

function createState(
  generation: number,
  metadata: readonly VectorChunkMetadata[],
  vectors: Float32Array,
  binaryBytes: number,
): StoreState {
  const idToRow = new Map<string, number>();
  for (let row = 0; row < metadata.length; row++) {
    const id = metadata[row].id;
    if (idToRow.has(id)) {
      throw new VectorStoreCorruptionError(
        "Vector store contains duplicate record ids.",
      );
    }
    idToRow.set(id, row);
  }
  return { generation, metadata, vectors, idToRow, binaryBytes };
}

function emptyState(dimensions: number): StoreState {
  return createState(0, [], new Float32Array(0 * dimensions), 0);
}

export function normalizeVectorStoreBasePath(basePath: string): string {
  if (typeof basePath !== "string" || basePath.length === 0) {
    throw new VectorValidationError(
      "Vector store basePath must be a non-empty string.",
    );
  }
  const withForwardSlashes = basePath.replace(/\\/g, "/");
  if (
    withForwardSlashes.startsWith("/") ||
    /^[A-Za-z]:\//.test(withForwardSlashes)
  ) {
    throw new VectorValidationError(
      "Vector store basePath must be vault-relative.",
    );
  }

  const parts: string[] = [];
  for (const part of withForwardSlashes.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." || part.includes("\0")) {
      throw new VectorValidationError(
        "Vector store basePath contains an unsafe segment.",
      );
    }
    parts.push(part);
  }
  if (parts.length === 0) {
    throw new VectorValidationError(
      "Vector store basePath must identify a directory.",
    );
  }
  return parts.join("/");
}

function joinPath(basePath: string, fileName: string): string {
  return `${basePath}/${fileName}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseManifest(raw: string): VectorStoreManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new VectorStoreCorruptionError("Vector manifest is not valid JSON.");
  }
  if (!isObject(value)) {
    throw new VectorStoreCorruptionError(
      "Vector manifest root must be an object.",
    );
  }
  if (!Number.isSafeInteger(value.schemaVersion)) {
    throw new VectorStoreCorruptionError(
      "Vector manifest schemaVersion is invalid.",
    );
  }
  if (value.schemaVersion !== VECTOR_MANIFEST_SCHEMA_VERSION) {
    throw new VectorStoreCompatibilityError(
      `Unsupported vector manifest schema version: ${value.schemaVersion}.`,
    );
  }
  if (
    !isNonNegativeSafeInteger(value.generation) ||
    (value.generation as number) > UINT32_MAX
  ) {
    throw new VectorStoreCorruptionError(
      "Vector manifest generation is invalid.",
    );
  }
  if (
    !Number.isSafeInteger(value.dimensions) ||
    (value.dimensions as number) <= 0 ||
    (value.dimensions as number) > UINT32_MAX
  ) {
    throw new VectorStoreCorruptionError(
      "Vector manifest dimensions are invalid.",
    );
  }
  if (!isNonEmptyString(value.embeddingSpaceId)) {
    throw new VectorStoreCorruptionError(
      "Vector manifest embeddingSpaceId is invalid.",
    );
  }
  if (value.normalized !== true) {
    throw new VectorStoreCompatibilityError(
      "Vector manifest does not describe normalized vectors.",
    );
  }
  if (
    !isNonNegativeSafeInteger(value.count) ||
    (value.count as number) > UINT32_MAX
  ) {
    throw new VectorStoreCorruptionError("Vector manifest count is invalid.");
  }
  if (value.binaryFile !== VECTOR_BINARY_FILE) {
    throw new VectorStoreCompatibilityError(
      "Vector manifest references an unsupported binary file.",
    );
  }
  if (!Array.isArray(value.records)) {
    throw new VectorStoreCorruptionError(
      "Vector manifest records must be an array.",
    );
  }
  if (value.records.length !== value.count) {
    throw new VectorStoreCorruptionError(
      "Vector manifest count does not match its records.",
    );
  }

  const records = value.records.map(loadedMetadata);
  const ids = new Set<string>();
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (ids.has(record.id)) {
      throw new VectorStoreCorruptionError(
        "Vector manifest contains duplicate record ids.",
      );
    }
    ids.add(record.id);
    if (index > 0 && compareStrings(records[index - 1].id, record.id) > 0) {
      throw new VectorStoreCorruptionError(
        "Vector manifest records are not in deterministic id order.",
      );
    }
  }

  return {
    schemaVersion: VECTOR_MANIFEST_SCHEMA_VERSION,
    generation: value.generation as number,
    dimensions: value.dimensions as number,
    embeddingSpaceId: value.embeddingSpaceId,
    normalized: true,
    count: value.count as number,
    binaryFile: VECTOR_BINARY_FILE,
    records,
  };
}

function serializeManifest(
  generation: number,
  dimensions: number,
  embeddingSpaceId: string,
  metadata: readonly VectorChunkMetadata[],
): string {
  const manifest: VectorStoreManifest = {
    schemaVersion: VECTOR_MANIFEST_SCHEMA_VERSION,
    generation,
    dimensions,
    embeddingSpaceId,
    normalized: true,
    count: metadata.length,
    binaryFile: VECTOR_BINARY_FILE,
    records: metadata.map(cloneMetadata),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function buffersEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  for (let index = 0; index < leftBytes.length; index++) {
    if (leftBytes[index] !== rightBytes[index]) return false;
  }
  return true;
}

export class LocalVectorStore implements VectorStore {
  private readonly dimensions: number;
  private readonly embeddingSpaceId: string;
  private readonly persistence: LocalVectorStoreOptions["persistence"];
  private readonly basePath: string;
  private readonly paths: StorePaths;

  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private state: StoreState;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: LocalVectorStoreOptions) {
    if (
      !Number.isInteger(options.dimensions) ||
      options.dimensions <= 0 ||
      options.dimensions > UINT32_MAX
    ) {
      throw new VectorValidationError(
        "Vector store dimensions must be a positive integer.",
      );
    }
    if (
      typeof options.embeddingSpaceId !== "string" ||
      options.embeddingSpaceId.trim().length === 0
    ) {
      throw new VectorValidationError(
        "Vector store embeddingSpaceId must be a non-empty string.",
      );
    }
    if (!options.persistence) {
      throw new VectorValidationError(
        "Vector store persistence adapter is required.",
      );
    }

    this.dimensions = options.dimensions;
    this.embeddingSpaceId = options.embeddingSpaceId;
    this.persistence = options.persistence;
    this.basePath = normalizeVectorStoreBasePath(options.basePath);
    this.paths = {
      manifest: joinPath(this.basePath, VECTOR_MANIFEST_FILE),
      binary: joinPath(this.basePath, VECTOR_BINARY_FILE),
      manifestTemp: joinPath(this.basePath, VECTOR_MANIFEST_TEMP_FILE),
      binaryTemp: joinPath(this.basePath, VECTOR_BINARY_TEMP_FILE),
      manifestBackup: joinPath(this.basePath, VECTOR_MANIFEST_BACKUP_FILE),
      binaryBackup: joinPath(this.basePath, VECTOR_BINARY_BACKUP_FILE),
    };
    this.state = emptyState(this.dimensions);
  }

  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initializePromise) return this.initializePromise;

    const pending = this.loadInitialState();
    this.initializePromise = pending;
    void pending.then(
      () => {
        this.initialized = true;
        this.initializePromise = null;
      },
      () => {
        this.initializePromise = null;
      },
    );
    return pending;
  }

  async applyChanges(mutation: VectorStoreMutation): Promise<void> {
    this.requireInitialized();
    const prepared = this.prepareMutation(mutation);
    const operation = this.mutationQueue.then(() =>
      this.applyPreparedMutation(prepared),
    );
    this.mutationQueue = operation.catch(() => undefined);
    return operation;
  }

  async search(
    query: Float32Array,
    options: VectorSearchOptions,
  ): Promise<VectorSearchResult[]> {
    this.requireInitialized();
    if (!options || !Number.isInteger(options.limit) || options.limit <= 0) {
      throw new VectorValidationError(
        "Vector search limit must be a positive integer.",
      );
    }
    if (
      options.minScore !== undefined &&
      !Number.isFinite(options.minScore)
    ) {
      throw new VectorValidationError("Vector search minScore must be finite.");
    }

    const normalizedQuery = normalizedVectorCopy(
      query,
      this.dimensions,
      "Search query",
    );
    const excludedIds = this.stringSet(options.excludeIds, "excludeIds");
    const excludedPaths = this.stringSet(options.excludePaths, "excludePaths");
    const snapshot = this.state;
    const results: VectorSearchResult[] = [];

    for (let row = 0; row < snapshot.metadata.length; row++) {
      const metadata = snapshot.metadata[row];
      if (excludedIds.has(metadata.id) || excludedPaths.has(metadata.path)) {
        continue;
      }

      let score = 0;
      const start = row * this.dimensions;
      for (let column = 0; column < this.dimensions; column++) {
        score += snapshot.vectors[start + column] * normalizedQuery[column];
      }
      score = Math.max(-1, Math.min(1, score));
      if (options.minScore !== undefined && score < options.minScore) continue;

      results.push({ ...cloneMetadata(metadata), score });
    }

    results.sort(
      (left, right) =>
        right.score - left.score || compareStrings(left.id, right.id),
    );
    if (results.length > options.limit) results.length = options.limit;
    return results;
  }

  async clear(): Promise<void> {
    this.requireInitialized();
    const operation = this.mutationQueue.then(() =>
      this.commitSnapshot([], new Float32Array(0)),
    );
    this.mutationQueue = operation.catch(() => undefined);
    return operation;
  }

  getStats(): VectorStoreStats {
    return {
      initialized: this.initialized,
      count: this.state.metadata.length,
      dimensions: this.dimensions,
      embeddingSpaceId: this.embeddingSpaceId,
      generation: this.state.generation,
      binaryBytes: this.state.binaryBytes,
    };
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new VectorStoreNotInitializedError();
  }

  private async loadInitialState(): Promise<void> {
    const [main, backup] = await Promise.all([
      this.inspectSnapshotPair(this.mainPairPaths(), "main"),
      this.inspectSnapshotPair(this.backupPairPaths(), "backup"),
    ]);

    if (main.kind === "valid") {
      this.state = main.snapshot.state;
      await this.cleanupNonAuthoritativeFilesBestEffort();
      return;
    }

    // A complete but incompatible main belongs to a different store contract,
    // not to an interrupted replacement. Never hide that with an older backup.
    if (
      main.kind === "invalid" &&
      main.error instanceof VectorStoreCompatibilityError &&
      backup.kind !== "invalid" &&
      backup.kind !== "incomplete"
    ) {
      throw main.error;
    }

    if (backup.kind === "valid") {
      try {
        const restored = await this.restoreMainFromSnapshot(backup.snapshot);
        this.state = restored.state;
      } catch (error) {
        throw new VectorStorePersistenceError(
          "Failed to recover the main vector-store snapshot from backup; the backup was preserved.",
          error,
        );
      }
      await this.cleanupNonAuthoritativeFilesBestEffort();
      return;
    }

    if (
      main.kind === "absent" &&
      backup.kind === "incomplete" &&
      (await this.isFirstSaveEmptyBackupFragment(backup))
    ) {
      this.state = emptyState(this.dimensions);
      await this.cleanupNonAuthoritativeFilesBestEffort();
      return;
    }

    if (main.kind === "absent" && backup.kind === "absent") {
      this.state = emptyState(this.dimensions);
      await this.cleanupTempFilesBestEffort();
      return;
    }

    if (main.kind === "invalid" && backup.kind === "absent") {
      throw main.error;
    }

    throw new VectorStoreCorruptionError(
      "Neither the main nor backup vector-store snapshot is recoverable.",
    );
  }

  private mainPairPaths(): SnapshotPairPaths {
    return { manifest: this.paths.manifest, binary: this.paths.binary };
  }

  private tempPairPaths(): SnapshotPairPaths {
    return {
      manifest: this.paths.manifestTemp,
      binary: this.paths.binaryTemp,
    };
  }

  private backupPairPaths(): SnapshotPairPaths {
    return {
      manifest: this.paths.manifestBackup,
      binary: this.paths.binaryBackup,
    };
  }

  private decodeSnapshot(
    rawManifest: string,
    binaryBuffer: ArrayBuffer,
  ): Snapshot {
    const manifest = parseManifest(rawManifest);
    if (manifest.dimensions !== this.dimensions) {
      throw new VectorStoreCompatibilityError(
        "Stored vector dimensions do not match the configured dimensions.",
      );
    }
    if (manifest.embeddingSpaceId !== this.embeddingSpaceId) {
      throw new VectorStoreCompatibilityError(
        "Stored embedding space does not match the configured embedding space.",
      );
    }

    const binary = decodeVectorBinary(binaryBuffer);
    if (binary.generation !== manifest.generation) {
      throw new VectorStoreCorruptionError(
        "Vector manifest and binary generations do not match.",
      );
    }
    if (binary.dimensions !== manifest.dimensions) {
      throw new VectorStoreCorruptionError(
        "Vector manifest and binary dimensions do not match.",
      );
    }
    if (binary.count !== manifest.count) {
      throw new VectorStoreCorruptionError(
        "Vector manifest and binary counts do not match.",
      );
    }
    assertLoadedUnitVectors(binary.vectors, binary.count, binary.dimensions);

    return {
      rawManifest,
      binaryBuffer: binaryBuffer.slice(0),
      state: createState(
        manifest.generation,
        manifest.records,
        binary.vectors,
        binaryBuffer.byteLength,
      ),
    };
  }

  private async inspectSnapshotPair(
    paths: SnapshotPairPaths,
    label: string,
  ): Promise<SnapshotPairInspection> {
    let manifestExists: boolean;
    let binaryExists: boolean;
    try {
      [manifestExists, binaryExists] = await Promise.all([
        this.persistence.exists(paths.manifest),
        this.persistence.exists(paths.binary),
      ]);
    } catch (error) {
      throw new VectorStorePersistenceError(
        `Failed to inspect the ${label} vector-store snapshot.`,
        error,
      );
    }

    if (!manifestExists && !binaryExists) {
      return {
        kind: "absent",
        manifestExists: false,
        binaryExists: false,
      };
    }
    if (manifestExists !== binaryExists) {
      return { kind: "incomplete", manifestExists, binaryExists };
    }

    let rawManifest: string;
    let binaryBuffer: ArrayBuffer;
    try {
      [rawManifest, binaryBuffer] = await Promise.all([
        this.persistence.readText(paths.manifest),
        this.persistence.readBinary(paths.binary),
      ]);
    } catch (error) {
      throw new VectorStorePersistenceError(
        `Failed to read the ${label} vector-store snapshot.`,
        error,
      );
    }

    try {
      return {
        kind: "valid",
        manifestExists: true,
        binaryExists: true,
        snapshot: this.decodeSnapshot(rawManifest, binaryBuffer),
      };
    } catch (error) {
      if (
        error instanceof VectorStoreCompatibilityError ||
        error instanceof VectorStoreCorruptionError
      ) {
        return {
          kind: "invalid",
          manifestExists: true,
          binaryExists: true,
          error,
        };
      }
      throw error;
    }
  }

  private assertExactSnapshot(
    snapshot: Snapshot,
    rawManifest: string,
    binaryBuffer: ArrayBuffer,
    label: string,
  ): void {
    if (
      snapshot.rawManifest !== rawManifest ||
      !buffersEqual(snapshot.binaryBuffer, binaryBuffer)
    ) {
      throw new VectorStoreCorruptionError(
        `${label} vector-store snapshot differs from the serialized snapshot.`,
      );
    }
  }

  private async restoreMainFromSnapshot(snapshot: Snapshot): Promise<Snapshot> {
    await this.removeIfPresentStrict(this.paths.binary);
    await this.removeIfPresentStrict(this.paths.manifest);
    await this.persistence.writeBinary(
      this.paths.binary,
      snapshot.binaryBuffer.slice(0),
    );
    await this.persistence.writeText(this.paths.manifest, snapshot.rawManifest);

    const restored = await this.inspectSnapshotPair(
      this.mainPairPaths(),
      "restored main",
    );
    if (restored.kind !== "valid") {
      throw new VectorStoreCorruptionError(
        "The restored main vector-store snapshot is not valid.",
      );
    }
    this.assertExactSnapshot(
      restored.snapshot,
      snapshot.rawManifest,
      snapshot.binaryBuffer,
      "Restored main",
    );
    return restored.snapshot;
  }

  private async isFirstSaveEmptyBackupFragment(
    backup: Extract<SnapshotPairInspection, { kind: "incomplete" }>,
  ): Promise<boolean> {
    // Backup creation always writes binary before manifest. With no main, this
    // exact fragment can only be the completed first write of a generation-0
    // backup. It is a recovery marker, never an authoritative snapshot.
    if (backup.manifestExists || !backup.binaryExists) return false;

    let binaryBuffer: ArrayBuffer;
    try {
      binaryBuffer = await this.persistence.readBinary(
        this.paths.binaryBackup,
      );
    } catch (error) {
      throw new VectorStorePersistenceError(
        "Failed to inspect the first-save empty backup fragment.",
        error,
      );
    }

    try {
      const binary = decodeVectorBinary(binaryBuffer);
      return (
        binary.generation === 0 &&
        binary.dimensions === this.dimensions &&
        binary.count === 0 &&
        binary.vectors.length === 0
      );
    } catch (
      // An invalid or incompatible single file is not sufficient evidence of
      // a first-save boundary and falls through to controlled corruption.
      _error
    ) {
      return false;
    }
  }

  private async removeIfPresentStrict(path: string): Promise<void> {
    if (await this.persistence.exists(path)) {
      await this.persistence.remove(path);
    }
  }

  private async removeBestEffort(path: string): Promise<void> {
    try {
      await this.persistence.remove(path);
    } catch {
      // Cleanup never changes which complete snapshot is authoritative.
    }
  }

  private async cleanupTempFilesBestEffort(): Promise<void> {
    await Promise.all([
      this.removeBestEffort(this.paths.binaryTemp),
      this.removeBestEffort(this.paths.manifestTemp),
    ]);
  }

  private async cleanupBackupFilesBestEffort(): Promise<void> {
    await Promise.all([
      this.removeBestEffort(this.paths.binaryBackup),
      this.removeBestEffort(this.paths.manifestBackup),
    ]);
  }

  private async cleanupFailedBackupBestEffort(): Promise<void> {
    // Keep the first-save crash boundary recognizable: after manifest removal
    // either a valid generation-0 binary marker remains, or backup is absent.
    try {
      await this.persistence.remove(this.paths.manifestBackup);
    } catch {
      return;
    }
    await this.removeBestEffort(this.paths.binaryBackup);
  }

  private async cleanupNonAuthoritativeFilesBestEffort(): Promise<void> {
    await Promise.all([
      this.cleanupTempFilesBestEffort(),
      this.cleanupBackupFilesBestEffort(),
    ]);
  }

  private prepareMutation(mutation: VectorStoreMutation): PreparedMutation {
    if (!isObject(mutation)) {
      throw new VectorValidationError("Vector mutation must be an object.");
    }
    const deleteIds = this.stringArray(mutation.deleteIds, "deleteIds");
    const deletePaths = this.stringArray(mutation.deletePaths, "deletePaths");
    const rawUpserts = mutation.upserts ?? [];
    if (!Array.isArray(rawUpserts)) {
      throw new VectorValidationError("Mutation upserts must be an array.");
    }

    const ids = new Set<string>();
    const upserts: PreparedUpsert[] = rawUpserts.map((entry) => {
      const metadata = validatedMetadata(entry);
      if (ids.has(metadata.id)) {
        throw new VectorValidationError(
          "Mutation contains duplicate upsert ids.",
        );
      }
      ids.add(metadata.id);
      return {
        metadata,
        vector: normalizedVectorCopy(
          (entry as VectorEntry).vector,
          this.dimensions,
          "Upsert vector",
        ),
      };
    });

    return { deleteIds, deletePaths, upserts };
  }

  private stringArray(
    value: unknown,
    label: string,
  ): readonly string[] {
    if (value === undefined) return [];
    if (
      !Array.isArray(value) ||
      !value.every((item) => typeof item === "string")
    ) {
      throw new VectorValidationError(
        `Mutation ${label} must be an array of strings.`,
      );
    }
    return [...value] as string[];
  }

  private stringSet(
    value: readonly string[] | undefined,
    label: string,
  ): ReadonlySet<string> {
    if (value === undefined) return new Set();
    if (
      !Array.isArray(value) ||
      !value.every((item) => typeof item === "string")
    ) {
      throw new VectorValidationError(
        `Vector search ${label} must be an array of strings.`,
      );
    }
    return new Set(value);
  }

  private async applyPreparedMutation(
    mutation: PreparedMutation,
  ): Promise<void> {
    const snapshot = this.state;
    const rows = new Map<string, PendingRow>();
    for (let row = 0; row < snapshot.metadata.length; row++) {
      const metadata = snapshot.metadata[row];
      rows.set(metadata.id, { metadata, currentRow: row });
    }

    if (mutation.deletePaths.length > 0) {
      const deletedPaths = new Set(mutation.deletePaths);
      for (const [id, row] of rows) {
        if (deletedPaths.has(row.metadata.path)) rows.delete(id);
      }
    }
    for (const id of mutation.deleteIds) rows.delete(id);
    for (const upsert of mutation.upserts) {
      rows.set(upsert.metadata.id, {
        metadata: upsert.metadata,
        vector: upsert.vector,
      });
    }

    const sortedRows = [...rows.values()].sort((left, right) =>
      compareStrings(left.metadata.id, right.metadata.id),
    );
    const metadata = sortedRows.map((row) => row.metadata);
    const vectors = new Float32Array(metadata.length * this.dimensions);
    for (let row = 0; row < sortedRows.length; row++) {
      const pending = sortedRows[row];
      const destination = row * this.dimensions;
      if (pending.vector) {
        vectors.set(pending.vector, destination);
      } else if (pending.currentRow !== undefined) {
        const source = pending.currentRow * this.dimensions;
        vectors.set(
          snapshot.vectors.subarray(source, source + this.dimensions),
          destination,
        );
      } else {
        throw new VectorStoreCorruptionError(
          "Vector mutation produced a row without vector data.",
        );
      }
    }

    await this.commitSnapshot(metadata, vectors);
  }

  private async commitSnapshot(
    metadata: readonly VectorChunkMetadata[],
    vectors: Float32Array,
  ): Promise<void> {
    if (this.state.generation >= UINT32_MAX) {
      throw new VectorStorePersistenceError(
        "Vector-store generation limit has been reached.",
      );
    }
    assertLoadedUnitVectors(vectors, metadata.length, this.dimensions);

    const generation = this.state.generation + 1;
    const manifestText = serializeManifest(
      generation,
      this.dimensions,
      this.embeddingSpaceId,
      metadata,
    );
    const binary = encodeVectorBinary(
      generation,
      this.dimensions,
      metadata.length,
      vectors,
    );

    await this.persistSnapshot(manifestText, binary);
    this.state = createState(
      generation,
      metadata,
      vectors,
      binary.byteLength,
    );
    await this.cleanupNonAuthoritativeFilesBestEffort();
  }

  private async persistSnapshot(
    manifestText: string,
    binary: ArrayBuffer,
  ): Promise<void> {
    try {
      await this.persistence.createDirectory(this.basePath);
      await this.persistence.writeBinary(this.paths.binaryTemp, binary);
      await this.persistence.writeText(this.paths.manifestTemp, manifestText);
      const staged = await this.inspectSnapshotPair(
        this.tempPairPaths(),
        "temporary",
      );
      if (staged.kind !== "valid") {
        throw new VectorStoreCorruptionError(
          "Temporary vector-store snapshot is not a complete valid pair.",
        );
      }
      this.assertExactSnapshot(
        staged.snapshot,
        manifestText,
        binary,
        "Temporary",
      );
    } catch (error) {
      await this.cleanupTempFilesBestEffort();
      throw new VectorStorePersistenceError(
        "Failed to stage and validate the temporary vector-store snapshot; the durable snapshot was not changed.",
        error,
      );
    }

    let previousSnapshot: Snapshot;
    try {
      previousSnapshot = await this.createBackupFromCurrentState();
    } catch (error) {
      if (error instanceof VectorStorePersistenceError) throw error;
      throw new VectorStorePersistenceError(
        "Failed to prepare the durable vector-store snapshot for replacement.",
        error,
      );
    }

    try {
      await this.replaceMainWithTemp(
        this.paths.binaryTemp,
        this.paths.binary,
      );
      await this.replaceMainWithTemp(
        this.paths.manifestTemp,
        this.paths.manifest,
      );

      const installed = await this.inspectSnapshotPair(
        this.mainPairPaths(),
        "new main",
      );
      if (installed.kind !== "valid") {
        throw new VectorStoreCorruptionError(
          "Promoted vector-store snapshot is not a complete valid pair.",
        );
      }
      this.assertExactSnapshot(
        installed.snapshot,
        manifestText,
        binary,
        "Promoted main",
      );
    } catch (promotionError) {
      try {
        await this.rollbackPromotion(previousSnapshot);
      } catch (rollbackError) {
        throw new VectorStorePersistenceError(
          "Failed to promote the vector-store snapshot and rollback is incomplete; backup and temporary files were preserved for recovery.",
          { promotionError, rollbackError },
        );
      }

      await this.cleanupNonAuthoritativeFilesBestEffort();
      throw new VectorStorePersistenceError(
        "Failed to promote the vector-store snapshot; the previous durable snapshot was restored.",
        promotionError,
      );
    }

  }

  private serializeStateSnapshot(state: StoreState): SerializedSnapshot {
    return {
      rawManifest: serializeManifest(
        state.generation,
        this.dimensions,
        this.embeddingSpaceId,
        state.metadata,
      ),
      binaryBuffer: encodeVectorBinary(
        state.generation,
        this.dimensions,
        state.metadata.length,
        state.vectors,
      ),
    };
  }

  private async createBackupFromCurrentState(): Promise<Snapshot> {
    let [main, backup] = await Promise.all([
      this.inspectSnapshotPair(this.mainPairPaths(), "main before backup"),
      this.inspectSnapshotPair(
        this.backupPairPaths(),
        "existing backup",
      ),
    ]);

    if (main.kind !== "valid" && backup.kind === "valid") {
      this.assertSnapshotMatchesCurrentState(backup.snapshot);
      try {
        await this.restoreMainFromSnapshot(backup.snapshot);
      } catch (error) {
        throw new VectorStorePersistenceError(
          "Failed to recover the valid backup before replacement; the backup was preserved.",
          error,
        );
      }
      return backup.snapshot;
    }

    const initialEmptyState =
      this.state.generation === 0 && this.state.metadata.length === 0;
    if (main.kind === "valid") {
      this.assertSnapshotMatchesCurrentState(main.snapshot);
    } else if (!(main.kind === "absent" && initialEmptyState)) {
      if (
        main.kind === "invalid" &&
        main.error instanceof VectorStoreCompatibilityError
      ) {
        throw main.error;
      }
      throw new VectorStoreCorruptionError(
        "Cannot create a backup because no unambiguous committed snapshot is available.",
      );
    }

    if (backup.kind !== "absent") {
      try {
        await this.removeInspectedPairStrict(this.backupPairPaths(), backup);
        backup = await this.inspectSnapshotPair(
          this.backupPairPaths(),
          "cleaned backup",
        );
      } catch (error) {
        throw new VectorStorePersistenceError(
          "Stale vector-store backup could not be removed safely.",
          error,
        );
      }
      if (backup.kind !== "absent") {
        throw new VectorStorePersistenceError(
          "Stale vector-store backup remains after cleanup.",
        );
      }
    }

    const serialized = this.serializeStateSnapshot(this.state);
    try {
      await this.persistence.writeBinary(
        this.paths.binaryBackup,
        serialized.binaryBuffer,
      );
      await this.persistence.writeText(
        this.paths.manifestBackup,
        serialized.rawManifest,
      );
      const writtenBackup = await this.inspectSnapshotPair(
        this.backupPairPaths(),
        "written backup",
      );
      if (writtenBackup.kind !== "valid") {
        throw new VectorStoreCorruptionError(
          "Written vector-store backup is not a complete valid pair.",
        );
      }
      this.assertExactSnapshot(
        writtenBackup.snapshot,
        serialized.rawManifest,
        serialized.binaryBuffer,
        "Backup",
      );
      this.assertSnapshotMatchesCurrentState(writtenBackup.snapshot);
      return writtenBackup.snapshot;
    } catch (error) {
      await this.cleanupFailedBackupBestEffort();
      throw new VectorStorePersistenceError(
        "Failed to write and validate a copy of the committed vector-store state as backup; main was not changed.",
        error,
      );
    }
  }

  private async replaceMainWithTemp(
    tempPath: string,
    mainPath: string,
  ): Promise<void> {
    await this.removeIfPresentStrict(mainPath);
    await this.persistence.rename(tempPath, mainPath);
  }

  private assertSnapshotMatchesCurrentState(snapshot: Snapshot): void {
    const current = this.state;
    const durable = snapshot.state;
    if (
      durable.generation !== current.generation ||
      durable.metadata.length !== current.metadata.length ||
      durable.vectors.length !== current.vectors.length
    ) {
      throw new VectorStorePersistenceError(
        "The durable vector-store snapshot changed outside this instance.",
      );
    }
    for (let index = 0; index < current.metadata.length; index++) {
      if (
        JSON.stringify(durable.metadata[index]) !==
        JSON.stringify(current.metadata[index])
      ) {
        throw new VectorStorePersistenceError(
          "The durable vector-store metadata changed outside this instance.",
        );
      }
    }
    for (let index = 0; index < current.vectors.length; index++) {
      if (durable.vectors[index] !== current.vectors[index]) {
        throw new VectorStorePersistenceError(
          "The durable vector-store matrix changed outside this instance.",
        );
      }
    }
  }

  private async removeInspectedPairStrict(
    paths: SnapshotPairPaths,
    inspection: SnapshotPairInspection,
  ): Promise<void> {
    if (inspection.binaryExists) await this.persistence.remove(paths.binary);
    if (inspection.manifestExists) {
      await this.persistence.remove(paths.manifest);
    }
  }

  private async rollbackPromotion(previousSnapshot: Snapshot): Promise<void> {
    await this.restoreMainFromSnapshot(previousSnapshot);
  }
}
