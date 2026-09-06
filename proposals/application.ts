import { stableHash } from "../chunking/hash";
import { CLAIM_LEASE_MS, validProposalDetail, validProposalId, validProposalPath } from "../companion/src/proposals/types";
import type { ProposalClaim, ProposalCompletion, ProposalDetail, ProposalPage, ProposalSummary } from "../companion/src/proposals/types";

export interface ProposalApi {
  listProposals(vaultId: string, cursor?: string): Promise<ProposalPage>;
  getProposal(vaultId: string, id: string): Promise<ProposalDetail>;
  claimProposal(vaultId: string, id: string): Promise<ProposalClaim>;
  completeProposal(vaultId: string, id: string, result: ProposalCompletion): Promise<ProposalSummary>;
  rejectProposal(vaultId: string, id: string): Promise<ProposalSummary>;
}
export class ProposalConflict extends Error {}
export class ProposalLeaseExpired extends Error {}
export interface ProposalVault {
  configDir: string;
  read(path: string): Promise<string | null>;
  create(path: string, content: string, guard: () => void): Promise<void>;
  update(path: string, transform: (current: string) => string): Promise<void>;
  remove(path: string, check: (current: string) => void): Promise<void>;
}
export interface ApplyResult { status: string; completionPending: boolean }

/** Only the explicit review-button handler calls approve. No polling or sync callback can apply a proposal. */
export class ProposalApplication {
  private readonly inFlight = new Map<string, Promise<ApplyResult>>();
  private readonly receipts = new Map<string, ProposalCompletion>();
  constructor(readonly api: ProposalApi, readonly vaultId: string, readonly vault: ProposalVault,
    private readonly clock: () => number = () => performance.now()) {}

  approve(reviewed: ProposalDetail): Promise<ApplyResult> {
    const existing = this.inFlight.get(reviewed.proposalId);
    if (existing) return existing;
    const result = this.apply(reviewed).finally(() => { this.inFlight.delete(reviewed.proposalId); });
    this.inFlight.set(reviewed.proposalId, result);
    return result;
  }
  reject(id: string): Promise<ProposalSummary> { return this.api.rejectProposal(this.vaultId, id); }

  private async finish(id: string, outcome: ProposalCompletion): Promise<ApplyResult> {
    this.receipts.set(id, outcome); // Retry acknowledgement only, never the Vault write.
    try {
      const confirmed = await this.api.completeProposal(this.vaultId, id, outcome);
      if (confirmed.status !== outcome.status) throw new Error("Invalid completion response");
      return { status: confirmed.status, completionPending: false };
    } catch { return { status: outcome.status, completionPending: true }; }
  }
  private async apply(reviewed: ProposalDetail): Promise<ApplyResult> {
    if (!validProposalDetail(reviewed) || !validProposalPath(reviewed.path, this.vault.configDir)) throw new Error("Invalid proposal");
    const receipt = this.receipts.get(reviewed.proposalId);
    if (receipt) return this.finish(reviewed.proposalId, receipt);
    if (reviewed.status !== "PENDING") throw new Error("Proposal is not pending");
    const began = this.clock();
    const claim = await this.api.claimProposal(this.vaultId, reviewed.proposalId);
    const proposal = claim.proposal;
    if (!validProposalId(claim.claimId) || claim.leaseDurationMs !== CLAIM_LEASE_MS || !validProposalDetail(proposal) ||
        proposal.status !== "CLAIMED" || proposal.proposalId !== reviewed.proposalId ||
        ["operation", "path", "summary", "baseContent", "baseContentHash", "proposedContent", "proposedContentHash"].some(
          (field) => proposal[field as keyof ProposalDetail] !== reviewed[field as keyof ProposalDetail])) throw new Error("Invalid claim");
    const guard = (): void => {
      if (this.clock() >= began + claim.leaseDurationMs - 1000) throw new ProposalLeaseExpired();
      if (!validProposalPath(proposal.path, this.vault.configDir)) throw new ProposalConflict();
    };
    const check = (current: string): void => {
      guard();
      if (stableHash(current) !== proposal.baseContentHash || current !== proposal.baseContent) throw new ProposalConflict();
    };
    let outcome: ProposalCompletion;
    try {
      guard();
      if (proposal.operation === "CREATE_NOTE") {
        await this.vault.create(proposal.path, proposal.proposedContent!, guard);
      } else if (proposal.operation === "UPDATE_NOTE") {
        await this.vault.update(proposal.path, (current) => { check(current); return proposal.proposedContent!; });
      } else {
        await this.vault.remove(proposal.path, check);
      }
      const resulting = await this.vault.read(proposal.path);
      const verified = proposal.operation === "DELETE_NOTE" ? resulting === null : resulting !== null &&
        stableHash(resulting) === proposal.proposedContentHash && resulting === proposal.proposedContent;
      outcome = verified ? { claimId: claim.claimId, status: "APPLIED" } : { claimId: claim.claimId, status: "FAILED", statusCode: "VERIFY_FAILED" };
    } catch (error) {
      outcome = error instanceof ProposalConflict ? { claimId: claim.claimId, status: "CONFLICT", statusCode: "PRECONDITION_FAILED" } :
        { claimId: claim.claimId, status: "FAILED", statusCode: error instanceof ProposalLeaseExpired ? "LEASE_EXPIRED" : "VAULT_WRITE_FAILED" };
    }
    return this.finish(proposal.proposalId, outcome);
  }
}
