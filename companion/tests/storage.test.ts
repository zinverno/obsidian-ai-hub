import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProtocolError } from "../src/protocol/errors.js";
import { PROTOCOL_VERSION } from "../src/protocol/types.js";
import type { SyncBatchRequest } from "../src/protocol/types.js";
import { SqliteCompanionStorage } from "../src/storage/sqliteCompanionStorage.js";
import { descriptor, note, upsertBatch, VAULT_A, VAULT_B } from "./fixtures.js";

describe("SQLite Companion storage", () => {
  let directory: string;
  let storage: SqliteCompanionStorage;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "vault-companion-storage-"));
    storage = new SqliteCompanionStorage(directory);
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("initializes cleanly and idempotently", async () => {
    await storage.initialize();
    expect(await storage.getServerStatus()).toEqual({ vaultCount: 0 });
  });

  it("upserts notes and chunks and preserves Float32 vectors exactly", async () => {
    const original = note();
    await storage.applyBatch(VAULT_A, upsertBatch(1, [original]));
    const snapshot = await storage.readVault(VAULT_A);
    expect(snapshot?.notes[0]).toMatchObject({ path: "A.md", content: original.content });
    expect(snapshot?.notes[0]?.chunks[0]?.embedding).toEqual(
      Array.from(new Float32Array(original.chunks[0]!.embedding)),
    );
  });

  it("makes repeated UPSERT idempotent", async () => {
    const batch = upsertBatch(1, [note()]);
    await storage.applyBatch(VAULT_A, batch);
    await storage.applyBatch(VAULT_A, batch);
    expect(await storage.getVaultStatus(VAULT_A)).toMatchObject({ noteCount: 1, chunkCount: 1 });
  });

  it("DELETE cascades to chunks", async () => {
    await storage.applyBatch(VAULT_A, upsertBatch(1, [note()]));
    await storage.applyBatch(VAULT_A, { ...upsertBatch(2, []), operations: [{ type: "DELETE", path: "A.md" }] });
    expect(await storage.getVaultStatus(VAULT_A)).toMatchObject({ noteCount: 0, chunkCount: 0 });
  });

  it("RENAME atomically removes the old path", async () => {
    await storage.applyBatch(VAULT_A, upsertBatch(1, [note()]));
    const renamed = note("Folder/B.md", "# B\n\nBeta");
    const batch: SyncBatchRequest = {
      ...upsertBatch(2, []),
      operations: [{ type: "RENAME", oldPath: "A.md", note: renamed }],
    };
    await storage.applyBatch(VAULT_A, batch);
    await storage.applyBatch(VAULT_A, batch);
    expect((await storage.readVault(VAULT_A))?.notes.map((item) => item.path)).toEqual(["Folder/B.md"]);
    expect(await storage.getVaultStatus(VAULT_A)).toMatchObject({ noteCount: 1, chunkCount: 1 });
  });

  it("rolls back every operation when a batch fails", async () => {
    await storage.applyBatch(VAULT_A, upsertBatch(1, [note()]));
    const duplicate = note("C.md", "# C\n\nGamma");
    duplicate.chunks[0]!.chunkId = "duplicate";
    const collision = note("D.md", "# D\n\nDelta");
    collision.chunks[0]!.chunkId = "duplicate";
    await expect(storage.applyBatch(VAULT_A, upsertBatch(2, [duplicate, collision]))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect((await storage.readVault(VAULT_A))?.notes.map((item) => item.path)).toEqual(["A.md"]);
  });

  it("isolates identical note and chunk identities by vaultId", async () => {
    await storage.applyBatch(VAULT_A, upsertBatch(1, [note()]));
    await storage.applyBatch(VAULT_B, upsertBatch(1, [note()]));
    await storage.applyBatch(VAULT_A, { ...upsertBatch(2, []), operations: [{ type: "DELETE", path: "A.md" }] });
    expect((await storage.readVault(VAULT_A))?.notes).toEqual([]);
    expect((await storage.readVault(VAULT_B))?.notes).toHaveLength(1);
  });

  it("survives close and reopen with idempotent migrations", async () => {
    await storage.applyBatch(VAULT_A, upsertBatch(7, [note()]));
    await storage.close();
    storage = new SqliteCompanionStorage(directory);
    await storage.initialize();
    await storage.initialize();
    expect(await storage.getVaultStatus(VAULT_A)).toMatchObject({ generation: 7, noteCount: 1, chunkCount: 1 });
  });

  it("rejects incompatible vectors unless reconciliation explicitly replaces the vault", async () => {
    await storage.applyBatch(VAULT_A, upsertBatch(1, [note()]));
    const incompatible = descriptor({ model: "other", embeddingSpaceId: "other-space" });
    await expect(storage.applyBatch(VAULT_A, { ...upsertBatch(2, []), descriptor: incompatible })).rejects.toMatchObject({ code: "DESCRIPTOR_MISMATCH" });
    await storage.applyBatch(VAULT_A, {
      ...upsertBatch(2, [note("B.md")]),
      descriptor: incompatible,
      replaceVault: true,
    });
    expect((await storage.readVault(VAULT_A))?.notes.map((item) => item.path)).toEqual(["B.md"]);
  });

  it("ignores a stale batch instead of overwriting a newer generation", async () => {
    await storage.applyBatch(VAULT_A, upsertBatch(5, [note("New.md")]));
    const result = await storage.applyBatch(VAULT_A, upsertBatch(4, [note("Old.md")]));
    expect(result).toMatchObject({ applied: false, stale: true, generation: 5 });
    expect((await storage.readVault(VAULT_A))?.notes.map((item) => item.path)).toEqual(["New.md"]);
  });

  it("plans missing, changed, stale, and unchanged paths deterministically", async () => {
    const a = note("A.md", "a");
    const b = note("B.md", "b");
    const stale = note("Z.md", "z");
    await storage.applyBatch(VAULT_A, upsertBatch(1, [a, b, stale]));
    const changedB = note("B.md", "changed");
    const missingC = note("C.md", "c");
    const manifest = [missingC, changedB, a].map((item) => ({
      path: item.path,
      contentHash: item.contentHash,
      chunks: item.chunks.map((chunk) => ({ chunkId: chunk.chunkId, contentHash: chunk.contentHash })),
    }));
    const plan = await storage.planReconciliation(VAULT_A, 2, descriptor(), manifest);
    expect(plan).toMatchObject({ uploadPaths: ["B.md", "C.md"], deletePaths: ["Z.md"], unchangedPaths: ["A.md"], replaceVault: false });
  });

  it("makes reconciliation a no-op after convergence", async () => {
    const value = note();
    await storage.applyBatch(VAULT_A, upsertBatch(1, [value]));
    const manifest = [{ path: value.path, contentHash: value.contentHash, chunks: value.chunks.map((chunk) => ({ chunkId: chunk.chunkId, contentHash: chunk.contentHash })) }];
    const plan = await storage.planReconciliation(VAULT_A, 1, descriptor(), manifest);
    expect(plan).toMatchObject({ uploadPaths: [], deletePaths: [], unchangedPaths: ["A.md"] });
  });

  it("handles an empty manifest deterministically", async () => {
    expect(await storage.planReconciliation(VAULT_A, 0, descriptor(), [])).toMatchObject({
      serverGeneration: 0,
      uploadPaths: [],
      deletePaths: [],
      unchangedPaths: [],
    });
    await storage.applyBatch(VAULT_A, upsertBatch(1, [note("B.md"), note("A.md")]));
    expect(await storage.planReconciliation(VAULT_A, 2, descriptor(), [])).toMatchObject({
      uploadPaths: [],
      deletePaths: ["A.md", "B.md"],
      unchangedPaths: [],
    });
  });

  it("plans a full replacement for an incompatible descriptor", async () => {
    await storage.applyBatch(VAULT_A, upsertBatch(1, [note("A.md")]));
    const incoming = note("B.md");
    const plan = await storage.planReconciliation(VAULT_A, 2, descriptor({ model: "new", embeddingSpaceId: "new" }), [{
      path: incoming.path,
      contentHash: incoming.contentHash,
      chunks: incoming.chunks.map((chunk) => ({ chunkId: chunk.chunkId, contentHash: chunk.contentHash })),
    }]);
    expect(plan).toMatchObject({ replaceVault: true, uploadPaths: ["B.md"], deletePaths: ["A.md"] });
  });

  it("normalizes storage failures without exposing raw database errors", async () => {
    const left = note("Left.md");
    const right = note("Right.md");
    left.chunks[0]!.chunkId = "collision";
    right.chunks[0]!.chunkId = "collision";
    const bad: SyncBatchRequest = {
      protocolVersion: PROTOCOL_VERSION,
      generation: 1,
      descriptor: descriptor(),
      operations: [{ type: "UPSERT", note: left }, { type: "UPSERT", note: right }],
    };
    await expect(storage.applyBatch(VAULT_A, bad)).rejects.toBeInstanceOf(ProtocolError);
    await expect(storage.applyBatch(VAULT_A, bad)).rejects.not.toThrow(/UNIQUE|SQLITE/iu);
  });
});
