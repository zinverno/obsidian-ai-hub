import { Modal } from "obsidian";
import type { App } from "obsidian";
import { validProposalDetail } from "../companion/src/proposals/types";
import type { ProposalDetail } from "../companion/src/proposals/types";
import { ProposalApplication } from "./application";
import { proposalDiff } from "./diff";

export class ProposalReviewModal extends Modal {
  private busy = false;
  private openEpoch = 0;
  constructor(app: App, private readonly application: ProposalApplication) { super(app); }
  onOpen(): void {
    this.openEpoch++;
    this.titleEl.setText("Pending AI changes");
    void this.list();
  }
  onClose(): void { this.openEpoch++; this.contentEl.empty(); }
  private button(parent: HTMLElement, text: string, action: () => void): HTMLButtonElement {
    const button = parent.createEl("button", { text, attr: { type: "button" } });
    button.addEventListener("click", action); return button;
  }
  private async list(cursor = ""): Promise<void> {
    const epoch = this.openEpoch;
    this.contentEl.empty(); this.contentEl.createEl("p", { text: "Loading proposals…" });
    try {
      const page = await this.application.api.listProposals(this.application.vaultId, cursor);
      if (epoch !== this.openEpoch) return;
      this.contentEl.empty();
      this.contentEl.createEl("p", { text: `${page.proposals.length} pending or claimed proposals on this page. Changes require an explicit approval click.` });
      for (const proposal of page.proposals) {
        const row = this.contentEl.createDiv({ cls: "ai-proposal-row" });
        row.createEl("strong", { text: `${proposal.operation}: ${proposal.path}` });
        row.createEl("p", { text: proposal.summary });
        row.createEl("small", { text: `${proposal.status} · ${new Date(proposal.createdAt).toLocaleString()}` });
        this.button(row, "Review", () => { void this.details(proposal.proposalId); });
      }
      if (page.nextCursor) this.button(this.contentEl, "Next page", () => { void this.list(page.nextCursor!); });
      this.button(this.contentEl, "Refresh", () => { void this.list(); });
    } catch { if (epoch === this.openEpoch) this.error("Companion is unavailable or rejected the request. No Vault changes were made."); }
    if (epoch === this.openEpoch) this.button(this.contentEl, "Close", () => this.close());
  }
  private error(message: string): void { this.contentEl.createEl("p", { text: message, cls: "ai-proposal-error" }); }
  private async details(id: string): Promise<void> {
    if (this.busy) return;
    const epoch = this.openEpoch;
    try {
      const proposal = await this.application.api.getProposal(this.application.vaultId, id);
      if (!validProposalDetail(proposal)) throw new Error("Invalid proposal");
      const current = await this.application.vault.read(proposal.path);
      if (epoch !== this.openEpoch) return;
      this.render(proposal, current);
    } catch { if (epoch === this.openEpoch) this.error("Could not load the proposal and current note safely. No changes were made."); }
  }
  private render(proposal: ProposalDetail, current: string | null): void {
    this.contentEl.empty();
    this.contentEl.createEl("h3", { text: `${proposal.operation}: ${proposal.path}` });
    this.contentEl.createEl("p", { text: proposal.summary });
    this.contentEl.createEl("p", { text: `${proposal.status} · ${new Date(proposal.createdAt).toLocaleString()}` });
    this.contentEl.createEl("p", { text: "Review untrusted Markdown as text. Approve applies one change in Obsidian; normal autosync follows separately." });
    if (current !== proposal.baseContent) this.error("The current note differs from the proposal base. Approval will check again and report a conflict without overwriting it.");
    const before = proposal.operation === "CREATE_NOTE" ? "" : current ?? "";
    const after = proposal.operation === "DELETE_NOTE" ? "" : proposal.proposedContent!;
    const lines = proposalDiff(before, after);
    const preview = this.contentEl.createDiv({ cls: "ai-proposal-diff" });
    const pageSize = 200; let offset = 0;
    const show = (): void => {
      preview.empty();
      for (const line of lines.slice(offset, offset + pageSize)) {
        const prefix = line.kind === "added" ? "+ " : line.kind === "removed" ? "− " : "  ";
        preview.createEl("pre", { text: prefix + line.text, cls: `ai-proposal-${line.kind}` });
      }
      preview.createEl("small", { text: `Lines ${offset + 1}–${Math.min(offset + pageSize, lines.length)} of ${lines.length}. Line endings are preserved.` });
      if (offset) this.button(preview, "Previous lines", () => { offset = Math.max(0, offset - pageSize); show(); });
      if (offset + pageSize < lines.length) this.button(preview, "More lines", () => { offset += pageSize; show(); });
    };
    show();
    const approve = this.button(this.contentEl, "Approve", () => { void act(true); });
    const reject = this.button(this.contentEl, "Reject", () => { void act(false); });
    approve.disabled = reject.disabled = proposal.status !== "PENDING";
    const act = async (approved: boolean): Promise<void> => {
      if (this.busy || proposal.status !== "PENDING") return;
      this.busy = true; approve.disabled = reject.disabled = true;
      try {
        if (approved) {
          const result = await this.application.approve(proposal);
          this.error(result.completionPending ? `${result.status}: Vault outcome recorded locally, but Companion acknowledgement is pending. Do not repeat the write; reopen review to inspect state.` : result.status);
        } else {
          const result = await this.application.reject(proposal.proposalId); this.error(result.status);
        }
      } catch { this.error("Approval or rejection could not be confirmed. Refresh to inspect the current state; no speculative write was attempted."); }
      finally { this.busy = false; }
    };
    this.button(this.contentEl, "Back to proposals", () => { if (!this.busy) void this.list(); });
    this.button(this.contentEl, "Close", () => this.close());
  }
}
