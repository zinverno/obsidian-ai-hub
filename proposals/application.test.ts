/* eslint-disable @typescript-eslint/unbound-method -- Assertions inspect mocks without invoking unbound methods. */
import { describe, expect, it, vi } from "vitest";
import { ProposalApplication, ProposalConflict } from "./application";
import type { ProposalApi, ProposalVault } from "./application";
import { stableHash } from "../chunking/hash";
import { stableHash as companionHash } from "../companion/src/proposals/contentHash";
import { CLAIM_LEASE_MS } from "../companion/src/proposals/types";
import type { ProposalDetail, ProposalOperation } from "../companion/src/proposals/types";

const id = "11111111-1111-4111-8111-111111111111";
const claimId = "22222222-2222-4222-8222-222222222222";
const base = "# Note\r\n\r\nПривет 😀\n";
const next = base + "New line\n";
function fixture(operation: ProposalOperation = "UPDATE_NOTE") {
  const proposal: ProposalDetail = { proposalId: id, operation, path: "A.md", summary: "Review this change", status: "PENDING",
    createdAt: 1, updatedAt: 1, claimedAt: null, claimExpiresAt: null, appliedAt: null, statusCode: null,
    baseContent: operation === "CREATE_NOTE" ? null : base, baseContentHash: operation === "CREATE_NOTE" ? null : stableHash(base),
    proposedContent: operation === "DELETE_NOTE" ? null : next, proposedContentHash: operation === "DELETE_NOTE" ? null : stableHash(next) };
  const files = new Map(operation === "CREATE_NOTE" ? [] : [["A.md", base]]);
  const events: string[] = []; let status = "PENDING"; let now = 0;
  const hooks = { beforeWrite: (): void => {}, failWrite: false, wrongResult: false };
  const api: ProposalApi = {
    listProposals: vi.fn<ProposalApi["listProposals"]>(async () => ({ proposals: [proposal], nextCursor: null })),
    getProposal: vi.fn<ProposalApi["getProposal"]>(async () => proposal),
    claimProposal: vi.fn<ProposalApi["claimProposal"]>(async () => { events.push("claim"); if (status !== "PENDING") throw new Error("already claimed"); status = "CLAIMED";
      return { proposal: { ...proposal, status: "CLAIMED", claimedAt: 1, claimExpiresAt: CLAIM_LEASE_MS + 1 }, claimId, leaseDurationMs: CLAIM_LEASE_MS }; }),
    completeProposal: vi.fn<ProposalApi["completeProposal"]>(async (_vault, _id, completion) => { events.push("complete"); status = completion.status; return { ...proposal, status: completion.status }; }),
    rejectProposal: vi.fn<ProposalApi["rejectProposal"]>(async () => { status = "REJECTED"; return { ...proposal, status: "REJECTED" as const }; }),
  };
  const write = (path: string, content: string | null): void => {
    if (hooks.failWrite) throw new Error("private upstream error"); events.push("write");
    if (content === null) files.delete(path); else files.set(path, hooks.wrongResult ? "wrong result" : content);
  };
  const vault: ProposalVault = {
    configDir: ".obsidian", read: vi.fn<ProposalVault["read"]>(async (path) => files.get(path) ?? null),
    create: vi.fn<ProposalVault["create"]>(async (path, content, guard) => { hooks.beforeWrite(); guard(); if (files.has(path)) throw new ProposalConflict(); write(path, content); }),
    update: vi.fn<ProposalVault["update"]>(async (path, transform) => { hooks.beforeWrite(); const current = files.get(path); if (current === undefined) throw new ProposalConflict(); write(path, transform(current)); }),
    remove: vi.fn<ProposalVault["remove"]>(async (path, check) => { hooks.beforeWrite(); const current = files.get(path); if (current === undefined) throw new ProposalConflict(); check(current); write(path, null); }),
  };
  const app = new ProposalApplication(api, "vault", vault, () => now);
  return { app, api, vault, proposal, files, events, hooks, advance: (ms: number): void => { now += ms; } };
}

describe("explicit plugin proposal application", () => {
  it("matching UPDATE performs one write after claim, verifies content, then completes APPLIED", async () => {
    const f = fixture(); expect(await f.app.approve(f.proposal)).toEqual({ status: "APPLIED", completionPending: false });
    expect(f.files.get("A.md")).toBe(next); expect(f.events).toEqual(["claim", "write", "complete"]);
    expect(f.api.completeProposal).toHaveBeenCalledWith("vault", id, { claimId, status: "APPLIED" });
  });
  it("stale expected hash conflicts without writing current content", async () => {
    const f = fixture(); f.files.set("A.md", "manual edit");
    expect((await f.app.approve(f.proposal)).status).toBe("CONFLICT");
    expect(f.files.get("A.md")).toBe("manual edit"); expect(f.events).toEqual(["claim", "complete"]);
  });
  it("content changed after claim is rechecked inside the atomic write callback", async () => {
    const f = fixture(); f.hooks.beforeWrite = () => { f.files.set("A.md", "changed after claim"); };
    expect((await f.app.approve(f.proposal)).status).toBe("CONFLICT");
    expect(f.files.get("A.md")).toBe("changed after claim"); expect(f.events).not.toContain("write");
  });
  it("write failure becomes FAILED with a fixed code and is never retried", async () => {
    const f = fixture(); f.hooks.failWrite = true;
    expect((await f.app.approve(f.proposal)).status).toBe("FAILED");
    expect(f.api.completeProposal).toHaveBeenCalledWith("vault", id, { claimId, status: "FAILED", statusCode: "VAULT_WRITE_FAILED" });
    expect(f.files.get("A.md")).toBe(base); expect(f.vault.update).toHaveBeenCalledTimes(1);
  });
  it("claim failure or Companion outage never permits a speculative write", async () => {
    const f = fixture(); vi.mocked(f.api.claimProposal).mockRejectedValue(new Error("offline or claimed elsewhere"));
    await expect(f.app.approve(f.proposal)).rejects.toThrow(); expect(f.files.get("A.md")).toBe(base);
    expect(f.vault.update).not.toHaveBeenCalled(); expect(f.api.completeProposal).not.toHaveBeenCalled();
  });
  it("already APPLIED proposals cannot be applied again", async () => {
    const f = fixture(); await expect(f.app.approve({ ...f.proposal, status: "APPLIED" })).rejects.toThrow();
    expect(f.api.claimProposal).not.toHaveBeenCalled(); expect(f.events).toEqual([]);
  });
  it("double click Approve produces exactly one Vault mutation", async () => {
    const f = fixture(); const first = f.app.approve(f.proposal); const second = f.app.approve(f.proposal);
    expect(first).toBe(second); await Promise.all([first, second]);
    expect(f.api.claimProposal).toHaveBeenCalledTimes(1); expect(f.events.filter((e) => e === "write")).toHaveLength(1);
    await f.app.approve(f.proposal); expect(f.events.filter((e) => e === "write")).toHaveLength(1);
  });
  it("CREATE rechecks absence and verifies new content", async () => {
    const f = fixture("CREATE_NOTE"); expect((await f.app.approve(f.proposal)).status).toBe("APPLIED");
    expect(f.files.get("A.md")).toBe(next); expect(f.events).toEqual(["claim", "write", "complete"]);
  });
  it("CREATE conflicts if a target appeared after review", async () => {
    const f = fixture("CREATE_NOTE"); f.files.set("A.md", "appeared");
    expect((await f.app.approve(f.proposal)).status).toBe("CONFLICT"); expect(f.files.get("A.md")).toBe("appeared");
    expect(f.events).not.toContain("write");
  });
  it("DELETE requires the exact current base and verifies absence", async () => {
    const f = fixture("DELETE_NOTE"); expect((await f.app.approve(f.proposal)).status).toBe("APPLIED");
    expect(f.files.has("A.md")).toBe(false); expect(f.events).toEqual(["claim", "write", "complete"]);
  });
  it.each(["changed", "absent"])("DELETE conflicts when the file is %s", async (kind) => {
    const f = fixture("DELETE_NOTE"); if (kind === "absent") f.files.delete("A.md"); else f.files.set("A.md", "changed");
    expect((await f.app.approve(f.proposal)).status).toBe("CONFLICT"); expect(f.events).not.toContain("write");
  });
  it("Reject modifies only proposal state, never the note", async () => {
    const f = fixture(); expect((await f.app.reject(id)).status).toBe("REJECTED");
    expect(f.files.get("A.md")).toBe(base); expect(f.events).toEqual([]); expect(f.vault.update).not.toHaveBeenCalled();
  });
  it("a lease expiring while waiting to write prevents the write", async () => {
    const f = fixture(); f.hooks.beforeWrite = () => f.advance(CLAIM_LEASE_MS);
    expect((await f.app.approve(f.proposal)).status).toBe("FAILED"); expect(f.events).not.toContain("write");
    expect(f.api.completeProposal).toHaveBeenCalledWith("vault", id, { claimId, status: "FAILED", statusCode: "LEASE_EXPIRED" });
  });
  it("post-write verification failure is not APPLIED", async () => {
    const f = fixture(); f.hooks.wrongResult = true;
    expect((await f.app.approve(f.proposal)).status).toBe("FAILED");
    expect(f.api.completeProposal).toHaveBeenCalledWith("vault", id, { claimId, status: "FAILED", statusCode: "VERIFY_FAILED" });
  });
  it("lost completion acknowledgement retries only completion, never writes twice", async () => {
    const f = fixture(); vi.mocked(f.api.completeProposal).mockRejectedValueOnce(new Error("offline"));
    expect(await f.app.approve(f.proposal)).toEqual({ status: "APPLIED", completionPending: true });
    expect(await f.app.approve(f.proposal)).toEqual({ status: "APPLIED", completionPending: false });
    expect(f.events.filter((e) => e === "write")).toHaveLength(1); expect(f.api.claimProposal).toHaveBeenCalledTimes(1);
  });
  it("malformed or changed claimed content never replaces the reviewed content", async () => {
    const f = fixture(); vi.mocked(f.api.claimProposal).mockResolvedValue({ claimId, leaseDurationMs: CLAIM_LEASE_MS,
      proposal: { ...f.proposal, status: "CLAIMED", proposedContent: "different", proposedContentHash: stableHash("different") } });
    await expect(f.app.approve(f.proposal)).rejects.toThrow(); expect(f.events).not.toContain("write");
  });
  it("custom Obsidian config paths are blocked before claiming", async () => {
    const f = fixture(); f.vault.configDir = "private-config";
    await expect(f.app.approve({ ...f.proposal, path: "private-config/settings.md" })).rejects.toThrow();
    expect(f.api.claimProposal).not.toHaveBeenCalled();
  });
  it("plugin and Companion use one identical Unicode/line-ending hash implementation", () => {
    expect(stableHash).toBe(companionHash);
    for (const text of ["", "Привет 😀", "a\r\nb", "a\nb", "e\u0301", "é", "\ud800"]) expect(stableHash(text)).toBe(companionHash(text));
    expect(stableHash("a\r\nb")).not.toBe(stableHash("a\nb"));
  });
});

/* eslint-enable @typescript-eslint/unbound-method -- End mock-only assertions. */
