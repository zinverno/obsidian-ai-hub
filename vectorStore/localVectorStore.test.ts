import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeVectorBinary,
  encodeVectorBinary,
  VECTOR_BINARY_HEADER_BYTES,
  VECTOR_BINARY_MAGIC,
  VECTOR_BINARY_VERSION,
} from "./binaryCodec";
import {
  VectorStoreCompatibilityError,
  VectorStoreCorruptionError,
  VectorStoreNotInitializedError,
  VectorStorePersistenceError,
  VectorValidationError,
} from "./errors";
import {
  LocalVectorStore,
  VECTOR_BINARY_BACKUP_FILE,
  VECTOR_BINARY_FILE,
  VECTOR_BINARY_TEMP_FILE,
  VECTOR_MANIFEST_BACKUP_FILE,
  VECTOR_MANIFEST_FILE,
  VECTOR_MANIFEST_TEMP_FILE,
} from "./localVectorStore";
import { NullVectorStore } from "./nullVectorStore";
import type {
  VectorEntry,
  VectorStoreManifest,
  VectorStorePersistence,
} from "./types";

const BASE = ".obsidian/plugins/ai-knowledge-hub/vectors";
const MANIFEST = `${BASE}/${VECTOR_MANIFEST_FILE}`;
const BINARY = `${BASE}/${VECTOR_BINARY_FILE}`;
const MANIFEST_TEMP = `${BASE}/${VECTOR_MANIFEST_TEMP_FILE}`;
const BINARY_TEMP = `${BASE}/${VECTOR_BINARY_TEMP_FILE}`;
const MANIFEST_BACKUP = `${BASE}/${VECTOR_MANIFEST_BACKUP_FILE}`;
const BINARY_BACKUP = `${BASE}/${VECTOR_BINARY_BACKUP_FILE}`;

type StoredValue = { kind: "text"; value: string } | { kind: "binary"; value: ArrayBuffer };

interface FailureRule {
  operation: string;
  path?: string;
  toPath?: string;
  skip?: number;
}

class MemoryPersistence implements VectorStorePersistence {
  readonly files = new Map<string, StoredValue>();
  readonly calls: string[] = [];
  readonly directories = new Set<string>();
  failNext: { operation: string; path?: string } | null = null;
  readonly failures: FailureRule[] = [];
  beforeReadBinary:
    | ((path: string) => void | Promise<void>)
    | undefined;
  beforeRemove:
    | ((path: string) => void | Promise<void>)
    | undefined;
  beforeWriteBinary: (() => Promise<void>) | undefined;
  transformNextBinaryWrite:
    | ((path: string, data: ArrayBuffer) => ArrayBuffer)
    | undefined;
  activeBinaryWrites = 0;
  maxActiveBinaryWrites = 0;

  private fail(operation: string, path: string, toPath?: string): void {
    if (
      this.failNext?.operation === operation &&
      (this.failNext.path === undefined || this.failNext.path === path)
    ) {
      this.failNext = null;
      throw new Error("simulated persistence failure");
    }

    const index = this.failures.findIndex(
      (rule) =>
        rule.operation === operation &&
        (rule.path === undefined || rule.path === path) &&
        (rule.toPath === undefined || rule.toPath === toPath),
    );
    if (index < 0) return;
    const rule = this.failures[index];
    if ((rule.skip ?? 0) > 0) {
      rule.skip = (rule.skip ?? 0) - 1;
      return;
    }
    this.failures.splice(index, 1);
    throw new Error("simulated persistence failure");
  }

  failOn(...rules: FailureRule[]): void {
    this.failures.push(...rules.map((rule) => ({ ...rule })));
  }

  async exists(path: string): Promise<boolean> {
    this.calls.push(`exists:${path}`);
    this.fail("exists", path);
    return this.files.has(path) || this.directories.has(path);
  }

  async readText(path: string): Promise<string> {
    this.calls.push(`readText:${path}`);
    this.fail("readText", path);
    const stored = this.files.get(path);
    if (stored?.kind !== "text") throw new Error("missing text");
    return stored.value;
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    this.calls.push(`readBinary:${path}`);
    await this.beforeReadBinary?.(path);
    this.fail("readBinary", path);
    const stored = this.files.get(path);
    if (stored?.kind !== "binary") throw new Error("missing binary");
    return stored.value.slice(0);
  }

  async writeText(path: string, data: string): Promise<void> {
    this.calls.push(`writeText:${path}`);
    this.fail("writeText", path);
    this.files.set(path, { kind: "text", value: data });
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.calls.push(`writeBinary:${path}`);
    this.fail("writeBinary", path);
    this.activeBinaryWrites++;
    this.maxActiveBinaryWrites = Math.max(
      this.maxActiveBinaryWrites,
      this.activeBinaryWrites,
    );
    try {
      const hook = this.beforeWriteBinary;
      this.beforeWriteBinary = undefined;
      if (hook) await hook();
      const transform = this.transformNextBinaryWrite;
      this.transformNextBinaryWrite = undefined;
      const stored = transform ? transform(path, data.slice(0)) : data;
      this.files.set(path, { kind: "binary", value: stored.slice(0) });
    } finally {
      this.activeBinaryWrites--;
    }
  }

  async createDirectory(path: string): Promise<void> {
    this.calls.push(`createDirectory:${path}`);
    this.fail("createDirectory", path);
    this.directories.add(path);
  }

  async remove(path: string): Promise<void> {
    this.calls.push(`remove:${path}`);
    await this.beforeRemove?.(path);
    this.fail("remove", path);
    if (!this.files.delete(path)) throw new Error("missing file");
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    this.calls.push(`rename:${fromPath}->${toPath}`);
    this.fail("rename", fromPath, toPath);
    const stored = this.files.get(fromPath);
    if (!stored) throw new Error("missing source");
    this.files.set(toPath, stored);
    this.files.delete(fromPath);
  }

  text(path: string): string {
    const stored = this.files.get(path);
    if (stored?.kind !== "text") throw new Error(`Missing text: ${path}`);
    return stored.value;
  }

  binary(path: string): ArrayBuffer {
    const stored = this.files.get(path);
    if (stored?.kind !== "binary") throw new Error(`Missing binary: ${path}`);
    return stored.value.slice(0);
  }

  setText(path: string, value: string): void {
    this.files.set(path, { kind: "text", value });
  }

  setBinary(path: string, value: ArrayBuffer): void {
    this.files.set(path, { kind: "binary", value: value.slice(0) });
  }

  clone(): MemoryPersistence {
    const copy = new MemoryPersistence();
    for (const [path, stored] of this.files) {
      if (stored.kind === "text") copy.setText(path, stored.value);
      else copy.setBinary(path, stored.value);
    }
    for (const directory of this.directories) {
      copy.directories.add(directory);
    }
    return copy;
  }
}

function createStore(
  persistence = new MemoryPersistence(),
  dimensions = 3,
  embeddingSpaceId = "test:model:3",
): LocalVectorStore {
  return new LocalVectorStore({
    dimensions,
    embeddingSpaceId,
    persistence,
    basePath: BASE,
  });
}

function entry(
  id: string,
  vector: Float32Array = new Float32Array([1, 0, 0]),
  overrides: Partial<VectorEntry> = {},
): VectorEntry {
  return {
    id,
    path: `Notes/${id}.md`,
    headingPath: [id],
    ordinal: 0,
    contentHash: `${id.padEnd(16, "0").slice(0, 16)}`,
    source: { startOffset: 0, endOffset: 10, startLine: 0, endLine: 0 },
    vector,
    ...overrides,
  };
}

function recoveryEntry(
  id: "old" | "new" | "a" | "b" | "c",
  vector: Float32Array,
): VectorEntry {
  const index = { old: 1, new: 2, a: 3, b: 4, c: 5 }[id];
  return entry(id, vector, {
    path: `Recovery/${id}.md`,
    headingPath: ["Recovery", id.toUpperCase()],
    ordinal: 10 + index,
    contentHash: `recovery-${id}-hash`,
    source: {
      startOffset: index * 100,
      endOffset: index * 100 + 37,
      startLine: index * 10,
      endLine: index * 10 + 3,
    },
    preview: `Preview for ${id}`,
  });
}

function oldRecoveryEntry(): VectorEntry {
  return recoveryEntry("old", new Float32Array([1, 0, 0]));
}

function newRecoveryEntry(): VectorEntry {
  return recoveryEntry("new", new Float32Array([0, 1, 0]));
}

function clearRecoveryEntries(): VectorEntry[] {
  return [
    recoveryEntry("a", new Float32Array([1, 0, 0])),
    recoveryEntry("b", new Float32Array([0, 1, 0])),
    recoveryEntry("c", new Float32Array([0, 0, 1])),
  ];
}

function metadataOf(entryValue: VectorEntry): Omit<VectorEntry, "vector"> {
  const { vector: _vector, ...metadata } = entryValue;
  return metadata;
}

function manifest(persistence: MemoryPersistence): VectorStoreManifest {
  return JSON.parse(persistence.text(MANIFEST)) as VectorStoreManifest;
}

interface SnapshotFixture {
  manifest: string;
  binary: ArrayBuffer;
}

function captureMain(persistence: MemoryPersistence): SnapshotFixture {
  return {
    manifest: persistence.text(MANIFEST),
    binary: persistence.binary(BINARY),
  };
}

function emptyGenerationZeroSnapshot(): SnapshotFixture {
  const emptyManifest: VectorStoreManifest = {
    schemaVersion: 1,
    generation: 0,
    dimensions: 3,
    embeddingSpaceId: "test:model:3",
    normalized: true,
    count: 0,
    binaryFile: VECTOR_BINARY_FILE,
    records: [],
  };
  return {
    manifest: `${JSON.stringify(emptyManifest, null, 2)}\n`,
    binary: encodeVectorBinary(0, 3, 0, new Float32Array(0)),
  };
}

function installPair(
  persistence: MemoryPersistence,
  manifestPath: string,
  binaryPath: string,
  snapshot: SnapshotFixture,
): void {
  persistence.setText(manifestPath, snapshot.manifest);
  persistence.setBinary(binaryPath, snapshot.binary);
}

function expectPair(
  persistence: MemoryPersistence,
  manifestPath: string,
  binaryPath: string,
  snapshot: SnapshotFixture,
): void {
  expect(persistence.text(manifestPath)).toBe(snapshot.manifest);
  expect(Array.from(new Uint8Array(persistence.binary(binaryPath)))).toEqual(
    Array.from(new Uint8Array(snapshot.binary)),
  );
}

function expectSerializedSnapshot(
  persistence: MemoryPersistence,
  manifestPath: string,
  binaryPath: string,
  generation: number,
  entries: readonly VectorEntry[],
): void {
  const expected = [...entries].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const storedManifest = JSON.parse(
    persistence.text(manifestPath),
  ) as VectorStoreManifest;
  expect(storedManifest).toEqual({
    schemaVersion: 1,
    generation,
    dimensions: 3,
    embeddingSpaceId: "test:model:3",
    normalized: true,
    count: expected.length,
    binaryFile: VECTOR_BINARY_FILE,
    records: expected.map(metadataOf),
  });

  const decoded = decodeVectorBinary(persistence.binary(binaryPath));
  expect(decoded).toMatchObject({
    generation,
    dimensions: 3,
    count: expected.length,
  });
  expect(Array.from(decoded.vectors)).toEqual(
    expected.flatMap((entryValue) => Array.from(entryValue.vector)),
  );
}

async function expectLoadedSnapshot(
  store: LocalVectorStore,
  generation: number,
  entries: readonly VectorEntry[],
): Promise<void> {
  expect(store.getStats()).toMatchObject({
    initialized: true,
    generation,
    count: entries.length,
    dimensions: 3,
    embeddingSpaceId: "test:model:3",
  });

  const expectedIds = entries.map((entryValue) => entryValue.id).sort();
  if (entries.length === 0) {
    for (const query of [
      new Float32Array([1, 0, 0]),
      new Float32Array([0, 1, 0]),
      new Float32Array([0, 0, 1]),
    ]) {
      expect(await store.search(query, { limit: 20 })).toEqual([]);
    }
    return;
  }

  for (const expectedEntry of entries) {
    const results = await store.search(expectedEntry.vector, {
      limit: entries.length,
    });
    expect(results.map((result) => result.id).sort()).toEqual(expectedIds);
    expect(results[0].id).toBe(expectedEntry.id);
    expect(results[0].score).toBeCloseTo(1, 6);
    const { score: _score, ...loadedMetadata } = results[0];
    expect(loadedMetadata).toEqual(metadataOf(expectedEntry));
  }
}

interface ManualGate {
  entered: Promise<void>;
  enter(): Promise<void>;
  release(): void;
}

function createManualGate(): ManualGate {
  let signalEntered!: () => void;
  let signalReleased!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    signalReleased = resolve;
  });
  return {
    entered,
    async enter(): Promise<void> {
      signalEntered();
      await released;
    },
    release(): void {
      signalReleased();
    },
  };
}

async function oldAndNewSnapshots(): Promise<{
  oldSnapshot: SnapshotFixture;
  newSnapshot: SnapshotFixture;
}> {
  const persistence = new MemoryPersistence();
  const { store } = await savedStore(persistence, [oldRecoveryEntry()]);
  const oldSnapshot = captureMain(persistence);
  await store.applyChanges({ upserts: [newRecoveryEntry()] });
  return { oldSnapshot, newSnapshot: captureMain(persistence) };
}

async function oldAndClearedSnapshots(): Promise<{
  oldSnapshot: SnapshotFixture;
  emptySnapshot: SnapshotFixture;
  oldEntries: VectorEntry[];
}> {
  const persistence = new MemoryPersistence();
  const oldEntries = clearRecoveryEntries();
  const { store } = await savedStore(persistence, oldEntries);
  const oldSnapshot = captureMain(persistence);
  await store.clear();
  return {
    oldSnapshot,
    emptySnapshot: captureMain(persistence),
    oldEntries,
  };
}

async function searchIds(
  store: LocalVectorStore,
  query = new Float32Array([1, 0, 0]),
): Promise<string[]> {
  return (await store.search(query, { limit: 20 })).map((result) => result.id);
}

async function savedStore(
  persistence = new MemoryPersistence(),
  entries: VectorEntry[] = [entry("a")],
): Promise<{ persistence: MemoryPersistence; store: LocalVectorStore }> {
  const store = createStore(persistence);
  await store.initialize();
  await store.applyChanges({ upserts: entries });
  return { persistence, store };
}

describe("LocalVectorStore initialization and compatibility", () => {
  it.each([0, -1, 1.5, Number.NaN, 0x1_0000_0000])(
    "rejects invalid configured dimensions %s",
    (dimensions) => {
      expect(() => createStore(new MemoryPersistence(), dimensions)).toThrow(
        VectorValidationError,
      );
    },
  );

  it("rejects an empty embeddingSpaceId and an unsafe basePath", () => {
    expect(() => createStore(new MemoryPersistence(), 3, "  ")).toThrow(
      VectorValidationError,
    );
    expect(
      () =>
        new LocalVectorStore({
          dimensions: 3,
          embeddingSpaceId: "test:model:3",
          persistence: new MemoryPersistence(),
          basePath: "../outside",
        }),
    ).toThrow(VectorValidationError);
  });

  it.each([
    "C:\\vault\\vectors",
    "c:/vault/vectors",
    "Z:\\vectors",
  ])("rejects Windows absolute basePath %s", (basePath) => {
    expect(
      () =>
        new LocalVectorStore({
          dimensions: 3,
          embeddingSpaceId: "test:model:3",
          persistence: new MemoryPersistence(),
          basePath,
        }),
    ).toThrow(VectorValidationError);
  });

  it("initializes an empty in-memory state when both files are absent", async () => {
    const store = createStore();
    await store.initialize();
    expect(store.getStats()).toMatchObject({ initialized: true, count: 0, generation: 0, binaryBytes: 0 });
  });

  it("is idempotent and does not reread after successful initialization", async () => {
    const persistence = new MemoryPersistence();
    const store = createStore(persistence);
    await Promise.all([store.initialize(), store.initialize()]);
    const inspections = persistence.calls.length;
    await store.initialize();
    expect(persistence.calls).toHaveLength(inspections);
  });

  it("shares one concurrent initialize load with exact inspect/read counts", async () => {
    const { persistence } = await savedStore();
    persistence.calls.length = 0;
    const store = createStore(persistence);
    const first = store.initialize();
    const second = store.initialize();
    expect(second).toBe(first);
    await Promise.all([first, second, store.initialize()]);
    expect(persistence.calls.filter((call) => call.startsWith("exists:"))).toHaveLength(4);
    expect(persistence.calls.filter((call) => call === `readText:${MANIFEST}`)).toHaveLength(1);
    expect(persistence.calls.filter((call) => call === `readBinary:${BINARY}`)).toHaveLength(1);
    expect(persistence.calls.filter((call) => call.startsWith("readText:"))).toHaveLength(1);
    expect(persistence.calls.filter((call) => call.startsWith("readBinary:"))).toHaveLength(1);
  });

  it("roundtrips a persisted snapshot through a new instance", async () => {
    const { persistence } = await savedStore(
      new MemoryPersistence(),
      [entry("b", new Float32Array([0, 2, 0])), entry("a")],
    );
    const reloaded = createStore(persistence);
    await reloaded.initialize();
    expect(reloaded.getStats()).toMatchObject({ count: 2, generation: 1 });
    expect((await reloaded.search(new Float32Array([0, 1, 0]), { limit: 2 }))[0].id).toBe("b");
  });

  it("roundtrips c,a,b row correspondence for three independent queries", async () => {
    const { persistence } = await savedStore(new MemoryPersistence(), [
      entry("c", new Float32Array([0, 0, 1])),
      entry("a", new Float32Array([1, 0, 0])),
      entry("b", new Float32Array([0, 1, 0])),
    ]);
    expect(manifest(persistence).records.map((record) => record.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    const reloaded = createStore(persistence);
    await reloaded.initialize();
    expect((await searchIds(reloaded, new Float32Array([1, 0, 0])))[0]).toBe("a");
    expect((await searchIds(reloaded, new Float32Array([0, 1, 0])))[0]).toBe("b");
    expect((await searchIds(reloaded, new Float32Array([0, 0, 1])))[0]).toBe("c");
  });

  it.each([
    ["manifest", MANIFEST, "{}"],
    ["binary", BINARY, new ArrayBuffer(24)],
  ])("rejects a snapshot containing only the %s", async (_name, path, value) => {
    const persistence = new MemoryPersistence();
    if (typeof value === "string") persistence.setText(path, value);
    else persistence.setBinary(path, value);
    await expect(createStore(persistence).initialize()).rejects.toBeInstanceOf(
      VectorStoreCorruptionError,
    );
  });

  it("rejects malformed manifest JSON", async () => {
    const { persistence } = await savedStore();
    persistence.setText(MANIFEST, "{not-json");
    await expect(createStore(persistence).initialize()).rejects.toBeInstanceOf(VectorStoreCorruptionError);
  });

  it("rejects an unknown manifest schema version", async () => {
    const { persistence } = await savedStore();
    const data = manifest(persistence);
    data.schemaVersion = 99;
    persistence.setText(MANIFEST, JSON.stringify(data));
    await expect(createStore(persistence).initialize()).rejects.toBeInstanceOf(VectorStoreCompatibilityError);
  });

  it("rejects an incompatible embedding space", async () => {
    const { persistence } = await savedStore();
    await expect(createStore(persistence, 3, "other:model:3").initialize()).rejects.toBeInstanceOf(
      VectorStoreCompatibilityError,
    );
  });

  it("rejects incompatible configured dimensions", async () => {
    const { persistence } = await savedStore();
    await expect(createStore(persistence, 4, "test:model:3").initialize()).rejects.toBeInstanceOf(
      VectorStoreCompatibilityError,
    );
  });

  it("detects a generation mismatch", async () => {
    const { persistence } = await savedStore();
    const binary = persistence.binary(BINARY);
    new DataView(binary).setUint32(12, 7, true);
    persistence.setBinary(BINARY, binary);
    await expect(createStore(persistence).initialize()).rejects.toBeInstanceOf(VectorStoreCorruptionError);
  });

  it("detects a count mismatch between manifest and binary", async () => {
    const { persistence } = await savedStore();
    const data = manifest(persistence);
    data.count = 0;
    data.records = [];
    persistence.setText(MANIFEST, JSON.stringify(data));
    await expect(createStore(persistence).initialize()).rejects.toBeInstanceOf(VectorStoreCorruptionError);
  });

  it.each([
    ["truncated", (binary: ArrayBuffer) => binary.slice(0, binary.byteLength - 1)],
    ["extra bytes", (binary: ArrayBuffer) => {
      const extended = new Uint8Array(binary.byteLength + 1);
      extended.set(new Uint8Array(binary));
      return extended.buffer;
    }],
  ])("rejects a binary with %s", async (_name, mutate) => {
    const { persistence } = await savedStore();
    persistence.setBinary(BINARY, mutate(persistence.binary(BINARY)));
    await expect(createStore(persistence).initialize()).rejects.toBeInstanceOf(VectorStoreCorruptionError);
  });

  it("rejects invalid binary magic", async () => {
    const { persistence } = await savedStore();
    const binary = persistence.binary(BINARY);
    new DataView(binary).setUint8(0, 0);
    persistence.setBinary(BINARY, binary);
    await expect(createStore(persistence).initialize()).rejects.toBeInstanceOf(VectorStoreCorruptionError);
  });

  it("rejects an unsupported binary version", async () => {
    const { persistence } = await savedStore();
    const binary = persistence.binary(BINARY);
    new DataView(binary).setUint32(8, VECTOR_BINARY_VERSION + 1, true);
    persistence.setBinary(BINARY, binary);
    await expect(createStore(persistence).initialize()).rejects.toBeInstanceOf(VectorStoreCompatibilityError);
  });

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY]])(
    "rejects a stored non-finite component %s",
    async (component) => {
      const { persistence } = await savedStore();
      const binary = persistence.binary(BINARY);
      new DataView(binary).setFloat32(VECTOR_BINARY_HEADER_BYTES, component, true);
      persistence.setBinary(BINARY, binary);
      await expect(createStore(persistence).initialize()).rejects.toBeInstanceOf(VectorStoreCorruptionError);
    },
  );

  it("rejects a finite but non-normalized stored vector", async () => {
    const { persistence } = await savedStore();
    const binary = persistence.binary(BINARY);
    new DataView(binary).setFloat32(VECTOR_BINARY_HEADER_BYTES, 2, true);
    persistence.setBinary(BINARY, binary);
    await expect(createStore(persistence).initialize()).rejects.toBeInstanceOf(VectorStoreCorruptionError);
  });

  it.each<[string, (record: Record<string, unknown>) => void]>([
    ["headingPath", (record) => { record.headingPath = ["valid", 1]; }],
    ["source object", (record) => { record.source = null; }],
    ["unsafe ordinal", (record) => { record.ordinal = Number.MAX_SAFE_INTEGER + 1; }],
    ["negative ordinal", (record) => { record.ordinal = -1; }],
    ["preview", (record) => { record.preview = 42; }],
    ["unsafe startOffset", (record) => {
      (record.source as Record<string, unknown>).startOffset = Number.MAX_SAFE_INTEGER + 1;
    }],
    ["unsafe endOffset", (record) => {
      (record.source as Record<string, unknown>).endOffset = Number.MAX_SAFE_INTEGER + 1;
    }],
    ["unsafe startLine", (record) => {
      (record.source as Record<string, unknown>).startLine = Number.MAX_SAFE_INTEGER + 1;
    }],
    ["unsafe endLine", (record) => {
      (record.source as Record<string, unknown>).endLine = Number.MAX_SAFE_INTEGER + 1;
    }],
    ["reversed offsets", (record) => {
      (record.source as Record<string, unknown>).startOffset = 11;
    }],
    ["reversed lines", (record) => {
      (record.source as Record<string, unknown>).startLine = 2;
    }],
  ])("rejects invalid nested manifest metadata: %s", async (_name, mutate) => {
    const { persistence } = await savedStore();
    const data = JSON.parse(persistence.text(MANIFEST)) as {
      records: Record<string, unknown>[];
    };
    mutate(data.records[0]);
    persistence.setText(MANIFEST, JSON.stringify(data));
    await expect(createStore(persistence).initialize()).rejects.toBeInstanceOf(
      VectorStoreCorruptionError,
    );
  });

  it("rejects duplicate manifest ids with a typed corruption error", async () => {
    const { persistence } = await savedStore(new MemoryPersistence(), [
      entry("a"),
      entry("b"),
    ]);
    const data = manifest(persistence);
    data.records[1].id = data.records[0].id;
    persistence.setText(MANIFEST, JSON.stringify(data));
    await expect(createStore(persistence).initialize()).rejects.toBeInstanceOf(
      VectorStoreCorruptionError,
    );
  });

  it("rejects persisted records outside deterministic id order", async () => {
    const { persistence } = await savedStore(new MemoryPersistence(), [
      entry("a"),
      entry("b"),
    ]);
    const data = manifest(persistence);
    data.records.reverse();
    persistence.setText(MANIFEST, JSON.stringify(data));
    await expect(createStore(persistence).initialize()).rejects.toBeInstanceOf(
      VectorStoreCorruptionError,
    );
  });

  it("rejects a huge malicious header before allocating a matrix", () => {
    const binary = new ArrayBuffer(VECTOR_BINARY_HEADER_BYTES);
    const view = new DataView(binary);
    VECTOR_BINARY_MAGIC.forEach((byte, index) => view.setUint8(index, byte));
    view.setUint32(8, VECTOR_BINARY_VERSION, true);
    view.setUint32(12, 1, true);
    view.setUint32(16, 0xffff_ffff, true);
    view.setUint32(20, 0xffff_ffff, true);
    expect(() => decodeVectorBinary(binary)).toThrow(VectorStoreCorruptionError);
  });

  it("requires initialize before local operations", async () => {
    const store = createStore();
    await expect(store.search(new Float32Array([1, 0, 0]), { limit: 1 })).rejects.toBeInstanceOf(
      VectorStoreNotInitializedError,
    );
    await expect(store.applyChanges({})).rejects.toBeInstanceOf(VectorStoreNotInitializedError);
    await expect(store.clear()).rejects.toBeInstanceOf(VectorStoreNotInitializedError);
  });
});

describe("vector validation and defensive copying", () => {
  it("accepts a correctly dimensioned Float32Array and normalizes its saved copy", async () => {
    const vector = new Float32Array([3, 4, 0]);
    const { persistence } = await savedStore(new MemoryPersistence(), [entry("a", vector)]);
    const view = new DataView(persistence.binary(BINARY));
    expect(view.getFloat32(24, true)).toBeCloseTo(0.6, 6);
    expect(view.getFloat32(28, true)).toBeCloseTo(0.8, 6);
  });

  it.each([
    ["wrong dimensions", new Float32Array([1, 0])],
    ["empty", new Float32Array()],
    ["zero", new Float32Array([0, 0, 0])],
    ["NaN", new Float32Array([Number.NaN, 0, 0])],
    ["Infinity", new Float32Array([Number.POSITIVE_INFINITY, 0, 0])],
  ])("rejects a %s upsert vector", async (_name, vector) => {
    const store = createStore();
    await store.initialize();
    await expect(store.applyChanges({ upserts: [entry("bad", vector)] })).rejects.toBeInstanceOf(
      VectorValidationError,
    );
  });

  it("does not mutate the source vector or metadata", async () => {
    const store = createStore();
    await store.initialize();
    const vector = new Float32Array([3, 4, 0]);
    const input = entry("a", vector, { headingPath: ["Root", "A"], preview: "preview" });
    const before = {
      headingPath: [...input.headingPath],
      source: { ...input.source },
      vector: Array.from(vector),
    };
    await store.applyChanges({ upserts: [input] });
    expect(input.headingPath).toEqual(before.headingPath);
    expect(input.source).toEqual(before.source);
    expect(Array.from(vector)).toEqual(before.vector);
  });

  it("stores defensive copies of vectors and nested metadata", async () => {
    const store = createStore();
    await store.initialize();
    const vector = new Float32Array([1, 0, 0]);
    const input = entry("a", vector, { headingPath: ["Original"] });
    await store.applyChanges({ upserts: [input] });
    vector.set([0, 1, 0]);
    input.headingPath[0] = "Mutated";
    input.source.startOffset = 9;
    const [result] = await store.search(new Float32Array([1, 0, 0]), { limit: 1 });
    expect(result.score).toBeCloseTo(1, 6);
    expect(result.headingPath).toEqual(["Original"]);
    expect(result.source.startOffset).toBe(0);
  });

  it("copies a Float32Array subarray with a non-zero byteOffset", async () => {
    const backing = new Float32Array([9, 1, 0, 0, 9]);
    const subarray = new Float32Array(
      backing.buffer,
      Float32Array.BYTES_PER_ELEMENT,
      3,
    );
    const { store } = await savedStore(new MemoryPersistence(), [
      entry("offset", subarray),
    ]);
    backing.set([0, 0, 1], 1);
    const [result] = await store.search(new Float32Array([1, 0, 0]), {
      limit: 1,
    });
    expect(result).toMatchObject({ id: "offset", score: 1 });
  });

  it("copies vectors that share one backing buffer independently", async () => {
    const backing = new Float32Array([1, 0, 0, 0, 1, 0]);
    const first = backing.subarray(0, 3);
    const second = backing.subarray(3, 6);
    const { store } = await savedStore(new MemoryPersistence(), [
      entry("x", first),
      entry("y", second),
    ]);
    backing.fill(0);
    expect((await searchIds(store, new Float32Array([1, 0, 0])))[0]).toBe("x");
    expect((await searchIds(store, new Float32Array([0, 1, 0])))[0]).toBe("y");
  });

  it("captures vector and metadata before the returned mutation promise settles", async () => {
    const store = createStore();
    await store.initialize();
    const vector = new Float32Array([1, 0, 0]);
    const input = entry("captured", vector, {
      headingPath: ["Before"],
      preview: "before",
    });
    const pending = store.applyChanges({ upserts: [input] });
    vector.set([0, 1, 0]);
    input.headingPath[0] = "After";
    input.source.endOffset = 99;
    input.preview = "after";
    await pending;
    const [result] = await store.search(new Float32Array([1, 0, 0]), {
      limit: 1,
    });
    expect(result).toMatchObject({
      id: "captured",
      headingPath: ["Before"],
      preview: "before",
      source: { endOffset: 10 },
      score: 1,
    });
  });
});

describe("atomic and deterministic mutations", () => {
  it("upserts and replaces an existing id", async () => {
    const { store } = await savedStore();
    await store.applyChanges({ upserts: [entry("a", new Float32Array([0, 1, 0]), { path: "New.md" })] });
    const [result] = await store.search(new Float32Array([0, 1, 0]), { limit: 1 });
    expect(result).toMatchObject({ id: "a", path: "New.md", score: 1 });
    expect(store.getStats().count).toBe(1);
  });

  it("deletes by id and treats a missing id as a successful no-op", async () => {
    const { store } = await savedStore(new MemoryPersistence(), [entry("a"), entry("b")]);
    await store.applyChanges({ deleteIds: ["a"] });
    await store.applyChanges({ deleteIds: ["missing"] });
    expect((await store.search(new Float32Array([1, 0, 0]), { limit: 5 })).map((r) => r.id)).toEqual(["b"]);
  });

  it("commits an empty mutation and advances generation once", async () => {
    const { store } = await savedStore();
    await store.applyChanges({});
    expect(store.getStats()).toMatchObject({ count: 1, generation: 2 });
  });

  it("deletes every chunk for a path and ignores a missing path", async () => {
    const shared = "Shared.md";
    const { store } = await savedStore(new MemoryPersistence(), [
      entry("a", undefined, { path: shared }),
      entry("b", undefined, { path: shared }),
      entry("c"),
    ]);
    await store.applyChanges({ deletePaths: [shared] });
    await store.applyChanges({ deletePaths: ["Missing.md"] });
    expect((await store.search(new Float32Array([1, 0, 0]), { limit: 5 })).map((r) => r.id)).toEqual(["c"]);
  });

  it("orders deletePaths, deleteIds, then upserts for one-file replacement", async () => {
    const { store } = await savedStore(new MemoryPersistence(), [
      entry("old-a", undefined, { path: "File.md" }),
      entry("old-b", undefined, { path: "File.md" }),
    ]);
    await store.applyChanges({
      deletePaths: ["File.md"],
      deleteIds: ["new"],
      upserts: [entry("new", new Float32Array([0, 1, 0]), { path: "File.md" })],
    });
    expect((await store.search(new Float32Array([0, 1, 0]), { limit: 5 })).map((r) => r.id)).toEqual(["new"]);
  });

  it("rejects duplicate ids within one upsert batch", async () => {
    const store = createStore();
    await store.initialize();
    await expect(store.applyChanges({ upserts: [entry("a"), entry("a")] })).rejects.toBeInstanceOf(
      VectorValidationError,
    );
    expect(store.getStats().generation).toBe(0);
  });

  it("validates all entries before applying any part of a mutation", async () => {
    const { store } = await savedStore();
    const before = store.getStats();
    await expect(
      store.applyChanges({
        deleteIds: ["a"],
        upserts: [entry("valid"), entry("bad", new Float32Array([0, 0, 0]))],
      }),
    ).rejects.toBeInstanceOf(VectorValidationError);
    expect(store.getStats()).toEqual(before);
    expect((await store.search(new Float32Array([1, 0, 0]), { limit: 5 }))[0].id).toBe("a");
  });

  it("increments generation only after a successful write and rolls back on failure", async () => {
    const { persistence, store } = await savedStore();
    const before = store.getStats();
    persistence.failNext = { operation: "writeText" };
    await expect(store.applyChanges({ upserts: [entry("b")] })).rejects.toBeInstanceOf(
      VectorStorePersistenceError,
    );
    expect(store.getStats()).toEqual(before);
    expect((await store.search(new Float32Array([1, 0, 0]), { limit: 5 })).map((r) => r.id)).toEqual(["a"]);
  });

  it("serializes concurrent mutations", async () => {
    const persistence = new MemoryPersistence();
    const store = createStore(persistence);
    await store.initialize();
    persistence.beforeWriteBinary = () => new Promise((resolve) => setTimeout(resolve, 5));
    await Promise.all([
      store.applyChanges({ upserts: [entry("a")] }),
      store.applyChanges({ upserts: [entry("b")] }),
    ]);
    expect(persistence.maxActiveBinaryWrites).toBe(1);
    expect(store.getStats()).toMatchObject({ count: 2, generation: 2 });
  });

  it("keeps search on the previous snapshot while a write is pending", async () => {
    const { persistence, store } = await savedStore();
    let release!: () => void;
    let started!: () => void;
    const writeStarted = new Promise<void>((resolve) => { started = resolve; });
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    persistence.beforeWriteBinary = async () => { started(); await blocker; };
    const pending = store.applyChanges({ upserts: [entry("b")] });
    await writeStarted;
    expect((await store.search(new Float32Array([1, 0, 0]), { limit: 5 })).map((r) => r.id)).toEqual(["a"]);
    release();
    await pending;
    expect(store.getStats().count).toBe(2);
  });

  it("does not mutate input arrays", async () => {
    const store = createStore();
    await store.initialize();
    const deleteIds = ["missing"];
    const deletePaths = ["Missing.md"];
    const upserts = [entry("a")];
    const before = { deleteIds: [...deleteIds], deletePaths: [...deletePaths], upserts: [...upserts] };
    await store.applyChanges({ deleteIds, deletePaths, upserts });
    expect(deleteIds).toEqual(before.deleteIds);
    expect(deletePaths).toEqual(before.deletePaths);
    expect(upserts).toEqual(before.upserts);
  });
});

describe("linear cosine search", () => {
  it("returns an empty array for an empty store", async () => {
    const store = createStore();
    await store.initialize();
    expect(await store.search(new Float32Array([1, 0, 0]), { limit: 10 })).toEqual([]);
  });

  it("scores exact, orthogonal and opposite vectors and sorts descending", async () => {
    const { store } = await savedStore(new MemoryPersistence(), [
      entry("exact", new Float32Array([1, 0, 0])),
      entry("orthogonal", new Float32Array([0, 1, 0])),
      entry("opposite", new Float32Array([-1, 0, 0])),
    ]);
    const results = await store.search(new Float32Array([2, 0, 0]), { limit: 10 });
    expect(results.map((r) => r.id)).toEqual(["exact", "orthogonal", "opposite"]);
    expect(results[0].score).toBeCloseTo(1, 6);
    expect(results[1].score).toBeCloseTo(0, 6);
    expect(results[2].score).toBeCloseTo(-1, 6);
  });

  it("uses id as a deterministic score tie-break", async () => {
    const { store } = await savedStore(new MemoryPersistence(), [entry("z"), entry("a")]);
    expect((await store.search(new Float32Array([1, 0, 0]), { limit: 10 })).map((r) => r.id)).toEqual(["a", "z"]);
  });

  it("supports limit values below and above count", async () => {
    const { store } = await savedStore(new MemoryPersistence(), [entry("a"), entry("b")]);
    expect(await store.search(new Float32Array([1, 0, 0]), { limit: 1 })).toHaveLength(1);
    expect(await store.search(new Float32Array([1, 0, 0]), { limit: 99 })).toHaveLength(2);
  });

  it("supports minScore, excludeIds and excludePaths", async () => {
    const { store } = await savedStore(new MemoryPersistence(), [
      entry("a", new Float32Array([1, 0, 0]), { path: "A.md" }),
      entry("b", new Float32Array([0.8, 0.6, 0]), { path: "B.md" }),
      entry("c", new Float32Array([1, 0, 0]), { path: "C.md" }),
      entry("d", new Float32Array([-1, 0, 0]), { path: "D.md" }),
    ]);
    const results = await store.search(new Float32Array([1, 0, 0]), {
      limit: 10,
      minScore: 0,
      excludeIds: ["a"],
      excludePaths: ["C.md"],
    });
    expect(results.map((r) => r.id)).toEqual(["b"]);
  });

  it("applies minScore inclusively and supports values outside cosine range", async () => {
    const { store } = await savedStore(new MemoryPersistence(), [
      entry("exact", new Float32Array([1, 0, 0])),
      entry("opposite", new Float32Array([-1, 0, 0])),
    ]);
    expect(
      await store.search(new Float32Array([1, 0, 0]), {
        limit: 5,
        minScore: 1,
      }),
    ).toHaveLength(1);
    expect(
      await store.search(new Float32Array([1, 0, 0]), {
        limit: 5,
        minScore: 1.01,
      }),
    ).toEqual([]);
    expect(
      await store.search(new Float32Array([1, 0, 0]), {
        limit: 5,
        minScore: -1.01,
      }),
    ).toHaveLength(2);
  });

  it("does not mutate the query", async () => {
    const { store } = await savedStore();
    const query = new Float32Array([3, 4, 0]);
    const before = Array.from(query);
    await store.search(query, { limit: 1 });
    expect(Array.from(query)).toEqual(before);
  });

  it.each([
    ["wrong dimensions", new Float32Array([1, 0])],
    ["zero", new Float32Array([0, 0, 0])],
    ["NaN", new Float32Array([Number.NaN, 0, 0])],
    ["Infinity", new Float32Array([Number.POSITIVE_INFINITY, 0, 0])],
  ])("rejects a %s query", async (_name, query) => {
    const { store } = await savedStore();
    await expect(store.search(query, { limit: 1 })).rejects.toBeInstanceOf(VectorValidationError);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects invalid limit %s", async (limit) => {
    const { store } = await savedStore();
    await expect(store.search(new Float32Array([1, 0, 0]), { limit })).rejects.toBeInstanceOf(
      VectorValidationError,
    );
  });

  it("does not expose vectors and returns safe metadata copies", async () => {
    const { store } = await savedStore(new MemoryPersistence(), [entry("a", undefined, { headingPath: ["Root"] })]);
    const [first] = await store.search(new Float32Array([1, 0, 0]), { limit: 1 });
    expect(first).not.toHaveProperty("vector");
    first.headingPath[0] = "Mutated";
    first.source.startOffset = 9;
    const [second] = await store.search(new Float32Array([1, 0, 0]), { limit: 1 });
    expect(second.headingPath).toEqual(["Root"]);
    expect(second.source.startOffset).toBe(0);
  });

  it("returns identical results for repeated searches", async () => {
    const { store } = await savedStore(new MemoryPersistence(), [entry("b"), entry("a")]);
    const first = await store.search(new Float32Array([1, 0, 0]), { limit: 10 });
    const second = await store.search(new Float32Array([1, 0, 0]), { limit: 10 });
    expect(second).toEqual(first);
  });
});

describe("backup-aware persistence failure matrix", () => {
  it("copies committed generation 1 into backup while generation 2 is pending", async () => {
    const oldEntry = oldRecoveryEntry();
    const newEntry = newRecoveryEntry();
    const { persistence, store } = await savedStore(
      new MemoryPersistence(),
      [oldEntry],
    );
    const committed = captureMain(persistence);
    const gate = createManualGate();
    let blocked = false;
    persistence.beforeRemove = async (path) => {
      if (path === BINARY && !blocked) {
        blocked = true;
        await gate.enter();
      }
    };

    const pending = store.applyChanges({ upserts: [newEntry] });
    await gate.entered;
    const crashDisk = persistence.clone();
    try {
      expectPair(persistence, MANIFEST, BINARY, committed);
      expectSerializedSnapshot(
        persistence,
        MANIFEST_BACKUP,
        BINARY_BACKUP,
        1,
        [oldEntry],
      );
      expectSerializedSnapshot(
        persistence,
        MANIFEST_TEMP,
        BINARY_TEMP,
        2,
        [oldEntry, newEntry],
      );

      const restarted = createStore(crashDisk);
      await restarted.initialize();
      await expectLoadedSnapshot(restarted, 1, [oldEntry]);
    } finally {
      persistence.beforeRemove = undefined;
      gate.release();
      await pending;
    }
    await expectLoadedSnapshot(store, 2, [oldEntry, newEntry]);
  });

  it("creates a complete empty generation-0 backup before first promotion", async () => {
    const persistence = new MemoryPersistence();
    const store = createStore(persistence);
    await store.initialize();
    persistence.failOn(
      {
        operation: "rename",
        path: BINARY_TEMP,
        toPath: BINARY,
      },
      { operation: "writeBinary", path: BINARY },
    );
    await expect(
      store.applyChanges({ upserts: [entry("first")] }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("rollback is incomplete"),
    });
    expect(JSON.parse(persistence.text(MANIFEST_BACKUP))).toMatchObject({
      generation: 0,
      dimensions: 3,
      embeddingSpaceId: "test:model:3",
      count: 0,
      normalized: true,
      records: [],
    });
    expect(decodeVectorBinary(persistence.binary(BINARY_BACKUP))).toMatchObject({
      generation: 0,
      dimensions: 3,
      count: 0,
    });
    const recovered = createStore(persistence);
    await recovered.initialize();
    expect(recovered.getStats()).toMatchObject({ count: 0, generation: 0 });
  });

  it("rejects a corrupted temp pair after read-back without touching main", async () => {
    const { persistence, store } = await savedStore();
    const previous = captureMain(persistence);
    persistence.transformNextBinaryWrite = (path, data) => {
      expect(path).toBe(BINARY_TEMP);
      new DataView(data).setUint32(12, 99, true);
      return data;
    };
    await expect(
      store.applyChanges({ upserts: [entry("new")] }),
    ).rejects.toBeInstanceOf(VectorStorePersistenceError);
    expect(store.getStats()).toMatchObject({ count: 1, generation: 1 });
    expectPair(persistence, MANIFEST, BINARY, previous);
  });

  it.each<[string, FailureRule]>([
    ["directory creation", { operation: "createDirectory", path: BASE }],
    ["binary temp write", { operation: "writeBinary", path: BINARY_TEMP }],
    ["manifest temp write", { operation: "writeText", path: MANIFEST_TEMP }],
    ["binary backup write", {
      operation: "writeBinary",
      path: BINARY_BACKUP,
    }],
    ["manifest backup write", {
      operation: "writeText",
      path: MANIFEST_BACKUP,
    }],
    ["backup validation", {
      operation: "readBinary",
      path: BINARY_BACKUP,
    }],
    ["binary temp to main rename", {
      operation: "rename",
      path: BINARY_TEMP,
      toPath: BINARY,
    }],
    ["manifest temp to main rename", {
      operation: "rename",
      path: MANIFEST_TEMP,
      toPath: MANIFEST,
    }],
    ["new main validation", {
      operation: "readBinary",
      path: BINARY,
      skip: 1,
    }],
  ])("preserves and reloads the old snapshot after %s failure", async (_name, rule) => {
    const { persistence, store } = await savedStore(
      new MemoryPersistence(),
      [entry("old")],
    );
    const previous = captureMain(persistence);
    const before = store.getStats();
    persistence.failOn(rule);
    await expect(
      store.applyChanges({
        upserts: [entry("new", new Float32Array([0, 1, 0]))],
      }),
    ).rejects.toBeInstanceOf(VectorStorePersistenceError);
    expect(store.getStats()).toEqual(before);
    expect(await searchIds(store)).toEqual(["old"]);
    expectPair(persistence, MANIFEST, BINARY, previous);

    const reloaded = createStore(persistence);
    await reloaded.initialize();
    expect(reloaded.getStats()).toMatchObject({ count: 1, generation: 1 });
    expect(await searchIds(reloaded)).toEqual(["old"]);

    await store.applyChanges({
      upserts: [entry("queued", new Float32Array([0, 0, 1]))],
    });
    expect(store.getStats()).toMatchObject({ count: 2, generation: 2 });
  });

  it("aborts safely when stale backup cleanup fails", async () => {
    const { persistence, store } = await savedStore();
    const previous = captureMain(persistence);
    installPair(persistence, MANIFEST_BACKUP, BINARY_BACKUP, previous);
    persistence.failOn({ operation: "remove", path: BINARY_BACKUP });
    await expect(
      store.applyChanges({ upserts: [entry("new")] }),
    ).rejects.toBeInstanceOf(VectorStorePersistenceError);
    expectPair(persistence, MANIFEST, BINARY, previous);
    expectPair(persistence, MANIFEST_BACKUP, BINARY_BACKUP, previous);
    const reloaded = createStore(persistence);
    await reloaded.initialize();
    expect(await searchIds(reloaded)).toEqual(["a"]);
  });

  it("preserves a complete backup when binary rollback restore fails", async () => {
    const { persistence, store } = await savedStore();
    const previous = captureMain(persistence);
    persistence.failOn(
      {
        operation: "rename",
        path: BINARY_TEMP,
        toPath: BINARY,
      },
      { operation: "writeBinary", path: BINARY },
    );
    const failure = store.applyChanges({ upserts: [entry("new")] });
    await expect(failure).rejects.toMatchObject({
      name: "VectorStorePersistenceError",
      message: expect.stringContaining("rollback is incomplete"),
    });
    expectPair(persistence, MANIFEST_BACKUP, BINARY_BACKUP, previous);
    expect(store.getStats()).toMatchObject({ count: 1, generation: 1 });

    const recovered = createStore(persistence);
    await recovered.initialize();
    expect(await searchIds(recovered)).toEqual(["a"]);
    expectPair(persistence, MANIFEST, BINARY, previous);
    await store.applyChanges({ upserts: [entry("after-rollback")] });
    expect(store.getStats()).toMatchObject({ count: 2, generation: 2 });
  });

  it("preserves a complete backup when manifest rollback restore fails", async () => {
    const { persistence, store } = await savedStore();
    const previous = captureMain(persistence);
    persistence.failOn(
      {
        operation: "rename",
        path: MANIFEST_TEMP,
        toPath: MANIFEST,
      },
      { operation: "writeText", path: MANIFEST },
    );
    await expect(
      store.applyChanges({ upserts: [entry("new")] }),
    ).rejects.toMatchObject({
      name: "VectorStorePersistenceError",
      message: expect.stringContaining("rollback is incomplete"),
    });
    expectPair(persistence, MANIFEST_BACKUP, BINARY_BACKUP, previous);
    expect(store.getStats()).toMatchObject({ count: 1, generation: 1 });

    const recovered = createStore(persistence);
    await recovered.initialize();
    expect(await searchIds(recovered)).toEqual(["a"]);
    expectPair(persistence, MANIFEST, BINARY, previous);
    await store.applyChanges({ upserts: [entry("after-rollback")] });
    expect(store.getStats()).toMatchObject({ count: 2, generation: 2 });
  });

  it.each([
    ["binary", { operation: "writeBinary", path: BINARY }],
    ["manifest", { operation: "writeText", path: MANIFEST }],
  ] satisfies Array<[string, FailureRule]>)(
    "preserves generation 1 after new-main validation and %s rollback failure",
    async (_restoredFile, rollbackFailure) => {
      const oldEntry = oldRecoveryEntry();
      const newEntry = newRecoveryEntry();
      const { persistence, store } = await savedStore(
        new MemoryPersistence(),
        [oldEntry],
      );
      persistence.calls.length = 0;
      persistence.failOn(
        { operation: "readBinary", path: BINARY, skip: 1 },
        rollbackFailure,
      );

      await expect(
        store.applyChanges({ upserts: [newEntry] }),
      ).rejects.toMatchObject({
        name: "VectorStorePersistenceError",
        message: expect.stringContaining("rollback is incomplete"),
      });
      await expectLoadedSnapshot(store, 1, [oldEntry]);
      expectSerializedSnapshot(
        persistence,
        MANIFEST_BACKUP,
        BINARY_BACKUP,
        1,
        [oldEntry],
      );
      expect(
        persistence.calls.some(
          (call) =>
            call === `remove:${BINARY_BACKUP}` ||
            call === `remove:${MANIFEST_BACKUP}`,
        ),
      ).toBe(false);

      const recovered = createStore(persistence);
      await recovered.initialize();
      await expectLoadedSnapshot(recovered, 1, [oldEntry]);
      await store.applyChanges({ upserts: [newEntry] });
      await expectLoadedSnapshot(store, 2, [oldEntry, newEntry]);
      const reloaded = createStore(persistence);
      await reloaded.initialize();
      await expectLoadedSnapshot(reloaded, 2, [oldEntry, newEntry]);
    },
  );

  it("continues the mutation queue after a persistence rejection", async () => {
    const { persistence, store } = await savedStore();
    persistence.failOn({ operation: "writeText", path: MANIFEST_TEMP });
    await expect(
      store.applyChanges({ upserts: [entry("failed")] }),
    ).rejects.toBeInstanceOf(VectorStorePersistenceError);
    await store.applyChanges({
      upserts: [entry("success", new Float32Array([0, 1, 0]))],
    });
    expect(store.getStats()).toMatchObject({ count: 2, generation: 2 });
    const reloaded = createStore(persistence);
    await reloaded.initialize();
    expect(await searchIds(reloaded)).toEqual(["a", "success"]);
  });

  it("does not turn backup cleanup failure into a failed commit", async () => {
    const { persistence, store } = await savedStore();
    persistence.failOn({ operation: "remove", path: BINARY_BACKUP });
    await store.applyChanges({ upserts: [entry("new")] });
    expect(store.getStats()).toMatchObject({ count: 2, generation: 2 });
    expect(persistence.files.has(BINARY_BACKUP)).toBe(true);
    const reloaded = createStore(persistence);
    await reloaded.initialize();
    expect(await searchIds(reloaded)).toEqual(["a", "new"]);
  });

  it("does not let stale-temp cleanup failure block a valid main snapshot", async () => {
    const { oldSnapshot, newSnapshot } = await oldAndNewSnapshots();
    const persistence = new MemoryPersistence();
    installPair(persistence, MANIFEST, BINARY, newSnapshot);
    installPair(persistence, MANIFEST_TEMP, BINARY_TEMP, oldSnapshot);
    persistence.failOn({ operation: "remove", path: BINARY_TEMP });
    const store = createStore(persistence);
    await store.initialize();
    await expectLoadedSnapshot(store, 2, [
      oldRecoveryEntry(),
      newRecoveryEntry(),
    ]);
    expect(store.getStats()).toMatchObject({ count: 2, generation: 2 });
    expect(persistence.files.has(BINARY_TEMP)).toBe(true);
    expectPair(persistence, MANIFEST, BINARY, newSnapshot);
  });
});

describe("initialize crash-state recovery", () => {
  it("rejects a legacy split main-manifest/backup-binary state", async () => {
    const { oldSnapshot, newSnapshot } = await oldAndNewSnapshots();
    const persistence = new MemoryPersistence();
    persistence.setText(MANIFEST, oldSnapshot.manifest);
    persistence.setBinary(BINARY_BACKUP, oldSnapshot.binary);
    installPair(persistence, MANIFEST_TEMP, BINARY_TEMP, newSnapshot);
    await expect(createStore(persistence).initialize()).rejects.toBeInstanceOf(
      VectorStoreCorruptionError,
    );
  });

  it("loads valid main after a crash with only the copied binary backup", async () => {
    const { oldSnapshot } = await oldAndNewSnapshots();
    const persistence = new MemoryPersistence();
    installPair(persistence, MANIFEST, BINARY, oldSnapshot);
    persistence.setBinary(BINARY_BACKUP, oldSnapshot.binary);
    const store = createStore(persistence);
    await store.initialize();
    await expectLoadedSnapshot(store, 1, [oldRecoveryEntry()]);
    expect(await searchIds(store)).toEqual(["old"]);
    expectPair(persistence, MANIFEST, BINARY, oldSnapshot);
    expect(persistence.files.has(BINARY_BACKUP)).toBe(false);
  });

  it("loads valid main after a full copied backup was validated before promotion", async () => {
    const { oldSnapshot } = await oldAndNewSnapshots();
    const persistence = new MemoryPersistence();
    installPair(persistence, MANIFEST, BINARY, oldSnapshot);
    installPair(persistence, MANIFEST_BACKUP, BINARY_BACKUP, oldSnapshot);
    const store = createStore(persistence);
    await store.initialize();
    await expectLoadedSnapshot(store, 1, [oldRecoveryEntry()]);
    expect(await searchIds(store)).toEqual(["old"]);
    expectPair(persistence, MANIFEST, BINARY, oldSnapshot);
    expect(persistence.files.has(MANIFEST_BACKUP)).toBe(false);
    expect(persistence.files.has(BINARY_BACKUP)).toBe(false);
  });

  it("recovers empty generation 0 after the first binary-backup write", async () => {
    const { oldSnapshot: firstSnapshot } = await oldAndNewSnapshots();
    const emptySnapshot = emptyGenerationZeroSnapshot();
    const persistence = new MemoryPersistence();
    persistence.setBinary(BINARY_BACKUP, emptySnapshot.binary);
    installPair(persistence, MANIFEST_TEMP, BINARY_TEMP, firstSnapshot);
    const store = createStore(persistence);
    await store.initialize();
    await expectLoadedSnapshot(store, 0, []);
    expect(store.getStats()).toMatchObject({ count: 0, generation: 0 });
    expect(persistence.files.has(BINARY_BACKUP)).toBe(false);
    expect(persistence.files.has(MANIFEST_TEMP)).toBe(false);
    expect(persistence.files.has(BINARY_TEMP)).toBe(false);
  });

  describe("malicious first-save generation-0 marker", () => {
    const validMarker = encodeVectorBinary(0, 3, 0, new Float32Array(0));
    const mutate = (
      source: ArrayBuffer,
      mutation: (view: DataView) => void,
    ): ArrayBuffer => {
      const copy = source.slice(0);
      mutation(new DataView(copy));
      return copy;
    };
    const append = (source: ArrayBuffer, bytes: number): ArrayBuffer => {
      const result = new Uint8Array(source.byteLength + bytes);
      result.set(new Uint8Array(source));
      return result.buffer;
    };
    const invalidCases: Array<{
      name: string;
      binary: ArrayBuffer;
      configure?: (persistence: MemoryPersistence) => void;
    }> = [
      {
        name: "invalid magic",
        binary: mutate(validMarker, (view) => view.setUint8(0, 0)),
      },
      {
        name: "unsupported version",
        binary: mutate(validMarker, (view) => view.setUint32(8, 99, true)),
      },
      {
        name: "generation 1",
        binary: encodeVectorBinary(1, 3, 0, new Float32Array(0)),
      },
      {
        name: "wrong dimensions",
        binary: encodeVectorBinary(0, 2, 0, new Float32Array(0)),
      },
      {
        name: "count 1",
        binary: encodeVectorBinary(0, 3, 1, new Float32Array([1, 0, 0])),
      },
      {
        name: "nonempty matrix with count 0",
        binary: append(validMarker, 3 * Float32Array.BYTES_PER_ELEMENT),
      },
      { name: "truncated header", binary: validMarker.slice(0, 23) },
      { name: "extra byte", binary: append(validMarker, 1) },
      { name: "partial magic and header", binary: validMarker.slice(0, 12) },
      {
        name: "NaN vector bytes with count 0",
        binary: (() => {
          const value = append(validMarker, Float32Array.BYTES_PER_ELEMENT);
          new DataView(value).setFloat32(
            VECTOR_BINARY_HEADER_BYTES,
            Number.NaN,
            true,
          );
          return value;
        })(),
      },
      {
        name: "contradictory backup manifest",
        binary: validMarker,
        configure: (persistence) => {
          const contradictory = emptyGenerationZeroSnapshot().manifest.replace(
            '"generation": 0',
            '"generation": 1',
          );
          persistence.setText(MANIFEST_BACKUP, contradictory);
        },
      },
      {
        name: "adjacent main manifest",
        binary: validMarker,
        configure: (persistence) =>
          persistence.setText(
            MANIFEST,
            emptyGenerationZeroSnapshot().manifest,
          ),
      },
      {
        name: "adjacent lone main binary",
        binary: validMarker,
        configure: (persistence) =>
          persistence.setBinary(BINARY, validMarker),
      },
      {
        name: "backup manifest for another embedding space",
        binary: validMarker,
        configure: (persistence) => {
          const contradictory = emptyGenerationZeroSnapshot().manifest.replace(
            "test:model:3",
            "other:model:3",
          );
          persistence.setText(MANIFEST_BACKUP, contradictory);
        },
      },
      {
        name: "arbitrary valid nonempty generation-0 binary",
        binary: encodeVectorBinary(
          0,
          3,
          2,
          new Float32Array([1, 0, 0, 0, 1, 0]),
        ),
      },
    ];

    it.each(invalidCases)("rejects $name", async ({ binary, configure }) => {
      const { oldSnapshot: pendingSnapshot } = await oldAndNewSnapshots();
      const persistence = new MemoryPersistence();
      persistence.setBinary(BINARY_BACKUP, binary);
      installPair(
        persistence,
        MANIFEST_TEMP,
        BINARY_TEMP,
        pendingSnapshot,
      );
      configure?.(persistence);

      await expect(createStore(persistence).initialize()).rejects.toBeInstanceOf(
        VectorStoreCorruptionError,
      );
      expect(persistence.files.has(BINARY_BACKUP)).toBe(true);
      expect(persistence.files.has(MANIFEST_TEMP)).toBe(true);
      expect(persistence.files.has(BINARY_TEMP)).toBe(true);
    });
  });

  it("restores empty generation 0 from a full backup before first promotion", async () => {
    const { oldSnapshot: firstSnapshot } = await oldAndNewSnapshots();
    const emptySnapshot = emptyGenerationZeroSnapshot();
    const persistence = new MemoryPersistence();
    installPair(
      persistence,
      MANIFEST_BACKUP,
      BINARY_BACKUP,
      emptySnapshot,
    );
    installPair(persistence, MANIFEST_TEMP, BINARY_TEMP, firstSnapshot);
    const store = createStore(persistence);
    await store.initialize();
    await expectLoadedSnapshot(store, 0, []);
    expect(store.getStats()).toMatchObject({ count: 0, generation: 0 });
    expectPair(persistence, MANIFEST, BINARY, emptySnapshot);
  });

  it("restores empty generation 0 after first-save binary promotion", async () => {
    const { oldSnapshot: firstSnapshot } = await oldAndNewSnapshots();
    const emptySnapshot = emptyGenerationZeroSnapshot();
    const persistence = new MemoryPersistence();
    persistence.setBinary(BINARY, firstSnapshot.binary);
    persistence.setText(MANIFEST_TEMP, firstSnapshot.manifest);
    installPair(
      persistence,
      MANIFEST_BACKUP,
      BINARY_BACKUP,
      emptySnapshot,
    );
    const store = createStore(persistence);
    await store.initialize();
    await expectLoadedSnapshot(store, 0, []);
    expect(store.getStats()).toMatchObject({ count: 0, generation: 0 });
    expectPair(persistence, MANIFEST, BINARY, emptySnapshot);
  });

  it("restores empty generation 0 over a mixed first-save main", async () => {
    const { oldSnapshot: firstSnapshot } = await oldAndNewSnapshots();
    const emptySnapshot = emptyGenerationZeroSnapshot();
    const persistence = new MemoryPersistence();
    persistence.setBinary(BINARY, firstSnapshot.binary);
    persistence.setText(MANIFEST, emptySnapshot.manifest);
    installPair(
      persistence,
      MANIFEST_BACKUP,
      BINARY_BACKUP,
      emptySnapshot,
    );
    const store = createStore(persistence);
    await store.initialize();
    await expectLoadedSnapshot(store, 0, []);
    expect(store.getStats()).toMatchObject({ count: 0, generation: 0 });
    expectPair(persistence, MANIFEST, BINARY, emptySnapshot);
  });

  it("loads a valid new main over the empty generation-0 backup", async () => {
    const { oldSnapshot: firstSnapshot } = await oldAndNewSnapshots();
    const emptySnapshot = emptyGenerationZeroSnapshot();
    const persistence = new MemoryPersistence();
    installPair(persistence, MANIFEST, BINARY, firstSnapshot);
    installPair(
      persistence,
      MANIFEST_BACKUP,
      BINARY_BACKUP,
      emptySnapshot,
    );
    const store = createStore(persistence);
    await store.initialize();
    await expectLoadedSnapshot(store, 1, [oldRecoveryEntry()]);
    expect(store.getStats()).toMatchObject({ count: 1, generation: 1 });
    expect(await searchIds(store)).toEqual(["old"]);
    expectPair(persistence, MANIFEST, BINARY, firstSnapshot);
  });

  it.each(["binary", "manifest"])(
    "restores full backup after rollback wrote only main %s",
    async (restoredFile) => {
      const { oldSnapshot } = await oldAndNewSnapshots();
      const persistence = new MemoryPersistence();
      installPair(
        persistence,
        MANIFEST_BACKUP,
        BINARY_BACKUP,
        oldSnapshot,
      );
      if (restoredFile === "binary") {
        persistence.setBinary(BINARY, oldSnapshot.binary);
      } else {
        persistence.setText(MANIFEST, oldSnapshot.manifest);
      }
      const store = createStore(persistence);
      await store.initialize();
      await expectLoadedSnapshot(store, 1, [oldRecoveryEntry()]);
      expect(await searchIds(store)).toEqual(["old"]);
      expectPair(persistence, MANIFEST, BINARY, oldSnapshot);
    },
  );

  it("loads old valid main and never promotes newer temp files", async () => {
    const { oldSnapshot, newSnapshot } = await oldAndNewSnapshots();
    const persistence = new MemoryPersistence();
    installPair(persistence, MANIFEST, BINARY, oldSnapshot);
    installPair(persistence, MANIFEST_TEMP, BINARY_TEMP, newSnapshot);
    const store = createStore(persistence);
    await store.initialize();
    await expectLoadedSnapshot(store, 1, [oldRecoveryEntry()]);
    expect(store.getStats()).toMatchObject({ count: 1, generation: 1 });
    expect(await searchIds(store)).toEqual(["old"]);
    expectPair(persistence, MANIFEST, BINARY, oldSnapshot);
    expect(persistence.files.has(MANIFEST_TEMP)).toBe(false);
    expect(persistence.files.has(BINARY_TEMP)).toBe(false);
  });

  it("restores an absent main from a complete valid backup", async () => {
    const { oldSnapshot } = await oldAndNewSnapshots();
    const persistence = new MemoryPersistence();
    installPair(persistence, MANIFEST_BACKUP, BINARY_BACKUP, oldSnapshot);
    const store = createStore(persistence);
    await store.initialize();
    await expectLoadedSnapshot(store, 1, [oldRecoveryEntry()]);
    expect(await searchIds(store)).toEqual(["old"]);
    expectPair(persistence, MANIFEST, BINARY, oldSnapshot);
  });

  it("restores backup over a lone promoted new binary", async () => {
    const { oldSnapshot, newSnapshot } = await oldAndNewSnapshots();
    const persistence = new MemoryPersistence();
    persistence.setBinary(BINARY, newSnapshot.binary);
    installPair(persistence, MANIFEST_BACKUP, BINARY_BACKUP, oldSnapshot);
    const store = createStore(persistence);
    await store.initialize();
    await expectLoadedSnapshot(store, 1, [oldRecoveryEntry()]);
    expect(await searchIds(store)).toEqual(["old"]);
    expectPair(persistence, MANIFEST, BINARY, oldSnapshot);
  });

  it("restores backup instead of mixing a new binary with an old manifest", async () => {
    const { oldSnapshot, newSnapshot } = await oldAndNewSnapshots();
    const persistence = new MemoryPersistence();
    persistence.setText(MANIFEST, oldSnapshot.manifest);
    persistence.setBinary(BINARY, newSnapshot.binary);
    installPair(persistence, MANIFEST_BACKUP, BINARY_BACKUP, oldSnapshot);
    const store = createStore(persistence);
    await store.initialize();
    await expectLoadedSnapshot(store, 1, [oldRecoveryEntry()]);
    expect(await searchIds(store)).toEqual(["old"]);
    expectPair(persistence, MANIFEST, BINARY, oldSnapshot);
  });

  it("keeps valid new main authoritative over an older valid backup", async () => {
    const { oldSnapshot, newSnapshot } = await oldAndNewSnapshots();
    const persistence = new MemoryPersistence();
    installPair(persistence, MANIFEST, BINARY, newSnapshot);
    installPair(persistence, MANIFEST_BACKUP, BINARY_BACKUP, oldSnapshot);
    const store = createStore(persistence);
    await store.initialize();
    await expectLoadedSnapshot(store, 2, [
      oldRecoveryEntry(),
      newRecoveryEntry(),
    ]);
    expect(store.getStats()).toMatchObject({ count: 2, generation: 2 });
    expect(await searchIds(store)).toEqual(["old", "new"]);
    expectPair(persistence, MANIFEST, BINARY, newSnapshot);
    expect(persistence.files.has(MANIFEST_BACKUP)).toBe(false);
    expect(persistence.files.has(BINARY_BACKUP)).toBe(false);
  });

  it("keeps valid new main authoritative over stale temp files", async () => {
    const { oldSnapshot, newSnapshot } = await oldAndNewSnapshots();
    const persistence = new MemoryPersistence();
    installPair(persistence, MANIFEST, BINARY, newSnapshot);
    installPair(persistence, MANIFEST_TEMP, BINARY_TEMP, oldSnapshot);
    const store = createStore(persistence);
    await store.initialize();
    await expectLoadedSnapshot(store, 2, [
      oldRecoveryEntry(),
      newRecoveryEntry(),
    ]);
    expect(store.getStats()).toMatchObject({ count: 2, generation: 2 });
    expectPair(persistence, MANIFEST, BINARY, newSnapshot);
  });

  it("restores a valid backup over a corrupt complete main", async () => {
    const { oldSnapshot, newSnapshot } = await oldAndNewSnapshots();
    const persistence = new MemoryPersistence();
    persistence.setText(MANIFEST, "{corrupt");
    persistence.setBinary(BINARY, newSnapshot.binary);
    installPair(persistence, MANIFEST_BACKUP, BINARY_BACKUP, oldSnapshot);
    const store = createStore(persistence);
    await store.initialize();
    await expectLoadedSnapshot(store, 1, [oldRecoveryEntry()]);
    expect(await searchIds(store)).toEqual(["old"]);
    expectPair(persistence, MANIFEST, BINARY, oldSnapshot);
  });

  it("rejects when both complete main and backup are invalid", async () => {
    const { oldSnapshot } = await oldAndNewSnapshots();
    const persistence = new MemoryPersistence();
    persistence.setText(MANIFEST, "{bad-main");
    persistence.setBinary(BINARY, oldSnapshot.binary);
    persistence.setText(MANIFEST_BACKUP, "{bad-backup");
    persistence.setBinary(BINARY_BACKUP, oldSnapshot.binary);
    await expect(createStore(persistence).initialize()).rejects.toBeInstanceOf(
      VectorStoreCorruptionError,
    );
  });

  it.each([
    ["manifest", MANIFEST_BACKUP, "text"],
    ["binary", BINARY_BACKUP, "binary"],
  ])("rejects an absent main with only backup %s", async (_name, path, kind) => {
    const { oldSnapshot } = await oldAndNewSnapshots();
    const persistence = new MemoryPersistence();
    if (kind === "text") persistence.setText(path, oldSnapshot.manifest);
    else persistence.setBinary(path, oldSnapshot.binary);
    await expect(createStore(persistence).initialize()).rejects.toBeInstanceOf(
      VectorStoreCorruptionError,
    );
  });

  it.each([
    ["manifest", MANIFEST_BACKUP, "text"],
    ["binary", BINARY_BACKUP, "binary"],
  ])("loads valid main despite incomplete backup %s", async (_name, path, kind) => {
    const { oldSnapshot, newSnapshot } = await oldAndNewSnapshots();
    const persistence = new MemoryPersistence();
    installPair(persistence, MANIFEST, BINARY, newSnapshot);
    if (kind === "text") persistence.setText(path, oldSnapshot.manifest);
    else persistence.setBinary(path, oldSnapshot.binary);
    const store = createStore(persistence);
    await store.initialize();
    await expectLoadedSnapshot(store, 2, [
      oldRecoveryEntry(),
      newRecoveryEntry(),
    ]);
    expect(store.getStats()).toMatchObject({ count: 2, generation: 2 });
    expectPair(persistence, MANIFEST, BINARY, newSnapshot);
    expect(persistence.files.has(path)).toBe(false);
  });
});

describe("clear-specific crash-state regression", () => {
  async function initializeDirectClearState(
    configure: (
      persistence: MemoryPersistence,
      oldSnapshot: SnapshotFixture,
      emptySnapshot: SnapshotFixture,
    ) => void,
    expectedGeneration: 1 | 2,
  ): Promise<void> {
    const { oldSnapshot, emptySnapshot, oldEntries } =
      await oldAndClearedSnapshots();
    const persistence = new MemoryPersistence();
    configure(persistence, oldSnapshot, emptySnapshot);
    const restarted = createStore(persistence);
    await restarted.initialize();
    await expectLoadedSnapshot(
      restarted,
      expectedGeneration,
      expectedGeneration === 1 ? oldEntries : [],
    );
  }

  it("loads generation 1 after a crash with only the empty temp snapshot", async () => {
    await initializeDirectClearState(
      (persistence, oldSnapshot, emptySnapshot) => {
        installPair(persistence, MANIFEST, BINARY, oldSnapshot);
        installPair(
          persistence,
          MANIFEST_TEMP,
          BINARY_TEMP,
          emptySnapshot,
        );
      },
      1,
    );
  });

  it("loads generation 1 after a crash with temp and a full old backup", async () => {
    await initializeDirectClearState(
      (persistence, oldSnapshot, emptySnapshot) => {
        installPair(persistence, MANIFEST, BINARY, oldSnapshot);
        installPair(
          persistence,
          MANIFEST_TEMP,
          BINARY_TEMP,
          emptySnapshot,
        );
        installPair(
          persistence,
          MANIFEST_BACKUP,
          BINARY_BACKUP,
          oldSnapshot,
        );
      },
      1,
    );
  });

  it.each([
    ["binary backup write", { operation: "writeBinary", path: BINARY_BACKUP }],
    ["manifest backup write", { operation: "writeText", path: MANIFEST_BACKUP }],
    ["backup validation", { operation: "readBinary", path: BINARY_BACKUP }],
  ] satisfies Array<[string, FailureRule]>)(
    "keeps full generation 1 after clear %s failure",
    async (_name, failure) => {
      const { oldSnapshot, oldEntries } = await oldAndClearedSnapshots();
      const persistence = new MemoryPersistence();
      installPair(persistence, MANIFEST, BINARY, oldSnapshot);
      const store = createStore(persistence);
      await store.initialize();
      persistence.failOn(failure);

      await expect(store.clear()).rejects.toBeInstanceOf(
        VectorStorePersistenceError,
      );
      await expectLoadedSnapshot(store, 1, oldEntries);
      const restarted = createStore(persistence);
      await restarted.initialize();
      await expectLoadedSnapshot(restarted, 1, oldEntries);
    },
  );

  it.each([
    [
      "new empty binary with old manifest",
      (
        persistence: MemoryPersistence,
        oldSnapshot: SnapshotFixture,
        emptySnapshot: SnapshotFixture,
      ) => {
        persistence.setText(MANIFEST, oldSnapshot.manifest);
        persistence.setBinary(BINARY, emptySnapshot.binary);
        persistence.setText(MANIFEST_TEMP, emptySnapshot.manifest);
      },
    ],
    [
      "new empty binary without manifest",
      (
        persistence: MemoryPersistence,
        _oldSnapshot: SnapshotFixture,
        emptySnapshot: SnapshotFixture,
      ) => {
        persistence.setBinary(BINARY, emptySnapshot.binary);
        persistence.setText(MANIFEST_TEMP, emptySnapshot.manifest);
      },
    ],
    [
      "only new empty manifest",
      (
        persistence: MemoryPersistence,
        _oldSnapshot: SnapshotFixture,
        emptySnapshot: SnapshotFixture,
      ) => persistence.setText(MANIFEST, emptySnapshot.manifest),
    ],
  ] as const)(
    "restores generation 1 from full backup after clear crash with %s",
    async (_name, configureMain) => {
      await initializeDirectClearState(
        (persistence, oldSnapshot, emptySnapshot) => {
          configureMain(persistence, oldSnapshot, emptySnapshot);
          installPair(
            persistence,
            MANIFEST_BACKUP,
            BINARY_BACKUP,
            oldSnapshot,
          );
        },
        1,
      );
    },
  );

  it("reloads generation 1 after clear manifest promotion fails", async () => {
    const { oldSnapshot, oldEntries } = await oldAndClearedSnapshots();
    const persistence = new MemoryPersistence();
    installPair(persistence, MANIFEST, BINARY, oldSnapshot);
    const store = createStore(persistence);
    await store.initialize();
    persistence.failOn({
      operation: "rename",
      path: MANIFEST_TEMP,
      toPath: MANIFEST,
    });

    await expect(store.clear()).rejects.toBeInstanceOf(
      VectorStorePersistenceError,
    );
    await expectLoadedSnapshot(store, 1, oldEntries);
    const restarted = createStore(persistence);
    await restarted.initialize();
    await expectLoadedSnapshot(restarted, 1, oldEntries);
  });

  it.each([
    [
      "full old backup",
      (
        persistence: MemoryPersistence,
        oldSnapshot: SnapshotFixture,
      ) =>
        installPair(
          persistence,
          MANIFEST_BACKUP,
          BINARY_BACKUP,
          oldSnapshot,
        ),
    ],
    [
      "only old backup binary",
      (persistence: MemoryPersistence, oldSnapshot: SnapshotFixture) =>
        persistence.setBinary(BINARY_BACKUP, oldSnapshot.binary),
    ],
    [
      "only old backup manifest",
      (persistence: MemoryPersistence, oldSnapshot: SnapshotFixture) =>
        persistence.setText(MANIFEST_BACKUP, oldSnapshot.manifest),
    ],
    [
      "stale old temp",
      (persistence: MemoryPersistence, oldSnapshot: SnapshotFixture) =>
        installPair(
          persistence,
          MANIFEST_TEMP,
          BINARY_TEMP,
          oldSnapshot,
        ),
    ],
  ] as const)(
    "keeps valid empty generation 2 authoritative with %s",
    async (_name, configureNonAuthoritative) => {
      await initializeDirectClearState(
        (persistence, oldSnapshot, emptySnapshot) => {
          installPair(persistence, MANIFEST, BINARY, emptySnapshot);
          configureNonAuthoritative(persistence, oldSnapshot);
        },
        2,
      );
    },
  );

  it("does not reject clear when backup cleanup fails and reloads empty generation 2", async () => {
    const { oldSnapshot } = await oldAndClearedSnapshots();
    const persistence = new MemoryPersistence();
    installPair(persistence, MANIFEST, BINARY, oldSnapshot);
    const store = createStore(persistence);
    await store.initialize();
    persistence.failOn({ operation: "remove", path: BINARY_BACKUP });

    await store.clear();
    await expectLoadedSnapshot(store, 2, []);
    expect(persistence.files.has(BINARY_BACKUP)).toBe(true);
    const restarted = createStore(persistence);
    await restarted.initialize();
    await expectLoadedSnapshot(restarted, 2, []);
  });

  it("recovers the clear queue and reloads the last successful empty snapshot", async () => {
    const { oldSnapshot, oldEntries } = await oldAndClearedSnapshots();
    const persistence = new MemoryPersistence();
    installPair(persistence, MANIFEST, BINARY, oldSnapshot);
    const store = createStore(persistence);
    await store.initialize();
    persistence.failOn({ operation: "writeBinary", path: BINARY_TEMP });

    await expect(store.clear()).rejects.toBeInstanceOf(
      VectorStorePersistenceError,
    );
    await expectLoadedSnapshot(store, 1, oldEntries);
    await store.clear();
    await expectLoadedSnapshot(store, 2, []);
    const restarted = createStore(persistence);
    await restarted.initialize();
    await expectLoadedSnapshot(restarted, 2, []);
  });
});

describe("manifest, binary format, persistence and clear", () => {
  it("keeps vectors and unrelated secret fields out of the manifest", async () => {
    const persistence = new MemoryPersistence();
    const unsafe = { ...entry("a"), apiKey: "sk-secret", authorization: "Bearer secret" } as VectorEntry;
    await savedStore(persistence, [unsafe]);
    const text = persistence.text(MANIFEST);
    expect(manifest(persistence).records[0]).not.toHaveProperty("vector");
    expect(text).not.toContain("sk-secret");
    expect(text).not.toContain("Bearer secret");
  });

  it("writes records and binary rows in deterministic id order", async () => {
    const persistence = new MemoryPersistence();
    await savedStore(persistence, [
      entry("z", new Float32Array([0, 1, 0])),
      entry("a", new Float32Array([1, 0, 0])),
    ]);
    expect(manifest(persistence).records.map((record) => record.id)).toEqual(["a", "z"]);
    const view = new DataView(persistence.binary(BINARY));
    expect(view.getFloat32(24, true)).toBe(1);
    expect(view.getFloat32(24 + 3 * 4 + 4, true)).toBe(1);
  });

  it("uses the documented little-endian header and exact byte length", async () => {
    const { persistence } = await savedStore();
    const binary = persistence.binary(BINARY);
    const view = new DataView(binary);
    expect(Array.from(new Uint8Array(binary, 0, 8))).toEqual(VECTOR_BINARY_MAGIC);
    expect(view.getUint32(8, true)).toBe(VECTOR_BINARY_VERSION);
    expect(view.getUint32(12, true)).toBe(1);
    expect(view.getUint32(16, true)).toBe(3);
    expect(view.getUint32(20, true)).toBe(1);
    expect(binary.byteLength).toBe(VECTOR_BINARY_HEADER_BYTES + 3 * 4);
    expect(manifest(persistence)).toMatchObject({ generation: 1, dimensions: 3, count: 1, normalized: true, binaryFile: VECTOR_BINARY_FILE });
  });

  it("writes binary and manifest temp files before replacing main files", async () => {
    const persistence = new MemoryPersistence();
    await savedStore(persistence);
    const binaryWrite = persistence.calls.indexOf(`writeBinary:${BASE}/${VECTOR_BINARY_TEMP_FILE}`);
    const manifestWrite = persistence.calls.indexOf(`writeText:${BASE}/${VECTOR_MANIFEST_TEMP_FILE}`);
    const binaryRename = persistence.calls.indexOf(`rename:${BASE}/${VECTOR_BINARY_TEMP_FILE}->${BINARY}`);
    const manifestRename = persistence.calls.indexOf(`rename:${BASE}/${VECTOR_MANIFEST_TEMP_FILE}->${MANIFEST}`);
    expect(binaryWrite).toBeGreaterThan(-1);
    expect(binaryWrite).toBeLessThan(manifestWrite);
    expect(manifestWrite).toBeLessThan(binaryRename);
    expect(binaryRename).toBeLessThan(manifestRename);
    expect(persistence.files.has(`${BASE}/${VECTOR_BINARY_TEMP_FILE}`)).toBe(false);
    expect(persistence.files.has(`${BASE}/${VECTOR_MANIFEST_TEMP_FILE}`)).toBe(false);
  });

  it("validates temp, writes a full state copy as backup, then promotes binary and manifest", async () => {
    const { persistence, store } = await savedStore();
    persistence.calls.length = 0;
    await store.applyChanges({ upserts: [entry("new")] });
    const binaryWrite = persistence.calls.indexOf(`writeBinary:${BINARY_TEMP}`);
    const manifestWrite = persistence.calls.indexOf(`writeText:${MANIFEST_TEMP}`);
    const tempBinaryRead = persistence.calls.indexOf(`readBinary:${BINARY_TEMP}`);
    const binaryBackupWrite = persistence.calls.indexOf(
      `writeBinary:${BINARY_BACKUP}`,
    );
    const manifestBackupWrite = persistence.calls.indexOf(
      `writeText:${MANIFEST_BACKUP}`,
    );
    const backupBinaryRead = persistence.calls.indexOf(
      `readBinary:${BINARY_BACKUP}`,
    );
    const binaryPromotion = persistence.calls.indexOf(
      `rename:${BINARY_TEMP}->${BINARY}`,
    );
    const manifestPromotion = persistence.calls.indexOf(
      `rename:${MANIFEST_TEMP}->${MANIFEST}`,
    );
    const installedBinaryRead = persistence.calls.lastIndexOf(
      `readBinary:${BINARY}`,
    );
    const installedManifestRead = persistence.calls.lastIndexOf(
      `readText:${MANIFEST}`,
    );
    const firstBackupCleanup = persistence.calls.findIndex(
      (call) =>
        call === `remove:${BINARY_BACKUP}` ||
        call === `remove:${MANIFEST_BACKUP}`,
    );
    expect(binaryWrite).toBeLessThan(manifestWrite);
    expect(manifestWrite).toBeLessThan(tempBinaryRead);
    expect(tempBinaryRead).toBeLessThan(binaryBackupWrite);
    expect(binaryBackupWrite).toBeLessThan(manifestBackupWrite);
    expect(manifestBackupWrite).toBeLessThan(backupBinaryRead);
    expect(backupBinaryRead).toBeLessThan(binaryPromotion);
    expect(binaryPromotion).toBeLessThan(manifestPromotion);
    expect(manifestPromotion).toBeLessThan(installedBinaryRead);
    expect(manifestPromotion).toBeLessThan(installedManifestRead);
    expect(firstBackupCleanup).toBeGreaterThan(installedBinaryRead);
    expect(firstBackupCleanup).toBeGreaterThan(installedManifestRead);
    expect(
      persistence.calls.some(
        (call) =>
          call === `rename:${BINARY}->${BINARY_BACKUP}` ||
          call === `rename:${MANIFEST}->${MANIFEST_BACKUP}`,
      ),
    ).toBe(false);
    expect(persistence.files.has(MANIFEST_BACKUP)).toBe(false);
    expect(persistence.files.has(BINARY_BACKUP)).toBe(false);
  });

  it("keeps backup present when new-main validation fails until rollback succeeds", async () => {
    const oldEntry = oldRecoveryEntry();
    const newEntry = newRecoveryEntry();
    const { persistence, store } = await savedStore(
      new MemoryPersistence(),
      [oldEntry],
    );
    let mainBinaryReads = 0;
    let observedBackupAtValidation = false;
    persistence.beforeReadBinary = (path) => {
      if (path !== BINARY) return;
      mainBinaryReads++;
      if (mainBinaryReads === 2) {
        observedBackupAtValidation = true;
        expect(persistence.files.has(MANIFEST_BACKUP)).toBe(true);
        expect(persistence.files.has(BINARY_BACKUP)).toBe(true);
        expectSerializedSnapshot(
          persistence,
          MANIFEST_BACKUP,
          BINARY_BACKUP,
          1,
          [oldEntry],
        );
      }
    };
    persistence.failOn({
      operation: "readBinary",
      path: BINARY,
      skip: 1,
    });

    await expect(
      store.applyChanges({ upserts: [newEntry] }),
    ).rejects.toBeInstanceOf(VectorStorePersistenceError);
    expect(observedBackupAtValidation).toBe(true);
    await expectLoadedSnapshot(store, 1, [oldEntry]);
    const reloaded = createStore(persistence);
    await reloaded.initialize();
    await expectLoadedSnapshot(reloaded, 1, [oldEntry]);
  });

  it("produces identical manifest and binary for identical mutation sequences", async () => {
    const first = new MemoryPersistence();
    const second = new MemoryPersistence();
    for (const persistence of [first, second]) {
      const store = createStore(persistence);
      await store.initialize();
      await store.applyChanges({ upserts: [entry("z"), entry("a", new Float32Array([0, 1, 0]))] });
      await store.applyChanges({ deleteIds: ["z"], upserts: [entry("b", new Float32Array([0, 0, 1]))] });
    }
    expect(second.text(MANIFEST)).toBe(first.text(MANIFEST));
    expect(Array.from(new Uint8Array(second.binary(BINARY)))).toEqual(
      Array.from(new Uint8Array(first.binary(BINARY))),
    );
  });

  it("clear persists a reloadable empty snapshot and increments generation", async () => {
    const { persistence, store } = await savedStore();
    await store.clear();
    expect(store.getStats()).toMatchObject({ count: 0, generation: 2, binaryBytes: VECTOR_BINARY_HEADER_BYTES });
    expect(await store.search(new Float32Array([1, 0, 0]), { limit: 1 })).toEqual([]);
    const reloaded = createStore(persistence);
    await reloaded.initialize();
    expect(reloaded.getStats()).toMatchObject({ count: 0, generation: 2 });
  });

  it("keeps the old state when clear persistence fails", async () => {
    const { persistence, store } = await savedStore();
    const before = store.getStats();
    persistence.failNext = { operation: "writeText" };
    await expect(store.clear()).rejects.toBeInstanceOf(VectorStorePersistenceError);
    expect(store.getStats()).toEqual(before);
    expect(await store.search(new Float32Array([1, 0, 0]), { limit: 1 })).toHaveLength(1);
  });

  it("rolls back a late clear failure and then accepts a successful clear", async () => {
    const { persistence, store } = await savedStore();
    const previous = captureMain(persistence);
    persistence.failOn({
      operation: "rename",
      path: MANIFEST_TEMP,
      toPath: MANIFEST,
    });
    await expect(store.clear()).rejects.toBeInstanceOf(
      VectorStorePersistenceError,
    );
    expect(store.getStats()).toMatchObject({ count: 1, generation: 1 });
    expectPair(persistence, MANIFEST, BINARY, previous);
    const afterFailure = createStore(persistence);
    await afterFailure.initialize();
    expect(await searchIds(afterFailure)).toEqual(["a"]);

    await store.clear();
    expect(store.getStats()).toMatchObject({ count: 0, generation: 2 });
    const reloaded = createStore(persistence);
    await reloaded.initialize();
    expect(reloaded.getStats()).toMatchObject({ count: 0, generation: 2 });
  });

  it("accepts a successful mutation after a failed clear", async () => {
    const { persistence, store } = await savedStore();
    persistence.failOn({ operation: "writeBinary", path: BINARY_TEMP });
    await expect(store.clear()).rejects.toBeInstanceOf(
      VectorStorePersistenceError,
    );
    await store.applyChanges({
      upserts: [entry("after", new Float32Array([0, 1, 0]))],
    });
    expect(store.getStats()).toMatchObject({ count: 2, generation: 2 });
    const reloaded = createStore(persistence);
    await reloaded.initialize();
    expect(await searchIds(reloaded)).toEqual(["a", "after"]);
  });
});

describe("NullVectorStore", () => {
  it("initializes and reports stable empty stats", async () => {
    const store = new NullVectorStore();
    await store.initialize();
    expect(store.getStats()).toEqual({ initialized: true, count: 0, dimensions: 0, embeddingSpaceId: "disabled", generation: 0, binaryBytes: 0 });
  });

  it("implements no-op mutation, empty search and no-op clear", async () => {
    const store = new NullVectorStore();
    await store.applyChanges({ upserts: [entry("ignored")] });
    expect(await store.search(new Float32Array(), { limit: 1 })).toEqual([]);
    await store.clear();
    expect(store.getStats().count).toBe(0);
  });
});

describe("production compatibility boundaries", () => {
  it("keeps LocalVectorStore free of Node, Obsidian, provider and chunker runtime dependencies", () => {
    const source = readFileSync(new URL("./localVectorStore.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:|from ["'](?:fs|path|crypto)["']|\bBuffer\b/);
    expect(source).not.toMatch(/from ["']obsidian["']/);
    expect(source).not.toContain("EmbeddingProvider");
    expect(source).not.toContain("MarkdownChunker");
  });

  it("isolates the Obsidian runtime import to the persistence adapter", () => {
    const source = readFileSync(new URL("./obsidianPersistence.ts", import.meta.url), "utf8");
    expect(source).toContain('from "obsidian"');
    expect(source).toContain("DataAdapter");
    expect(source).toContain("readBinary");
    expect(source).toContain("writeBinary");
  });
});
