import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ProtocolError } from "../protocol/errors.js";
import { validateVaultPath } from "../protocol/schemas.js";
import { stableHash } from "./contentHash.js";
import { CLAIM_LEASE_MS, MAX_PROPOSAL_SUMMARY, validContent, validHash, validProposalId, validProposalPath } from "./types.js";
import type { ProposalClaim, ProposalCompletion, ProposalDetail, ProposalInput, ProposalPage, ProposalSummary } from "./types.js";

const RETENTION_MS = 30 * 86400_000;
export interface ProposalStore {
  create(vaultId: string, input: ProposalInput): ProposalSummary;
  get(vaultId: string, id: string): ProposalDetail;
  list(vaultId: string, cursor?: string, limit?: number): ProposalPage;
  claim(vaultId: string, id: string): ProposalClaim;
  complete(vaultId: string, id: string, input: ProposalCompletion): ProposalSummary;
  reject(vaultId: string, id: string): ProposalSummary;
}
export interface McpProposalCapability {
  create(input: ProposalInput): ProposalSummary;
  get(id: string): ProposalSummary;
}
export function proposalSummary(value: ProposalDetail): ProposalSummary {
  const { proposalId, operation, path, summary, status, createdAt, updatedAt, claimedAt, claimExpiresAt, appliedAt, statusCode } = value;
  return { proposalId, operation, path, summary, status, createdAt, updatedAt, claimedAt, claimExpiresAt, appliedAt, statusCode };
}
export function createMcpProposalCapability(store: ProposalStore, vaultId: string): McpProposalCapability {
  return Object.freeze({ create: (input: ProposalInput) => store.create(vaultId, input),
    get: (id: string) => proposalSummary(store.get(vaultId, id)) });
}
function fail(code: "PROPOSAL_CONFLICT" | "PROPOSAL_NOT_FOUND" | "PROPOSAL_NOT_PENDING" | "PROPOSAL_INVALID_CLAIM" | "PROPOSAL_LIMIT" | "INVALID_REQUEST"): never {
  throw new ProtocolError(code === "PROPOSAL_NOT_FOUND" ? 404 : code === "INVALID_REQUEST" ? 400 : 409, code, code);
}
function strict(value: object, keys: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) fail("INVALID_REQUEST");
}
const SELECT = `SELECT proposal_id AS proposalId, operation, path, summary, status,
 created_at AS createdAt, updated_at AS updatedAt, claimed_at AS claimedAt, claim_expires_at AS claimExpiresAt,
 applied_at AS appliedAt, status_code AS statusCode, base_content_hash AS baseContentHash, base_content AS baseContent,
 proposed_content_hash AS proposedContentHash, proposed_content AS proposedContent FROM proposals`;

/** Owns proposal rows only. It can SELECT mirror preconditions but exposes no mirror mutation or filesystem capability. */
export class SqliteProposalStorage implements ProposalStore {
  constructor(private readonly database: DatabaseSync, private readonly now: () => number = Date.now) {}
  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  private maintain(): void {
    const now = this.now();
    this.database.prepare(`UPDATE proposals SET status = 'PENDING', claim_id = NULL, claim_expires_at = NULL, updated_at = ?
      WHERE status = 'CLAIMED' AND claim_expires_at <= ?`).run(now, now);
    this.database.prepare(`UPDATE proposals SET status = 'EXPIRED', updated_at = ?
      WHERE status = 'PENDING' AND created_at < ?`).run(now, now - RETENTION_MS);
    this.database.prepare(`DELETE FROM proposals WHERE proposal_id IN
      (SELECT proposal_id FROM proposals WHERE status NOT IN ('PENDING','CLAIMED') AND updated_at < ? LIMIT 200)`)
      .run(now - RETENTION_MS);
  }
  create(vaultId: string, input: ProposalInput): ProposalSummary {
    strict(input, ["operation", "path", "expectedContentHash", "proposedContent", "summary"]);
    validateVaultPath(input.path);
    if (!validProposalPath(input.path) || !["CREATE_NOTE", "UPDATE_NOTE", "DELETE_NOTE"].includes(input.operation) ||
        (input.summary !== undefined && (typeof input.summary !== "string" || Array.from(input.summary).length > MAX_PROPOSAL_SUMMARY))) fail("INVALID_REQUEST");
    if (input.operation === "CREATE_NOTE" ? input.expectedContentHash !== undefined : !validHash(input.expectedContentHash)) fail("INVALID_REQUEST");
    if (input.operation === "DELETE_NOTE" ? input.proposedContent !== undefined : !validContent(input.proposedContent)) fail("INVALID_REQUEST");
    return this.transaction(() => {
      this.maintain();
      const note = this.database.prepare("SELECT content, content_hash FROM notes WHERE vault_id = ? AND path = ?").get(vaultId, input.path) as { content: string; content_hash: string } | undefined;
      if (input.operation === "CREATE_NOTE" ? Boolean(note) : !note || note.content_hash !== input.expectedContentHash) fail("PROPOSAL_CONFLICT");
      if (note && (!validContent(note.content) || stableHash(note.content) !== note.content_hash)) fail("PROPOSAL_CONFLICT");
      if (input.operation === "UPDATE_NOTE" && input.proposedContent === note?.content) fail("PROPOSAL_CONFLICT");
      const counts = this.database.prepare(`SELECT count(*) AS total,
        sum(CASE WHEN vault_id = ? AND status IN ('PENDING','CLAIMED') THEN 1 ELSE 0 END) AS pending FROM proposals`).get(vaultId) as { total: number; pending: number };
      if (counts.total >= 2000 || counts.pending >= 100) fail("PROPOSAL_LIMIT");
      const id = randomUUID(); const now = this.now();
      this.database.prepare(`INSERT INTO proposals (proposal_id, vault_id, operation, path, base_content_hash, base_content,
        proposed_content, proposed_content_hash, summary, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`)
        .run(id, vaultId, input.operation, input.path, note?.content_hash ?? null, note?.content ?? null, input.proposedContent ?? null,
          input.proposedContent === undefined ? null : stableHash(input.proposedContent), input.summary ?? "", now, now);
      return proposalSummary(this.read(vaultId, id));
    });
  }
  private read(vaultId: string, id: string): ProposalDetail {
    if (!validProposalId(id)) fail("INVALID_REQUEST");
    const row = this.database.prepare(`${SELECT} WHERE vault_id = ? AND proposal_id = ?`).get(vaultId, id) as unknown as ProposalDetail | undefined;
    if (!row) fail("PROPOSAL_NOT_FOUND");
    return row;
  }
  get(vaultId: string, id: string): ProposalDetail { this.maintain(); return this.read(vaultId, id); }
  list(vaultId: string, cursor = "", limit = 20): ProposalPage {
    this.maintain();
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (cursor && !validProposalId(cursor))) fail("INVALID_REQUEST");
    const rows = this.database.prepare(`${SELECT} WHERE vault_id = ? AND status IN ('PENDING','CLAIMED') AND proposal_id > ? ORDER BY proposal_id LIMIT ?`)
      .all(vaultId, cursor, limit + 1) as unknown as ProposalDetail[];
    const page = rows.slice(0, limit);
    return { proposals: page.map(proposalSummary), nextCursor: rows.length > limit ? page.at(-1)!.proposalId : null };
  }
  claim(vaultId: string, id: string): ProposalClaim {
    return this.transaction(() => {
      this.maintain(); const proposal = this.read(vaultId, id);
      if (proposal.status !== "PENDING") fail("PROPOSAL_NOT_PENDING");
      const now = this.now(); const claimId = randomUUID();
      this.database.prepare(`UPDATE proposals SET status = 'CLAIMED', claimed_at = ?, claim_expires_at = ?, claim_id = ?, updated_at = ?
        WHERE vault_id = ? AND proposal_id = ? AND status = 'PENDING'`).run(now, now + CLAIM_LEASE_MS, claimId, now, vaultId, id);
      return { proposal: this.read(vaultId, id), claimId, leaseDurationMs: CLAIM_LEASE_MS };
    });
  }
  complete(vaultId: string, id: string, input: ProposalCompletion): ProposalSummary {
    strict(input, ["claimId", "status", "statusCode"]);
    if (!validProposalId(input.claimId) || !["APPLIED", "CONFLICT", "FAILED"].includes(input.status) ||
        (input.status === "APPLIED" ? input.statusCode !== undefined :
          input.status === "CONFLICT" ? input.statusCode !== "PRECONDITION_FAILED" :
            !["VAULT_WRITE_FAILED", "VERIFY_FAILED", "LEASE_EXPIRED"].includes(input.statusCode ?? ""))) fail("INVALID_REQUEST");
    return this.transaction(() => {
      this.maintain(); const proposal = this.read(vaultId, id);
      const row = this.database.prepare("SELECT claim_id FROM proposals WHERE vault_id = ? AND proposal_id = ?").get(vaultId, id) as { claim_id: string | null };
      if (row.claim_id !== input.claimId) fail("PROPOSAL_INVALID_CLAIM");
      if (proposal.status === input.status && proposal.statusCode === (input.statusCode ?? null)) return proposalSummary(proposal);
      if (proposal.status !== "CLAIMED" || proposal.claimExpiresAt! <= this.now()) fail("PROPOSAL_INVALID_CLAIM");
      const now = this.now();
      this.database.prepare("UPDATE proposals SET status = ?, status_code = ?, updated_at = ?, applied_at = ? WHERE vault_id = ? AND proposal_id = ?")
        .run(input.status, input.statusCode ?? null, now, input.status === "APPLIED" ? now : null, vaultId, id);
      return proposalSummary(this.read(vaultId, id));
    });
  }
  reject(vaultId: string, id: string): ProposalSummary {
    return this.transaction(() => {
      this.maintain(); const proposal = this.read(vaultId, id);
      if (proposal.status === "REJECTED") return proposalSummary(proposal);
      if (proposal.status !== "PENDING") fail("PROPOSAL_NOT_PENDING");
      this.database.prepare("UPDATE proposals SET status = 'REJECTED', updated_at = ? WHERE vault_id = ? AND proposal_id = ?")
        .run(this.now(), vaultId, id);
      return proposalSummary(this.read(vaultId, id));
    });
  }
}
