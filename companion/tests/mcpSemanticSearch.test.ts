import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteSemanticSearch } from "../src/mcp/semanticSearch.js";
import type { QueryEmbeddingProvider } from "../src/mcp/queryEmbedding.js";
import { SqliteCompanionStorage } from "../src/storage/sqliteCompanionStorage.js";
import { descriptor, note, upsertBatch, VAULT_A } from "./fixtures.js";

describe("SQLite MCP semantic retrieval", () => {
  let directory: string;
  let storage: SqliteCompanionStorage;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "vault-companion-mcp-search-"));
    storage = new SqliteCompanionStorage(directory);
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  });

  function provider(vector: Float32Array): QueryEmbeddingProvider & { calls: number } {
    return {
      calls: 0,
      async embedQuery(): Promise<Float32Array> {
        this.calls++;
        return new Float32Array(vector);
      },
    };
  }

  it("normalizes one query embedding, ranks by cosine score, and uses chunkId as the stable tie-break", async () => {
    const first = note("First.md", "first", [1, 0, 0]);
    first.chunks[0]!.chunkId = "z-tie";
    const second = note("Second.md", "second", [1, 0, 0]);
    second.chunks[0]!.chunkId = "a-tie";
    const third = note("Third.md", "third", [0, 1, 0]);
    third.chunks[0]!.chunkId = "middle";
    await storage.applyBatch(VAULT_A, upsertBatch(1, [first, second, third]));
    const queryProvider = provider(new Float32Array([2, 0, 0]));
    const results = await new SqliteSemanticSearch(storage, queryProvider).search(VAULT_A, "meaning", 3);
    expect(results.map((item) => [item.chunkId, item.score])).toEqual([
      ["a-tie", 1],
      ["z-tie", 1],
      ["middle", 0],
    ]);
    expect(results[0]).toMatchObject({
      path: "Second.md",
      headingPath: ["Second"],
      source: { startOffset: 0, endOffset: 6, startLine: 0, endLine: 2 },
      text: "Second\n\nsecond",
    });
    expect(queryProvider.calls).toBe(1);
  });

  it("keeps only top K and returns no raw vectors", async () => {
    const notes = Array.from({ length: 25 }, (_value, index) => {
      const value = note(`N${String(index).padStart(2, "0")}.md`, `n${index}`, [1, 0, 0]);
      value.chunks[0]!.chunkId = `chunk-${String(index).padStart(2, "0")}`;
      return value;
    });
    await storage.applyBatch(VAULT_A, upsertBatch(1, notes));
    const results = await new SqliteSemanticSearch(storage, provider(new Float32Array([1, 0, 0])))
      .search(VAULT_A, "bounded", 5);
    expect(results).toHaveLength(5);
    expect(results.map((item) => item.chunkId)).toEqual(["chunk-00", "chunk-01", "chunk-02", "chunk-03", "chunk-04"]);
    expect(JSON.stringify(results)).not.toMatch(/embedding|vector/iu);
  });

  it("does zero embedding work for an empty vault", async () => {
    const queryProvider = provider(new Float32Array([1, 0, 0]));
    expect(await new SqliteSemanticSearch(storage, queryProvider).search(VAULT_A, "empty", 5)).toEqual([]);
    expect(queryProvider.calls).toBe(0);
  });

  it("rejects query dimension, non-finite, and stored normalization mismatches", async () => {
    await storage.applyBatch(VAULT_A, upsertBatch(1, [note("A.md", "a", [1, 0, 0])]));
    await expect(new SqliteSemanticSearch(storage, provider(new Float32Array([1, 0])))
      .search(VAULT_A, "dimension", 5)).rejects.toMatchObject({ code: "SEMANTIC_SEARCH_UNAVAILABLE" });
    await expect(new SqliteSemanticSearch(storage, provider(new Float32Array([Number.NaN, 0, 0])))
      .search(VAULT_A, "finite", 5)).rejects.toMatchObject({ code: "SEMANTIC_SEARCH_UNAVAILABLE" });

    await storage.applyBatch(VAULT_A, upsertBatch(2, [note("A.md", "a", [2, 0, 0])]));
    await expect(new SqliteSemanticSearch(storage, provider(new Float32Array([1, 0, 0])))
      .search(VAULT_A, "stored", 5)).rejects.toMatchObject({ code: "SEMANTIC_SEARCH_UNAVAILABLE" });
  });

  it("rejects a descriptor whose canonical embedding-space identity does not match", async () => {
    await storage.applyBatch(VAULT_A, upsertBatch(1, [note("A.md", "a", [1, 0, 0])], {
      descriptor: descriptor({ embeddingSpaceId: "tampered-space" }),
    }));
    const queryProvider = provider(new Float32Array([1, 0, 0]));
    await expect(new SqliteSemanticSearch(storage, queryProvider).search(VAULT_A, "descriptor", 5))
      .rejects.toMatchObject({ code: "SEMANTIC_SEARCH_UNAVAILABLE" });
    expect(queryProvider.calls).toBe(0);
  });

  it("calls only the query provider once even while scanning multiple stored notes", async () => {
    await storage.applyBatch(VAULT_A, upsertBatch(1, [
      note("A.md", "a", [1, 0, 0]),
      note("B.md", "b", [0, 1, 0]),
      note("C.md", "c", [0, 0, 1]),
    ]));
    const queryProvider = provider(new Float32Array([1, 0, 0]));
    const embed = vi.spyOn(queryProvider, "embedQuery");
    await new SqliteSemanticSearch(storage, queryProvider).search(VAULT_A, "one call", 2);
    expect(queryProvider.calls).toBe(1);
    expect(embed).toHaveBeenCalledExactlyOnceWith(descriptor(), "one call");
  });

  it("rejects a replacement descriptor committed while the query embedding is in flight", async () => {
    await storage.applyBatch(VAULT_A, upsertBatch(1, [note("A.md", "a", [1, 0, 0])]));
    const changing: QueryEmbeddingProvider = {
      async embedQuery(): Promise<Float32Array> {
        await storage.applyBatch(VAULT_A, upsertBatch(2, [note("B.md", "b", [1, 0, 0])], {
          replaceVault: true, descriptor: descriptor({ model: "other", embeddingSpaceId: "other" }),
        }));
        return new Float32Array([1, 0, 0]);
      },
    };
    await expect(new SqliteSemanticSearch(storage, changing).search(VAULT_A, "q", 5))
      .rejects.toMatchObject({ code: "SEMANTIC_SEARCH_UNAVAILABLE" });
  });
});
