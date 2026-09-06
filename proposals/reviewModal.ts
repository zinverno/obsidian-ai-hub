import { Modal } from "obsidian";
import type { App } from "obsidian";
import { validProposalDetail } from "../companion/src/proposals/types";
import type { ProposalDetail, ProposalSummary } from "../companion/src/proposals/types";
import { ProposalApplication } from "./application";
import { proposalDiff } from "./diff";

interface ReviewResult { status: string; completionPending: boolean }
type MessageTone = "success" | "warning" | "error" | "info";
const EMPTY_STATE = { title: "No pending AI changes", description: "Changes proposed through MCP will appear here for review." };
const OPERATIONS = { CREATE_NOTE: "CREATE", UPDATE_NOTE: "UPDATE", DELETE_NOTE: "DELETE" };
const RESULTS: Record<string, { tone: MessageTone; text: string }> = {
  APPLIED: { tone: "success", text: "Change applied to Vault. Companion sync will follow normally." },
  REJECTED: { tone: "info", text: "Proposal rejected. Vault unchanged." },
  CONFLICT: { tone: "warning", text: "The note changed or the target no longer matches this proposal. No write was made." },
  FAILED: { tone: "error", text: "The change could not be confirmed as applied. No automatic retry was made." },
};

export class ProposalReviewModal extends Modal {
  private busy = false;
  private openEpoch = 0;
  constructor(app: App, private readonly application: ProposalApplication) { super(app); }
  onOpen(): void {
    this.modalEl.addClass("ai-proposal-shell");
    this.contentEl.addClass("ai-proposal-content");
    void this.list();
  }
  onClose(): void { this.openEpoch++; this.contentEl.empty(); }

  private button(parent: HTMLElement, text: string, action: () => void, cls = ""): HTMLButtonElement {
    const button = parent.createEl("button", { text, cls, attr: { type: "button" } });
    button.addEventListener("click", action); return button;
  }
  private layout(title: string): { body: HTMLElement; footer: HTMLElement } {
    this.titleEl.setText(title); this.contentEl.empty();
    return { body: this.contentEl.createDiv({ cls: "ai-proposal-body" }),
      footer: this.contentEl.createDiv({ cls: "ai-proposal-footer" }) };
  }
  private message(parent: HTMLElement, tone: MessageTone, title: string, text: string): void {
    const box = parent.createDiv({ cls: `ai-proposal-message ai-proposal-message-${tone}`, attr: {
      role: tone === "error" ? "alert" : "status", "aria-live": tone === "error" ? "assertive" : "polite",
    } });
    box.createEl("strong", { text: title });
    box.createEl("p", { text });
  }
  private result(parent: HTMLElement, result: ReviewResult): void {
    if (result.completionPending) {
      this.message(parent, "warning", "Awaiting Companion confirmation",
        `Local outcome: ${result.status}. Companion has not confirmed this outcome. Do not repeat the change. Return to the list to inspect its state.`);
      return;
    }
    const presentation = RESULTS[result.status];
    this.message(parent, presentation?.tone ?? "info", result.status,
      presentation?.text ?? "Proposal status updated. Refresh the list to inspect the current state.");
  }
  private metadata(parent: HTMLElement, proposal: ProposalSummary, status: string = proposal.status): void {
    const metadata = parent.createDiv({ cls: "ai-proposal-metadata" });
    metadata.createSpan({ text: OPERATIONS[proposal.operation], cls: "ai-proposal-badge ai-proposal-operation",
      attr: { "aria-label": `Operation: ${OPERATIONS[proposal.operation]}` } });
    metadata.createSpan({ text: status, cls: `ai-proposal-badge ai-proposal-status ai-proposal-status-${proposal.status.toLowerCase()}`,
      attr: { "aria-label": `Status: ${status}` } });
    metadata.createEl("time", { text: new Date(proposal.createdAt).toLocaleString(), cls: "ai-proposal-created" });
    parent.createEl("code", { text: proposal.path, cls: "ai-proposal-path" });
    if (proposal.summary) parent.createEl("p", { text: proposal.summary, cls: "ai-proposal-summary" });
  }
  private async list(cursor = "", result?: ReviewResult): Promise<void> {
    const epoch = ++this.openEpoch;
    const { body, footer } = this.layout("Pending AI changes");
    if (result) this.result(body, result);
    const loading = body.createEl("p", { text: "Loading proposals…", cls: "ai-proposal-description" });
    this.button(footer, "Refresh", () => { if (!this.busy) void this.list(); });
    this.button(footer, "Close", () => this.close(), "ai-proposal-quiet");
    try {
      const page = await this.application.api.listProposals(this.application.vaultId, cursor);
      if (epoch !== this.openEpoch) return;
      loading.remove();
      if (!page.proposals.length) {
        const empty = body.createDiv({ cls: "ai-proposal-empty" });
        empty.createEl("h3", { text: EMPTY_STATE.title });
        empty.createEl("p", { text: EMPTY_STATE.description });
      } else {
        body.createEl("p", { text: `${page.proposals.length} pending or claimed proposals on this page. Review each change before approving it.`, cls: "ai-proposal-description" });
        const cards = body.createDiv({ cls: "ai-proposal-cards" });
        for (const proposal of page.proposals) {
          const card = cards.createEl("article", { cls: "ai-proposal-card" });
          this.metadata(card, proposal);
          const actions = card.createDiv({ cls: "ai-proposal-card-actions" });
          this.button(actions, "Review", () => { void this.details(proposal.proposalId); });
        }
      }
      if (page.nextCursor) this.button(footer, "Next page", () => { if (!this.busy) void this.list(page.nextCursor!); });
    } catch {
      if (epoch === this.openEpoch) {
        loading.remove();
        this.message(body, "error", "Companion unavailable", result ?
          "The outcome above is recorded, but the proposal list could not be refreshed. Use Refresh to check the current list." :
          "Companion is unavailable or rejected the request. No Vault changes were made.");
      }
    }
  }
  private async details(id: string): Promise<void> {
    if (this.busy) return;
    const epoch = ++this.openEpoch;
    const { body, footer } = this.layout("Pending AI change");
    const loading = body.createEl("p", { text: "Loading change…", cls: "ai-proposal-description" });
    this.button(footer, "Back to proposals", () => { void this.list(); });
    this.button(footer, "Close", () => this.close(), "ai-proposal-quiet");
    try {
      const proposal = await this.application.api.getProposal(this.application.vaultId, id);
      if (!validProposalDetail(proposal)) throw new Error("Invalid proposal");
      const current = await this.application.vault.read(proposal.path);
      if (epoch !== this.openEpoch) return;
      this.render(proposal, current);
    } catch {
      if (epoch === this.openEpoch) {
        loading.remove(); this.message(body, "error", "Could not load change", "Could not load the proposal and current note safely. No changes were made.");
      }
    }
  }
  private render(proposal: ProposalDetail, current: string | null): void {
    const { body, footer } = this.layout("Pending AI change");
    body.addClass("ai-proposal-detail-body");
    const header = body.createDiv({ cls: "ai-proposal-detail-header", attr: { tabindex: "0", role: "region", "aria-label": "Proposal details" } });
    this.metadata(header, proposal);
    if (current !== proposal.baseContent) this.message(body, "warning", "Current note has changed",
      "This proposal was created against a different version of the note or target. Approval will re-check the note and will not overwrite newer content.");
    body.createEl("p", { text: "Review the Markdown below as text. Approve applies this change in Obsidian; normal autosync follows separately.", cls: "ai-proposal-description" });
    const before = proposal.operation === "CREATE_NOTE" ? "" : current ?? "";
    const after = proposal.operation === "DELETE_NOTE" ? "" : proposal.proposedContent!;
    let oldLine = 0, newLine = 0;
    const lines = proposalDiff(before, after).map((line) => ({ ...line,
      oldLine: line.kind === "added" ? "" : String(++oldLine), newLine: line.kind === "removed" ? "" : String(++newLine) }));
    const panel = body.createDiv({ cls: "ai-proposal-diff-panel" });
    const legend = panel.createDiv({ cls: "ai-proposal-diff-legend" });
    legend.createSpan({ text: "Changes", cls: "ai-proposal-diff-title" });
    legend.createSpan({ text: "+ added · − removed · unchanged context" });
    const preview = panel.createDiv({ cls: "ai-proposal-diff", attr: { tabindex: "0", role: "region", "aria-label": "Markdown changes; original and proposed line numbers" } });
    const pagination = panel.createDiv({ cls: "ai-proposal-pagination" });
    const pageSize = 200; let offset = 0;
    const show = (): void => {
      preview.empty(); pagination.empty();
      for (const line of lines.slice(offset, offset + pageSize)) {
        const row = preview.createDiv({ cls: `ai-proposal-diff-line ai-proposal-${line.kind}` });
        const numbers = row.createSpan({ cls: "ai-proposal-line-numbers", attr: { "aria-hidden": "true" } });
        numbers.createSpan({ text: line.oldLine }); numbers.createSpan({ text: line.newLine });
        const prefix = line.kind === "added" ? "+ " : line.kind === "removed" ? "− " : "  ";
        row.createEl("pre", { text: prefix + line.text, cls: "ai-proposal-line-text" });
      }
      pagination.createEl("small", { text: `Lines ${offset + 1}–${Math.min(offset + pageSize, lines.length)} of ${lines.length}. Line endings are preserved.` });
      const navigation = pagination.createDiv({ cls: "ai-proposal-page-actions" });
      if (offset) this.button(navigation, "Previous lines", () => { offset = Math.max(0, offset - pageSize); show(); preview.scrollTop = 0; });
      if (offset + pageSize < lines.length) this.button(navigation, "More lines", () => { offset += pageSize; show(); preview.scrollTop = 0; });
    };
    show();
    const navigation = footer.createDiv({ cls: "ai-proposal-navigation" });
    this.button(navigation, "Back to proposals", () => { if (!this.busy) void this.list(); });
    this.button(navigation, "Close", () => this.close(), "ai-proposal-quiet");
    const decisions = footer.createDiv({ cls: "ai-proposal-decisions" });
    const reject = this.button(decisions, "Reject", () => { void act(false); }, "mod-warning ai-proposal-reject");
    const approve = this.button(decisions, "Approve", () => { void act(true); }, "mod-cta ai-proposal-approve");
    approve.disabled = reject.disabled = proposal.status !== "PENDING";
    const epoch = this.openEpoch;
    const act = async (approved: boolean): Promise<void> => {
      if (this.busy || proposal.status !== "PENDING") return;
      this.busy = true; approve.disabled = reject.disabled = true;
      try {
        const result: ReviewResult = approved ? await this.application.approve(proposal) :
          { status: (await this.application.reject(proposal.proposalId)).status, completionPending: false };
        if (epoch !== this.openEpoch) return;
        if (result.completionPending) {
          const completed = this.layout("Change outcome");
          this.metadata(completed.body, proposal, "Awaiting confirmation"); this.result(completed.body, result);
          this.button(completed.footer, "Back to proposals", () => { void this.list(); });
          this.button(completed.footer, "Close", () => this.close(), "ai-proposal-quiet");
        } else { await this.list("", result); }
      } catch {
        if (epoch === this.openEpoch) this.message(body, "error", "Action not confirmed",
          "Approval or rejection could not be confirmed. Return to the list to inspect the current state; no speculative write was attempted.");
      } finally { this.busy = false; }
    };
  }
}
