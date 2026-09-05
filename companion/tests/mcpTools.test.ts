import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryEmbeddingProvider } from "../src/mcp/queryEmbedding.js";
import { MAX_CHUNK_TEXT_CODE_POINTS, MAX_NOTE_MAX_CHARS, VaultMcpService } from "../src/mcp/service.js";
import { SqliteSemanticSearch } from "../src/mcp/semanticSearch.js";
import type { MirroredNote } from "../src/protocol/types.js";
import { SqliteCompanionStorage } from "../src/storage/sqliteCompanionStorage.js";
import { createMcpReadView } from "../src/storage/mcpReadStorage.js";
import { note, upsertBatch, VAULT_A, VAULT_B } from "./fixtures.js";

function chunkedNote(): MirroredNote {
  const value = note("A.md", "A😀БZ", [1, 0, 0]);
  value.chunks = [
    {
      ...value.chunks[0]!,
      chunkId: "chunk-z",
      ordinal: 2,
      headingPath: ["Third"],
      text: "x".repeat(MAX_CHUNK_TEXT_CODE_POINTS + 1),
      source: { startOffset: 3, endOffset: 4, startLine: 2, endLine: 2 },
    },
    {
      ...value.chunks[0]!,
      chunkId: "chunk-a",
      ordinal: 0,
      headingPath: ["First"],
      text: "A😀",
      source: { startOffset: 0, endOffset: 2, startLine: 0, endLine: 0 },
    },
    {
      ...value.chunks[0]!,
      chunkId: "chunk-m",
      ordinal: 1,
      headingPath: ["Second"],
      text: "БZ",
      source: { startOffset: 2, endOffset: 4, startLine: 1, endLine: 1 },
    },
  ];
  return value;
}

describe("read-only MCP tool service", () => {
  let directory: string;
  let storage: SqliteCompanionStorage;
  let provider: QueryEmbeddingProvider;
  let providerCalls: number;
  let service: VaultMcpService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "vault-companion-mcp-tools-"));
    storage = new SqliteCompanionStorage(directory);
    await storage.initialize();
    await storage.applyBatch(VAULT_A, upsertBatch(1, [
      note("Folder/C.md", "C", [0, 1, 0]),
      note("B.md", "B", [0, 0, 1]),
      chunkedNote(),
    ]));
    providerCalls = 0;
    provider = {
      embedQuery: async (): Promise<Float32Array> => {
        providerCalls++;
        return new Float32Array([1, 0, 0]);
      },
    };
    service = new VaultMcpService(storage, VAULT_A, new SqliteSemanticSearch(storage, provider));
  });

  afterEach(async () => {
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("returns only aggregate status for the configured vault and handles an absent vault", async () => {
    expect(await service.vaultStatus()).toMatchObject({
      exists: true,
      generation: 1,
      noteCount: 3,
      chunkCount: 5,
      descriptor: { providerId: "openai-compatible", dimensions: 3 },
    });
    const absent = new VaultMcpService(storage, VAULT_B, new SqliteSemanticSearch(storage, provider));
    expect(await absent.vaultStatus()).toMatchObject({ exists: false, noteCount: 0, chunkCount: 0, descriptor: null });
  });

  it("lists notes deterministically with prefix filtering, opaque pagination, and hard limits", async () => {
    const first = await service.listNotes({ limit: 2 });
    expect(first.notes.map((item) => item.path)).toEqual(["A.md", "B.md"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await service.listNotes({ limit: 2, cursor: first.nextCursor! });
    expect(second.notes.map((item) => item.path)).toEqual(["Folder/C.md"]);
    expect(second.nextCursor).toBeNull();
    expect((await service.listNotes({ prefix: "Folder/" })).notes.map((item) => item.path)).toEqual(["Folder/C.md"]);
    await expect(service.listNotes({ limit: 201 })).rejects.toThrow(/200/u);
    await expect(service.listNotes({ prefix: "Elsewhere/", cursor: first.nextCursor! })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("slices note content by Unicode code point without splitting surrogate pairs", async () => {
    expect(await service.getNote({ path: "A.md", startOffset: 1, maxChars: 2 })).toMatchObject({
      content: "😀Б",
      startOffset: 1,
      endOffset: 3,
      totalChars: 4,
      truncated: true,
    });
    await expect(service.getNote({ path: "A.md", maxChars: MAX_NOTE_MAX_CHARS + 1 })).rejects.toThrow(/50000/u);
    await expect(service.getNote({ path: "../A.md" })).rejects.toThrow(/canonical/u);
    await expect(service.getNote({ path: "Missing.md" })).rejects.toMatchObject({ code: "NOTE_NOT_FOUND" });
  });

  it("returns chunks in ordinal order with source data, bounded text, and pagination", async () => {
    const first = await service.getChunks({ path: "A.md", limit: 2 });
    expect(first.chunks.map((item) => item.chunkId)).toEqual(["chunk-a", "chunk-m"]);
    expect(first.chunks[0]).toMatchObject({
      path: "A.md",
      headingPath: ["First"],
      source: { startOffset: 0, endOffset: 2, startLine: 0, endLine: 0 },
    });
    const second = await service.getChunks({ path: "A.md", limit: 2, cursor: first.nextCursor! });
    expect(second.chunks[0]).toMatchObject({
      chunkId: "chunk-z",
      textTruncated: true,
      totalTextChars: MAX_CHUNK_TEXT_CODE_POINTS + 1,
    });
    expect(second.chunks[0]?.text).toHaveLength(MAX_CHUNK_TEXT_CODE_POINTS);
    await expect(service.getChunks({ path: "Missing.md" })).rejects.toMatchObject({ code: "NOTE_NOT_FOUND" });
  });

  it("never exposes embeddings and no read tool invokes the sync mutation API", async () => {
    const mutation = vi.spyOn(storage, "applyBatch");
    await service.vaultStatus();
    await service.listNotes({});
    await service.getNote({ path: "A.md" });
    const chunks = await service.getChunks({ path: "A.md" });
    expect(providerCalls).toBe(0);
    const search = await service.searchVault({ query: "alpha", limit: 1 });
    expect(providerCalls).toBe(1);
    expect(mutation).not.toHaveBeenCalled();
    expect(JSON.stringify({ chunks, search })).not.toMatch(/embedding|vector/iu);
  });

  it("provides a frozen read-only runtime capability view", () => {
    const view = createMcpReadView(storage);
    expect(Object.isFrozen(view)).toBe(true);
    expect(view).not.toHaveProperty("applyBatch");
    expect(view).not.toHaveProperty("readVault");
    expect(view).not.toHaveProperty("initialize");
    expect(view).not.toHaveProperty("database");
  });

  it("bounds malicious heading metadata with explicit truncation flags", async () => {
    const value = note("Headings.md", "data", [1, 0, 0]);
    value.chunks[0]!.headingPath = Array.from({ length: 50 }, () => "😀".repeat(1000));
    await storage.applyBatch(VAULT_A, upsertBatch(2, [value]));
    const { chunks } = await service.getChunks({ path: "Headings.md" });
    expect(chunks[0]?.headingPath).toHaveLength(16);
    expect(Array.from(chunks[0]!.headingPath[0]!)).toHaveLength(256);
    expect(chunks[0]).toMatchObject({ headingPathTruncated: true, totalHeadings: 50 });
  });
});
