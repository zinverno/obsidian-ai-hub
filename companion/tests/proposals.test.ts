import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteCompanionStorage } from "../src/storage/sqliteCompanionStorage.js";
import { SqliteProposalStorage, createMcpProposalCapability } from "../src/proposals/storage.js";
import { stableHash } from "../src/proposals/contentHash.js";
import { CLAIM_LEASE_MS, MAX_PROPOSAL_CONTENT, validProposalDetail, validProposalPath } from "../src/proposals/types.js";
import type { ProposalInput } from "../src/proposals/types.js";
import { note, upsertBatch, VAULT_A, VAULT_B } from "./fixtures.js";

const original = "# Note\r\n\r\nПривет 😀\n";
const update: ProposalInput = { operation: "UPDATE_NOTE", path: "A.md", expectedContentHash: stableHash(original), proposedContent: original + "New line\n", summary: "Add one line" };

describe("persistent isolated proposal queue", () => {
  let directory: string; let mirror: SqliteCompanionStorage; let database: DatabaseSync; let store: SqliteProposalStorage; let now: number;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "proposals-")); mirror = new SqliteCompanionStorage(directory); await mirror.initialize();
    const value = note("A.md", original, [1, 0, 0]); value.contentHash = stableHash(original);
    await mirror.applyBatch(VAULT_A, upsertBatch(1, [value]));
    database = new DatabaseSync(join(directory, "companion.sqlite")); now = 1000;
    store = new SqliteProposalStorage(database, () => now);
  });
  afterEach(async () => { database.close(); await mirror.close(); await rm(directory, { recursive: true, force: true }); });
  it("creates random UUID proposals and preserves every mirrored byte, generation, revision and vector", async () => {
    const before = await mirror.readVault(VAULT_A); const snapshot = await mirror.getSearchSnapshot(VAULT_A);
    const sync = vi.spyOn(mirror, "applyBatch"); const derived = vi.fn(); mirror.subscribeCommits(derived);
    const first = store.create(VAULT_A, update); const second = store.create(VAULT_A, update);
    expect(first.proposalId).toMatch(/^[0-9a-f-]{36}$/u); expect(first.proposalId).not.toBe(second.proposalId);
    expect(first.status).toBe("PENDING"); expect(first).not.toHaveProperty("proposedContent");
    expect(validProposalDetail(store.get(VAULT_A, first.proposalId))).toBe(true);
    expect(await mirror.readVault(VAULT_A)).toEqual(before); expect(await mirror.getSearchSnapshot(VAULT_A)).toEqual(snapshot);
    expect(sync).not.toHaveBeenCalled(); expect(derived).not.toHaveBeenCalled();
  });
  it("persists across restart and isolates Vault access", () => {
    const first = store.create(VAULT_A, update); database.close(); database = new DatabaseSync(join(directory, "companion.sqlite"));
    store = new SqliteProposalStorage(database, () => now);
    expect(store.get(VAULT_A, first.proposalId)).toMatchObject({ status: "PENDING", baseContent: original });
    expect(() => store.get(VAULT_B, first.proposalId)).toThrow("PROPOSAL_NOT_FOUND");
    expect(store.list(VAULT_B).proposals).toEqual([]);
  });
  it("creates CREATE and DELETE with exact mirror preconditions", () => {
    expect(store.create(VAULT_A, { operation: "CREATE_NOTE", path: "New.md", proposedContent: "" }).status).toBe("PENDING");
    expect(() => store.create(VAULT_A, { operation: "CREATE_NOTE", path: "A.md", proposedContent: "new" })).toThrow("PROPOSAL_CONFLICT");
    expect(store.create(VAULT_A, { operation: "DELETE_NOTE", path: "A.md", expectedContentHash: stableHash(original) }).status).toBe("PENDING");
  });
  it.each(["UPDATE_NOTE", "DELETE_NOTE"] as const)("rejects stale or missing %s base", (operation) => {
    const input = { ...update, operation }; if (operation === "DELETE_NOTE") delete input.proposedContent;
    expect(() => store.create(VAULT_A, { ...input, expectedContentHash: stableHash("stale") })).toThrow("PROPOSAL_CONFLICT");
    expect(() => store.create(VAULT_A, { ...input, path: "missing.md" })).toThrow("PROPOSAL_CONFLICT");
  });
  it("rejects no-op updates and preserves CRLF/LF hash semantics", () => {
    expect(() => store.create(VAULT_A, { ...update, proposedContent: original })).toThrow("PROPOSAL_CONFLICT");
    expect(stableHash(original)).not.toBe(stableHash(original.replaceAll("\r\n", "\n")));
    expect(store.get(VAULT_A, store.create(VAULT_A, update).proposalId).proposedContentHash).toBe(stableHash(update.proposedContent!));
  });
  it.each(["/A.md", "../A.md", "a/../A.md", "a\\b.md", "a//b.md", "https://host/a.md", ".obsidian/A.md", ".OBSIDIAN/a.md", "a/./b.md", "C:/A.md", "a.txt", "a\0.md", " a.md", "dir. /a.md"])("rejects unsafe path %s", (path) => {
    expect(validProposalPath(path)).toBe(false);
    expect(() => store.create(VAULT_A, { operation: "CREATE_NOTE", path, proposedContent: "x" })).toThrow();
  });
  it("rejects unknown fields, incompatible operation fields and oversized text", () => {
    expect(() => store.create(VAULT_A, { ...update, vaultId: VAULT_B } as ProposalInput)).toThrow("INVALID_REQUEST");
    expect(() => store.create(VAULT_A, { ...update, summary: "😀".repeat(2001) })).toThrow("INVALID_REQUEST");
    expect(() => store.create(VAULT_A, { ...update, proposedContent: "x".repeat(MAX_PROPOSAL_CONTENT + 1) })).toThrow("INVALID_REQUEST");
    expect(() => store.create(VAULT_A, { ...update, operation: "DELETE_NOTE" })).toThrow("INVALID_REQUEST");
    expect(() => store.create(VAULT_A, { ...update, operation: "CREATE_NOTE" })).toThrow("INVALID_REQUEST");
  });
  it("permits one claim, rejects collisions, and requires the valid claim for completion", () => {
    const id = store.create(VAULT_A, update).proposalId; const claim = store.claim(VAULT_A, id);
    expect(claim.proposal.status).toBe("CLAIMED"); expect(claim.leaseDurationMs).toBe(CLAIM_LEASE_MS);
    expect(() => store.claim(VAULT_A, id)).toThrow("PROPOSAL_NOT_PENDING");
    expect(() => store.complete(VAULT_A, id, { claimId: id, status: "APPLIED" })).toThrow("PROPOSAL_INVALID_CLAIM");
    expect(store.complete(VAULT_A, id, { claimId: claim.claimId, status: "APPLIED" }).status).toBe("APPLIED");
    expect(store.complete(VAULT_A, id, { claimId: claim.claimId, status: "APPLIED" }).status).toBe("APPLIED");
    expect(() => store.claim(VAULT_A, id)).toThrow("PROPOSAL_NOT_PENDING");
    expect(() => store.reject(VAULT_A, id)).toThrow("PROPOSAL_NOT_PENDING");
  });
  it("expired claims recover after crashed plugin and old claims cannot complete", () => {
    const id = store.create(VAULT_A, update).proposalId; const first = store.claim(VAULT_A, id);
    now += CLAIM_LEASE_MS;
    expect(store.get(VAULT_A, id).status).toBe("PENDING");
    const second = store.claim(VAULT_A, id); expect(second.claimId).not.toBe(first.claimId);
    expect(() => store.complete(VAULT_A, id, { claimId: first.claimId, status: "APPLIED" })).toThrow("PROPOSAL_INVALID_CLAIM");
    expect(store.complete(VAULT_A, id, { claimId: second.claimId, status: "CONFLICT", statusCode: "PRECONDITION_FAILED" }).status).toBe("CONFLICT");
  });
  it.each(["CONFLICT", "FAILED"] as const)("%s is terminal and fixed codes are enforced", (status) => {
    const id = store.create(VAULT_A, update).proposalId; const claim = store.claim(VAULT_A, id);
    expect(() => store.complete(VAULT_A, id, { claimId: claim.claimId, status, statusCode: "secret content" } as never)).toThrow("INVALID_REQUEST");
    expect(store.complete(VAULT_A, id, { claimId: claim.claimId, status, statusCode: status === "CONFLICT" ? "PRECONDITION_FAILED" : "VAULT_WRITE_FAILED" }).status).toBe(status);
    expect(() => store.complete(VAULT_A, id, { claimId: claim.claimId, status: "APPLIED" })).toThrow("PROPOSAL_INVALID_CLAIM");
  });
  it("reject is idempotent and cannot reject a claimed proposal", async () => {
    const before = await mirror.readVault(VAULT_A); const id = store.create(VAULT_A, update).proposalId;
    expect(store.reject(VAULT_A, id).status).toBe("REJECTED"); expect(store.reject(VAULT_A, id).status).toBe("REJECTED");
    expect(() => store.claim(VAULT_A, id)).toThrow("PROPOSAL_NOT_PENDING");
    const next = store.create(VAULT_A, update).proposalId; store.claim(VAULT_A, next);
    expect(() => store.reject(VAULT_A, next)).toThrow("PROPOSAL_NOT_PENDING");
    expect(await mirror.readVault(VAULT_A)).toEqual(before);
  });
  it("bounds and paginates pending proposals, expires old pending and retains recent terminal history", () => {
    for (let i = 0; i < 100; i++) store.create(VAULT_A, update);
    expect(() => store.create(VAULT_A, update)).toThrow("PROPOSAL_LIMIT");
    const first = store.list(VAULT_A, "", 50); const next = store.list(VAULT_A, first.nextCursor!, 50);
    expect(new Set([...first.proposals, ...next.proposals].map((p) => p.proposalId)).size).toBe(100); expect(next.nextCursor).toBeNull();
    const id = first.proposals[0]!.proposalId; store.reject(VAULT_A, id); now += 31 * 86400_000;
    expect(store.list(VAULT_A).proposals).toEqual([]); expect(() => store.get(VAULT_A, id)).toThrow("PROPOSAL_NOT_FOUND");
    expect(store.get(VAULT_A, first.proposals[1]!.proposalId).status).toBe("EXPIRED");
  });
  it("MCP capability exposes only scoped create/get and cannot approve or write mirror", () => {
    const capability = createMcpProposalCapability(store, VAULT_A);
    expect(Object.keys(capability).sort()).toEqual(["create", "get"]); expect(Object.isFrozen(capability)).toBe(true);
    const proposal = capability.create(update); expect(capability.get(proposal.proposalId)).not.toHaveProperty("baseContent");
    expect(capability.get(proposal.proposalId)).not.toHaveProperty("claimId");
  });
});
