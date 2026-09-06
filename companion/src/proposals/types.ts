import { stableHash } from "./contentHash.js";

export const MAX_PROPOSAL_CONTENT = 250_000;
export const MAX_PROPOSAL_SUMMARY = 2000;
export const CLAIM_LEASE_MS = 120_000;
export type ProposalOperation = "CREATE_NOTE" | "UPDATE_NOTE" | "DELETE_NOTE";
export type ProposalStatus = "PENDING" | "CLAIMED" | "APPLIED" | "REJECTED" | "CONFLICT" | "FAILED" | "EXPIRED";
export type CompletionStatus = "APPLIED" | "CONFLICT" | "FAILED";
export type ProposalStatusCode = "PRECONDITION_FAILED" | "VAULT_WRITE_FAILED" | "VERIFY_FAILED" | "LEASE_EXPIRED";
export interface ProposalInput {
  operation: ProposalOperation; path: string; expectedContentHash?: string | undefined;
  proposedContent?: string | undefined; summary?: string | undefined;
}
export interface ProposalSummary {
  proposalId: string; operation: ProposalOperation; path: string; summary: string; status: ProposalStatus;
  createdAt: number; updatedAt: number; claimedAt: number | null; claimExpiresAt: number | null;
  appliedAt: number | null; statusCode: ProposalStatusCode | null;
}
export interface ProposalDetail extends ProposalSummary {
  baseContentHash: string | null; baseContent: string | null;
  proposedContentHash: string | null; proposedContent: string | null;
}
export interface ProposalClaim { proposal: ProposalDetail; claimId: string; leaseDurationMs: number }
export interface ProposalCompletion { claimId: string; status: CompletionStatus; statusCode?: ProposalStatusCode }
export interface ProposalPage { proposals: ProposalSummary[]; nextCursor: string | null }

/** Stricter than Stage 8 paths; shared by server and final Obsidian application. */
export function validProposalPath(value: unknown, configDir = ".obsidian"): value is string {
  if (typeof value !== "string" || !value || value.length > 4096 || value !== value.trim() ||
      (/[\\:]/u.test(value) || Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) || value.startsWith("/") || !/\.md$/iu.test(value)) return false;
  const parts = value.split("/");
  return !parts.some((part) => !part || part === "." || part === ".." || part.endsWith(".") || part !== part.trim() ||
    part.toLowerCase() === ".obsidian") && value.toLowerCase() !== configDir.toLowerCase() &&
    !value.toLowerCase().startsWith(`${configDir.toLowerCase()}/`);
}
export function validContent(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_PROPOSAL_CONTENT * 2 &&
    Array.from(value).length <= MAX_PROPOSAL_CONTENT && !value.includes("\0");
}
export function validProposalId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}
export function validHash(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{16}$/u.test(value); }

/** Validate untrusted plugin response before preview or any write. */
export function validProposalDetail(value: ProposalDetail): boolean {
  if (!value || !validProposalId(value.proposalId) || !validProposalPath(value.path) ||
      typeof value.summary !== "string" || Array.from(value.summary).length > MAX_PROPOSAL_SUMMARY ||
      !["PENDING", "CLAIMED", "APPLIED", "REJECTED", "CONFLICT", "FAILED", "EXPIRED"].includes(value.status) ||
      !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt)) return false;
  const hasBase = validContent(value.baseContent) && validHash(value.baseContentHash) && stableHash(value.baseContent) === value.baseContentHash;
  const hasNext = validContent(value.proposedContent) && validHash(value.proposedContentHash) && stableHash(value.proposedContent) === value.proposedContentHash;
  if (value.operation === "CREATE_NOTE") return value.baseContent === null && value.baseContentHash === null && hasNext;
  if (value.operation === "UPDATE_NOTE") return hasBase && hasNext && value.baseContent !== value.proposedContent;
  return value.operation === "DELETE_NOTE" && hasBase && value.proposedContent === null && value.proposedContentHash === null;
}
