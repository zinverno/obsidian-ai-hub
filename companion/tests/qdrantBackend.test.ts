import { DatabaseSync } from "node:sqlite";
import type { MirroredNote, SemanticDescriptor } from "../src/protocol/types.js";
import type { McpSearchResult } from "../src/mcp/semanticSearch.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadQdrantConfig } from "../src/config.js";
import { buildDescriptorEmbeddingSpaceId } from "../src/mcp/descriptor.js";
import { SemanticSearchService, SqliteSemanticSearch } from "../src/mcp/semanticSearch.js";
import { QdrantVectorBackend } from "../src/search/qdrantBackend.js";
import { collectionName, pointId } from "../src/search/qdrantIndex.js";
import { SqliteCompanionStorage } from "../src/storage/sqliteCompanionStorage.js";
import { descriptor, note, upsertBatch, VAULT_A, VAULT_B } from "./fixtures.js";
import { FakeQdrantIndex } from "./qdrantFixture.js";

const config = loadQdrantConfig({ QDRANT_ENABLED: "true", QDRANT_API_KEY: "super-secret-qdrant" });
function canonical(model: string, dimensions = 3): SemanticDescriptor {
  const value = descriptor({ model, dimensions });
  value.embeddingSpaceId = buildDescriptorEmbeddingSpaceId(value);
  return value;
}
function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("Qdrant derived search lifecycle", () => {
  let directory: string;
  let storage: SqliteCompanionStorage;
  let index: FakeQdrantIndex;
  let backend: QdrantVectorBackend;
  const provider = { embedQuery: vi.fn(async () => new Float32Array([1, 0, 0])) };
  let service: SemanticSearchService;
  let unsubscribe: () => void;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "qdrant-lifecycle-"));
    storage = new SqliteCompanionStorage(directory);
    await storage.initialize();
    index = new FakeQdrantIndex();
    backend = new QdrantVectorBackend(storage, VAULT_A, config, index);
    unsubscribe = storage.subscribeCommits((notice) => backend.onCommit(notice));
    provider.embedQuery.mockClear();
    service = new SemanticSearchService(storage, provider, backend);
  });
  afterEach(async () => { unsubscribe(); backend.close(); await storage.close(); await rm(directory, { recursive: true, force: true }); });
  async function seed(count = 3): Promise<MirroredNote[]> {
    const notes = Array.from({ length: count }, (_, i) => {
      const value = note(`${i}.md`, `stored content ${i}`, i === 2 ? [0, 1, 0] : [1, 0, 0]);
      value.chunks[0]!.chunkId = `id-${String(i).padStart(4, "0")}`;
      return value;
    });
    await storage.applyBatch(VAULT_A, upsertBatch(1, notes));
    return notes;
  }
  async function search(): Promise<McpSearchResult[]> { return service.search(VAULT_A, "query only", 2); }
  async function expectSqlite(): Promise<void> {
    const calls = index.calls.filter((call) => call.method === "search").length;
    expect(await search()).toHaveLength(2);
    expect(index.calls.filter((call) => call.method === "search")).toHaveLength(calls);
    expect((await backend.status()).lastSearchBackend).toBe("sqlite");
  }
  it("disabled uses SQLite and never contacts Qdrant", async () => {
    backend.close(); unsubscribe();
    backend = new QdrantVectorBackend(storage, VAULT_A, { ...config, enabled: false }, index);
    service = new SemanticSearchService(storage, provider, backend);
    await seed(); await backend.reconcile(); await expectSqlite();
    expect((await backend.status()).state).toBe("DISABLED"); expect(index.calls).toEqual([]);
  });
  it("unavailable and ERROR fall back with one embedding, later recovery needs no resync", async () => {
    await seed(); index.fail = "all";
    await backend.reconcile(); expect((await backend.status()).state).toBe("ERROR");
    await expectSqlite(); expect(provider.embedQuery).toHaveBeenCalledExactlyOnceWith(descriptor(), "query only");
    index.fail = null; await backend.reconcile(); expect((await backend.status()).state).toBe("READY");
  });
  it("BUILDING never publishes a partial index and falls back", async () => {
    await seed(); const blocked = gate(); const entered = gate();
    index.before = async (method): Promise<void> => { if (method === "upsert") { entered.release(); await blocked.promise; } };
    const build = backend.reconcile(); await entered.promise;
    expect((await backend.status()).state).toBe("BUILDING"); await expectSqlite();
    blocked.release(); await build; expect((await backend.status()).state).toBe("READY");
  });
  it("STALE falls back before initial reconciliation", async () => { await seed(); await expectSqlite(); });
  it("READY exact state uses Qdrant with one query embedding and authoritative parity", async () => {
    await seed(); const before = await storage.readVault(VAULT_A);
    await backend.reconcile(); expect(provider.embedQuery).not.toHaveBeenCalled();
    const actual = await search();
    expect(index.calls.some((call) => call.method === "search")).toBe(true);
    expect((await backend.status()).lastSearchBackend).toBe("qdrant");
    expect(provider.embedQuery).toHaveBeenCalledExactlyOnceWith(descriptor(), "query only");
    const expected = await new SqliteSemanticSearch(storage, provider).search(VAULT_A, "query only", 2);
    expect(actual).toEqual(expected); expect(await storage.readVault(VAULT_A)).toEqual(before);
    expect(actual[0]?.text).toBe("0\n\nstored content 0");
  });
  it("Qdrant search failure falls back using exactly one query embedding", async () => {
    await seed(); await backend.reconcile(); index.fail = "search";
    await expect(search()).resolves.toHaveLength(2);
    expect(provider.embedQuery).toHaveBeenCalledExactlyOnceWith(descriptor(), "query only");
    expect((await backend.status()).lastSearchBackend).toBe("sqlite");
  });
  it("requires exact generation, revision, vault and semantic space for readiness", async () => {
    await seed(); await backend.reconcile(); const snapshot = await storage.getSearchSnapshot(VAULT_A);
    expect(backend.available(snapshot)).toBe(true);
    expect(backend.available({ ...snapshot, generation: 2 })).toBe(false);
    expect(backend.available({ ...snapshot, revision: 2 })).toBe(false);
    expect(backend.available({ ...snapshot, vaultId: VAULT_B })).toBe(false);
    expect(backend.available({ ...snapshot, descriptor: canonical("other") })).toBe(false);
    expect(backend.available({ ...snapshot, descriptor: { ...descriptor(), model: "tampered" } })).toBe(false);
  });
  it("same-generation same-count edits invalidate readiness and increment persisted revision", async () => {
    const notes = await seed(); await backend.reconcile(); const before = await storage.getSearchSnapshot(VAULT_A);
    notes[0]!.content = "changed"; notes[0]!.chunks[0]!.text = "changed";
    await storage.applyBatch(VAULT_A, upsertBatch(1, notes));
    expect((await backend.status()).state).toBe("STALE");
    expect((await storage.getSearchSnapshot(VAULT_A)).revision).toBe(before.revision + 1);
    await expectSqlite(); await backend.reconcile();
    expect((await search())[0]?.text).toBe("changed");
  });
  it("initial rebuild is bounded, deterministic, from stored SQLite vectors with zero embeddings", async () => {
    await seed(260); await backend.reconcile();
    const name = collectionName(config.collectionPrefix, VAULT_A, descriptor().embeddingSpaceId);
    const points = structuredClone(index.collections.get(name)!.points);
    expect(index.calls.filter((call) => call.method === "upsert").map((call) => call.size)).toEqual([128, 128, 4]);
    backend.invalidate(); await backend.reconcile();
    expect([...index.collections.get(name)!.points.keys()]).toEqual([...points.keys()]);
    expect(index.collections.get(name)!.points.get(pointId(VAULT_A, "id-0000"))?.vector).toEqual([1, 0, 0]);
    expect(provider.embedQuery).not.toHaveBeenCalled();
  });
  it("empty existing vault builds READY and absent vault stays SQLite", async () => {
    await backend.reconcile(); expect((await backend.status()).state).toBe("STALE");
    await storage.applyBatch(VAULT_A, upsertBatch(1, [])); await backend.reconcile();
    expect((await backend.status()).state).toBe("READY"); expect(await search()).toEqual([]);
    expect(provider.embedQuery).not.toHaveBeenCalled();
  });
  it("partial build failure never READY and later rebuild recovers", async () => {
    await seed(130); let uploads = 0;
    index.before = async (method): Promise<void> => { if (method === "upsert" && ++uploads === 2) throw new Error("failure"); };
    await backend.reconcile(); expect((await backend.status()).state).toBe("ERROR");
    await expectSqlite(); index.before = async (): Promise<void> => {}; await backend.reconcile();
    expect((await backend.status()).state).toBe("READY");
  });
  it("generation changes during a build prevent READY publication", async () => {
    await seed(); let changed = false;
    index.before = async (method): Promise<void> => {
      if (method === "upsert" && !changed) { changed = true; await storage.applyBatch(VAULT_A, upsertBatch(2, [note("new.md", "new", [1, 0, 0])])); }
    };
    await backend.reconcile(); expect((await backend.status()).state).toBe("STALE");
    expect(backend.available(await storage.getSearchSnapshot(VAULT_A))).toBe(false);
    await backend.reconcile(); expect((await backend.status()).indexedGeneration).toBe(2);
  });
  it("descriptor replacement never queries old space, builds new vectors and leaves old collection alone", async () => {
    await seed(); await backend.reconcile(); const old = (await backend.status()).collection;
    const next = canonical("replacement");
    await storage.applyBatch(VAULT_A, upsertBatch(2, [note("new.md", "new", [0, 0, 1])], { replaceVault: true, descriptor: next }));
    expect(await search()).toHaveLength(1);
    expect(index.calls.filter((call) => call.method === "search")).toEqual([]);
    await backend.reconcile(); await search();
    const current = (await backend.status()).collection;
    expect(current).not.toBe(old); expect(index.collections.has(old!)).toBe(true);
    expect(index.calls.filter((call) => call.method === "search").map((call) => call.collection)).toEqual([current]);
    expect([...index.collections.get(current!)!.points.values()][0]?.vector).toEqual([0, 0, 1]);
    expect([...index.collections.get(current!)!.points.values()][0]?.payload.embeddingSpaceId).toBe(next.embeddingSpaceId);
  });
  it("dimension replacement builds a different collection without converting SQLite vectors", async () => {
    await seed(); await backend.reconcile();
    await storage.applyBatch(VAULT_A, upsertBatch(2, [note("new.md", "new", [1, 0])], { replaceVault: true, descriptor: canonical("two", 2) }));
    await backend.reconcile(); const status = await backend.status();
    expect(status.state).toBe("READY"); expect(index.collections.get(status.collection!)?.dimensions).toBe(2);
    expect(provider.embedQuery).not.toHaveBeenCalled();
  });
  it("incremental UPSERT replaces vectors and adds chunks without a full rebuild", async () => {
    const notes = await seed(); await backend.reconcile(); const clears = index.calls.filter((call) => call.method === "clear").length;
    notes[0]!.chunks[0]!.embedding = [0, 0, 1];
    await storage.applyBatch(VAULT_A, upsertBatch(2, [notes[0]!, note("new.md", "new", [1, 0, 0])]));
    await backend.reconcile(); expect((await backend.status()).state).toBe("READY");
    expect(index.calls.filter((call) => call.method === "clear")).toHaveLength(clears);
    const points = index.collections.get((await backend.status()).collection!)!.points;
    expect(points.get(pointId(VAULT_A, "id-0000"))?.vector).toEqual([0, 0, 1]); expect(points.size).toBe(4);
  });
  it("DELETE and RENAME remove old points before publishing current generation", async () => {
    await seed(); await backend.reconcile();
    await storage.applyBatch(VAULT_A, upsertBatch(2, [], { operations: [
      { type: "DELETE", path: "0.md" }, { type: "RENAME", oldPath: "1.md", note: note("renamed.md", "renamed", [1, 0, 0]) },
    ] }));
    expect((await search()).map((r) => r.path)).toEqual(["renamed.md", "2.md"]);
    expect((await backend.status()).state).toBe("STALE"); await backend.reconcile();
    const points = index.collections.get((await backend.status()).collection!)!.points;
    expect(points.has(pointId(VAULT_A, "id-0000"))).toBe(false); expect(points.has(pointId(VAULT_A, "id-0001"))).toBe(false);
    expect((await search()).map((r) => r.path)).toEqual(["renamed.md", "2.md"]);
  });
  it.each(["delete", "upsert", "stamp"])("incremental %s failure preserves committed SQLite sync and recovers", async (failure) => {
    await seed(); await backend.reconcile(); index.fail = failure;
    const result = await storage.applyBatch(VAULT_A, upsertBatch(2, [note("new.md", "new", [1, 0, 0])]));
    expect(result.applied).toBe(true); await backend.reconcile(); expect((await backend.status()).state).toBe("ERROR");
    expect((await storage.getVaultStatus(VAULT_A)).generation).toBe(2); await expectSqlite();
    index.fail = null; await backend.reconcile(); expect((await backend.status()).state).toBe("READY");
  });
  it("SQLite COMMIT precedes every Qdrant mutation and failed transaction never advances Qdrant", async () => {
    const events: number[] = [];
    storage.subscribeCommits(() => { events.push(storage.listVectorPage(VAULT_A, 3, "", 10).length); });
    await seed(); await backend.reconcile(); expect(events).toEqual([3]);
    index.before = async (): Promise<void> => { expect((await storage.getVaultStatus(VAULT_A)).generation).toBe(2); };
    await storage.applyBatch(VAULT_A, upsertBatch(2, [note("new.md", "new", [1, 0, 0])])); await backend.reconcile();
    const snapshot = await storage.readVault(VAULT_A); const calls = index.calls.length; const notifications = events.length;
    const invalid = note("bad.md", "bad", [1, 0, 0]); invalid.chunks[0]!.chunkId = "id-0000";
    await expect(storage.applyBatch(VAULT_A, upsertBatch(3, [invalid]))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect(index.calls).toHaveLength(calls); expect(events).toHaveLength(notifications); expect(await storage.readVault(VAULT_A)).toEqual(snapshot);
  });
  it("independent SQLite reader sees COMMIT before observers are notified", async () => {
    const reader = new DatabaseSync(join(directory, "companion.sqlite"), { readOnly: true });
    const observed: unknown[] = [];
    const stop = storage.subscribeCommits(() => {
      observed.push(reader.prepare("SELECT generation, revision FROM vaults WHERE vault_id = ?").get(VAULT_A));
    });
    try {
      await seed();
      expect(observed).toEqual([{ generation: 1, revision: 1 }]);
    } finally { stop(); reader.close(); }
  });
  it("a SQLite COMMIT failure rolls back and never notifies the derived index", async () => {
    await seed(); await backend.reconcile();
    const before = await storage.getSearchSnapshot(VAULT_A);
    const snapshot = await storage.readVault(VAULT_A);
    const notices = vi.fn(); storage.subscribeCommits(notices);
    const execute = DatabaseSync.prototype.exec;
    const commit = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string): void {
      if (sql === "COMMIT") throw new Error("simulated commit failure");
      execute.call(this, sql);
    });
    try {
      await expect(storage.applyBatch(VAULT_A, upsertBatch(2, [note("new.md", "new", [1, 0, 0])])))
        .rejects.toMatchObject({ code: "STORAGE_ERROR" });
    } finally { commit.mockRestore(); }
    expect(notices).not.toHaveBeenCalled(); expect(await storage.readVault(VAULT_A)).toEqual(snapshot);
    expect(await storage.getSearchSnapshot(VAULT_A)).toEqual(before); expect(backend.available(before)).toBe(true);
  });
  it("upgrades an existing Stage 9 mirror without changing notes or vectors", async () => {
    await seed(); const before = await storage.readVault(VAULT_A);
    backend.close(); unsubscribe(); await storage.close();
    const old = new DatabaseSync(join(directory, "companion.sqlite"));
    old.exec("ALTER TABLE vaults DROP COLUMN revision; PRAGMA user_version = 1"); old.close();
    storage = new SqliteCompanionStorage(directory); await storage.initialize();
    expect(await storage.readVault(VAULT_A)).toEqual(before);
    expect((await storage.getSearchSnapshot(VAULT_A)).revision).toBe(0);
    backend = new QdrantVectorBackend(storage, VAULT_A, config, index); await backend.reconcile();
    expect((await backend.status()).state).toBe("READY"); expect(provider.embedQuery).not.toHaveBeenCalled();
  });
  it("non-axis vectors preserve SQLite ranking and cosine scores within Float32 tolerance", async () => {
    await storage.applyBatch(VAULT_A, upsertBatch(1, [note("A.md", "a", [0.6, 0.8, 0]),
      note("B.md", "b", [Math.SQRT1_2, Math.SQRT1_2, 0]), note("C.md", "c", [-1, 0, 0])]));
    await backend.reconcile(); const actual = await search();
    const expected = await new SqliteSemanticSearch(storage, provider).search(VAULT_A, "query only", 2);
    expect(actual.map((row) => row.chunkId)).toEqual(expected.map((row) => row.chunkId));
    actual.forEach((row, i) => expect(Math.abs(row.score - expected[i]!.score)).toBeLessThanOrEqual(1e-6));
    expect((await backend.status()).lastSearchBackend).toBe("qdrant");
  });
  it("observer failure cannot make a successful SQLite sync fail", async () => {
    storage.subscribeCommits(() => { throw new Error("derived failure"); });
    await expect(storage.applyBatch(VAULT_A, upsertBatch(1, [note("A.md", "a", [1, 0, 0])]))).resolves.toMatchObject({ applied: true });
    expect((await storage.getVaultStatus(VAULT_A)).chunkCount).toBe(1);
  });
  it("missing SQLite hydration discards all Qdrant candidates and falls back with one embedding", async () => {
    await seed(); await backend.reconcile(); index.searchResult = [{ chunkId: "id-0000", score: 1 }, { chunkId: "missing", score: 1 }];
    const result = await search(); expect(result.map((r) => r.chunkId)).toEqual(["id-0000", "id-0001"]);
    expect(provider.embedQuery).toHaveBeenCalledTimes(1); expect((await backend.status()).lastSearchBackend).toBe("sqlite");
  });
  it.each([Number.NaN, 2, -2])("malformed derived score %s falls back", async (score) => {
    await seed(); await backend.reconcile(); index.searchResult = [{ chunkId: "id-0000", score }];
    expect(await search()).toHaveLength(2); expect((await backend.status()).lastSearchBackend).toBe("sqlite");
  });
  it("same-space commit during Qdrant search falls back to current SQLite with the same vector", async () => {
    await seed(); await backend.reconcile(); index.before = async (method): Promise<void> => {
      if (method === "search") await storage.applyBatch(VAULT_A, upsertBatch(2, [], { operations: [{ type: "DELETE", path: "0.md" }] }));
    };
    expect((await search()).map((r) => r.path)).toEqual(["1.md", "2.md"]); expect(provider.embedQuery).toHaveBeenCalledTimes(1);
  });
  it("different-space commit during Qdrant search rejects the old query vector", async () => {
    await seed(); await backend.reconcile(); index.before = async (method): Promise<void> => {
      if (method === "search") await storage.applyBatch(VAULT_A, upsertBatch(2, [], { replaceVault: true, descriptor: canonical("new") }));
    };
    await expect(search()).rejects.toMatchObject({ code: "SEMANTIC_SEARCH_UNAVAILABLE" }); expect(provider.embedQuery).toHaveBeenCalledTimes(1);
  });
  it("restart distrusts existing Qdrant state and rebuilds using persistent SQLite revision", async () => {
    await seed(); await backend.reconcile(); const before = await storage.getSearchSnapshot(VAULT_A);
    unsubscribe(); backend.close(); await storage.close(); storage = new SqliteCompanionStorage(directory); await storage.initialize();
    backend = new QdrantVectorBackend(storage, VAULT_A, config, index); service = new SemanticSearchService(storage, provider, backend);
    expect(await storage.getSearchSnapshot(VAULT_A)).toEqual(before); await expectSqlite(); await backend.reconcile();
    expect((await backend.status()).state).toBe("READY");
  });
  it("safe diagnostic status never includes Qdrant key or upstream error text", async () => {
    await seed(); index.fail = "all"; await backend.reconcile();
    const output = JSON.stringify(await backend.status());
    expect(output).not.toContain(config.apiKey); expect(output).not.toContain("upstream"); expect(output).not.toContain("stored content");
    expect((await backend.status()).lastErrorCode).toBe("QDRANT_INVALID_INDEX");
  });
  it("coalesces pending commits into one full rebuild", async () => {
    await seed(); await backend.reconcile(); const clears = index.calls.filter((call) => call.method === "clear").length;
    for (let i = 2; i < 10; i++) await storage.applyBatch(VAULT_A, upsertBatch(i, [note("x.md", String(i), [1, 0, 0])]));
    await backend.reconcile(); expect(index.calls.filter((call) => call.method === "clear")).toHaveLength(clears + 1);
    expect((await backend.status()).indexedGeneration).toBe(9);
  });
});
