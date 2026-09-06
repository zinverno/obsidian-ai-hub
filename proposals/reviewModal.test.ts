import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { stableHash } from "../chunking/hash";
import type { ProposalDetail, ProposalPage } from "../companion/src/proposals/types";

const mocks = vi.hoisted(() => {
  class Element {
    children: Element[] = []; text = ""; cls = ""; tag = "div"; disabled = false;
    listeners: Array<() => void> = []; parent: Element | null = null;
    attributes: Record<string, string> = {}; scrollTop = 0;
    private create(tag: string, opts: { text?: string; cls?: string; attr?: Record<string, string> } = {}): Element {
      const child = new Element(); child.tag = tag; child.text = opts.text ?? ""; child.cls = opts.cls ?? ""; child.attributes = opts.attr ?? {}; child.parent = this; this.children.push(child); return child;
    }
    createEl(tag: string, opts: { text?: string; cls?: string; attr?: Record<string, string> } = {}): Element { return this.create(tag, opts); }
    createSpan(opts: { text?: string; cls?: string; attr?: Record<string, string> } = {}): Element { return this.create("span", opts); }
    addClass(cls: string): void { this.cls += ` ${cls}`; }
    remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
    createDiv(opts: { cls?: string; attr?: Record<string, string> } = {}): Element { return this.create("div", opts); }
    empty(): void { this.children = []; this.text = ""; }
    setText(text: string): void { this.text = text; }
    addEventListener(_type: string, listener: () => void): void { this.listeners.push(listener); }
    click(): void { for (const fn of this.listeners) fn(); } // Deliberately dispatch even when disabled to test handler guard.
    all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())]; }
    button(text: string): Element { return this.all().find((child) => child.tag === "button" && child.text === text)!; }
    texts(): string { return this.all().map((child) => child.text).join("\n"); }
  }
  class Modal {
    modalEl = new Element(); contentEl = new Element(); titleEl = new Element();
    onOpen(): void {} onClose(): void {}
    open(): void { this.onOpen(); } close(): void { this.onClose(); }
  }
  return { Element, Modal };
});
vi.mock("obsidian", () => ({ Modal: mocks.Modal }));
import { ProposalReviewModal } from "./reviewModal";
import type { ProposalApplication } from "./application";

async function flush(): Promise<void> { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function fixture() {
  const base = "same\nold\ntail", next = "same\n<script>alert(1)</script>\ntail";
  const proposal: ProposalDetail = { proposalId: "11111111-1111-4111-8111-111111111111", operation: "UPDATE_NOTE", path: "A.md", summary: "<img onerror=evil>",
    status: "PENDING", createdAt: 1, updatedAt: 1, claimedAt: null, claimExpiresAt: null, appliedAt: null, statusCode: null,
    baseContent: base, baseContentHash: stableHash(base), proposedContent: next, proposedContentHash: stableHash(next) };
  const app = { vaultId: "vault", vault: { read: vi.fn(async () => base) }, api: {
    listProposals: vi.fn<() => Promise<ProposalPage>>(async () => ({ proposals: [proposal].filter((p) => p.status === "PENDING" || p.status === "CLAIMED"), nextCursor: null })), getProposal: vi.fn(async () => proposal),
  }, approve: vi.fn(async () => { proposal.status = "APPLIED"; return { status: "APPLIED", completionPending: false }; }), reject: vi.fn(async () => { proposal.status = "REJECTED"; return { ...proposal, status: "REJECTED" }; }) };
  const modal = new ProposalReviewModal({} as never, app as unknown as ProposalApplication);
  const content = modal.contentEl as unknown as InstanceType<typeof mocks.Element>;
  return { app, modal, content, proposal };
}

describe("proposal review UI", () => {
  it("shows pending state and inert diff without approving on open, fetch, or review", async () => {
    const f = fixture(); f.modal.open(); await flush();
    expect(f.content.texts()).toContain("1 pending"); expect(f.content.texts()).toContain("A.md"); expect(f.content.texts()).not.toContain("UPDATE_NOTE:"); expect(f.content.texts()).toContain("PENDING");
    f.content.button("Review").click(); await flush();
    expect(f.content.texts()).toContain("+ <script>alert(1)</script>"); expect(f.content.texts()).toContain("− old"); expect(f.content.texts()).toContain("  same");
    expect(f.content.all().some((e) => e.tag === "script" || e.tag === "img")).toBe(false);
    expect(f.app.approve).not.toHaveBeenCalled(); expect(f.app.reject).not.toHaveBeenCalled();
  });
  it("Approve requires an explicit click and double clicks start only one application", async () => {
    const f = fixture(); f.modal.open(); await flush(); f.content.button("Review").click(); await flush();
    const button = f.content.button("Approve"); button.click(); button.click();
    expect(button.disabled).toBe(true); await flush();
    expect(f.app.approve).toHaveBeenCalledExactlyOnceWith(f.proposal); expect(f.content.texts()).toContain("APPLIED"); expect(f.app.reject).not.toHaveBeenCalled();
    expect(f.app.api.listProposals).toHaveBeenCalledTimes(2); expect(f.content.texts()).toContain("Change applied to Vault.");
    expect(f.content.button("Approve")).toBeUndefined(); expect(f.content.texts()).toContain("No pending AI changes");
    expect(f.content.all().some((e) => e.cls.includes("ai-proposal-message-success"))).toBe(true);
  });
  it("Reject requires a click and never calls approval", async () => {
    const f = fixture(); f.modal.open(); await flush(); f.content.button("Review").click(); await flush();
    f.content.button("Reject").click(); await flush(); expect(f.app.reject).toHaveBeenCalledExactlyOnceWith(f.proposal.proposalId);
    expect(f.app.approve).not.toHaveBeenCalled(); expect(f.content.texts()).toContain("REJECTED");
    expect(f.content.texts()).toContain("Proposal rejected. Vault unchanged."); expect(f.app.api.listProposals).toHaveBeenCalledTimes(2);
    expect(f.content.all().some((e) => e.cls.includes("ai-proposal-message-error"))).toBe(false);
  });
  it("remote Companion failures show fixed safe errors and do not apply", async () => {
    const f = fixture(); f.app.api.listProposals.mockRejectedValue(new Error("private token")); f.modal.open(); await flush();
    expect(f.content.texts()).toContain("Companion is unavailable"); expect(f.content.texts()).not.toContain("private token"); expect(f.app.approve).not.toHaveBeenCalled();
  });
  it("outage during approval leaves the safe error and disabled controls", async () => {
    const f = fixture(); f.app.approve.mockRejectedValue(new Error("private token")); f.modal.open(); await flush(); f.content.button("Review").click(); await flush();
    f.content.button("Approve").click(); await flush(); expect(f.content.texts()).toContain("could not be confirmed"); expect(f.content.texts()).not.toContain("private token");
    expect(f.content.button("Approve").disabled).toBe(true);
  });
  it("closed UI discards late responses and terminal proposals disable approval", async () => {
    const f = fixture(); f.modal.open(); f.modal.close(); await flush(); expect(f.content.children).toEqual([]);
    f.proposal.status = "CLAIMED"; f.modal.open(); await flush(); f.content.button("Review").click(); await flush();
    expect(f.content.button("Approve").disabled).toBe(true); f.content.button("Approve").click(); expect(f.app.approve).not.toHaveBeenCalled();
  });
  it.each([['CREATE_NOTE', 'CREATE'], ['UPDATE_NOTE', 'UPDATE'], ['DELETE_NOTE', 'DELETE']] as const)("shows separate %s operation and status badges", async (operation, label) => {
    const f = fixture(); f.proposal.operation = operation; f.modal.open(); await flush();
    expect(f.content.all().find((e) => e.cls.includes("ai-proposal-operation"))?.text).toBe(label);
    expect(f.content.all().find((e) => e.cls.includes("ai-proposal-status-pending"))?.text).toBe("PENDING");
    expect(f.content.all().find((e) => e.tag === "time")).toBeDefined();
    expect(f.content.all().find((e) => e.tag === "article")).toBeDefined();
  });
  it("keeps long paths and summaries in separate wrapping elements with responsive shell classes", async () => {
    const f = fixture(); f.proposal.path = "long-folder/".repeat(30) + "note.md"; f.proposal.summary = "Long summary ".repeat(100);
    f.modal.open(); await flush(); f.content.button("Review").click(); await flush();
    const path = f.content.all().find((e) => e.cls === "ai-proposal-path");
    expect(path?.tag).toBe("code"); expect(path?.text).toBe(f.proposal.path);
    expect(f.content.all().find((e) => e.cls === "ai-proposal-summary")?.text).toBe(f.proposal.summary);
    expect((f.modal.modalEl as unknown as InstanceType<typeof mocks.Element>).cls).toContain("ai-proposal-shell");
    expect(f.content.cls).toContain("ai-proposal-content"); expect(f.content.all().some((e) => e.cls === "ai-proposal-footer")).toBe(true);
    expect(f.content.button("Approve").cls).toContain("mod-cta"); expect(f.content.button("Reject").cls).toContain("mod-warning");
    expect(f.modal.titleEl.textContent ?? (f.modal.titleEl as unknown as InstanceType<typeof mocks.Element>).text).toBe("Pending AI change");
  });
  it("empty state retains Refresh and Close", async () => {
    const f = fixture(); f.app.api.listProposals.mockResolvedValue({ proposals: [], nextCursor: null }); f.modal.open(); await flush();
    expect(f.content.texts()).toContain("No pending AI changes"); expect(f.content.texts()).toContain("Changes proposed through MCP will appear here for review.");
    expect(f.content.button("Refresh")).toBeDefined(); expect(f.content.button("Close")).toBeDefined(); expect(f.content.button("Review")).toBeUndefined();
  });
  it("changed current content has a dedicated warning and still requires explicit approval", async () => {
    const f = fixture(); f.app.vault.read.mockResolvedValue("manual edit"); f.modal.open(); await flush(); f.content.button("Review").click(); await flush();
    expect(f.content.texts()).toContain("Current note has changed"); expect(f.content.texts()).toContain("will not overwrite newer content");
    expect(f.content.all().some((e) => e.cls.includes("ai-proposal-message-warning") && e.attributes.role === "status")).toBe(true);
    expect(f.content.all().some((e) => e.cls.includes("ai-proposal-message-error"))).toBe(false); expect(f.app.approve).not.toHaveBeenCalled();
  });
  it.each([['CONFLICT', 'warning', 'No write was made.'], ['FAILED', 'error', 'No automatic retry was made.']] as const)("presents %s semantically and refreshes the list", async (status, tone, message) => {
    const f = fixture(); f.app.approve.mockImplementation(async () => { f.proposal.status = status; return { status, completionPending: false }; });
    f.modal.open(); await flush(); f.content.button("Review").click(); await flush(); f.content.button("Approve").click(); await flush();
    expect(f.content.texts()).toContain(status); expect(f.content.texts()).toContain(message);
    expect(f.content.all().some((e) => e.cls.includes(`ai-proposal-message-${tone}`))).toBe(true);
    expect(f.app.api.listProposals).toHaveBeenCalledTimes(2); expect(f.content.button("Approve")).toBeUndefined(); expect(f.app.approve).toHaveBeenCalledOnce();
  });
  it("completionPending removes stale PENDING controls without suggesting another write", async () => {
    const f = fixture(); f.app.approve.mockResolvedValue({ status: "APPLIED", completionPending: true });
    f.modal.open(); await flush(); f.content.button("Review").click(); await flush(); f.content.button("Approve").click(); await flush();
    expect(f.content.texts()).toContain("Awaiting Companion confirmation"); expect(f.content.texts()).toContain("Local outcome: APPLIED");
    expect(f.content.texts()).toContain("Do not repeat the change"); expect(f.content.texts()).not.toContain("PENDING");
    expect(f.content.button("Approve")).toBeUndefined(); expect(f.content.button("Reject")).toBeUndefined();
    expect(f.content.button("Back to proposals")).toBeDefined(); expect(f.app.approve).toHaveBeenCalledOnce(); expect(f.app.api.listProposals).toHaveBeenCalledOnce();
  });
  it("confirmed APPLIED survives a failed list refresh without claiming no write occurred", async () => {
    const f = fixture(); f.modal.open(); await flush(); f.content.button("Review").click(); await flush();
    f.app.api.listProposals.mockRejectedValue(new Error("private failure")); f.content.button("Approve").click(); await flush();
    expect(f.content.texts()).toContain("Change applied to Vault."); expect(f.content.texts()).toContain("list could not be refreshed");
    expect(f.content.texts()).not.toContain("No Vault changes were made"); expect(f.content.texts()).not.toContain("private failure");
    expect(f.app.approve).toHaveBeenCalledOnce();
  });
  it("retains the 200-line diff bound, signs and original/proposed line numbers across pages", async () => {
    const f = fixture(); f.proposal.proposedContent = Array.from({ length: 450 }, (_, i) => `new ${i}`).join("\n"); f.proposal.proposedContentHash = stableHash(f.proposal.proposedContent);
    f.modal.open(); await flush(); f.content.button("Review").click(); await flush();
    const rows = (): InstanceType<typeof mocks.Element>[] => f.content.all().filter((e) => e.cls.startsWith("ai-proposal-diff-line "));
    expect(rows()).toHaveLength(200); expect(f.content.texts()).toContain("− same"); expect(f.content.texts()).toContain("+ new 0");
    expect(rows()[0].children[0].children.map((e) => e.text)).toEqual(["1", ""]);
    f.content.button("More lines").click(); expect(rows()).toHaveLength(200); expect(f.content.texts()).toContain("Lines 201–400");
    f.content.button("Previous lines").click(); expect(f.content.texts()).toContain("Lines 1–200");
    expect(f.app.approve).not.toHaveBeenCalled();
  });
  it("a late detail fetch cannot replace the list after Back", async () => {
    const f = fixture(); let resolve: (proposal: ProposalDetail) => void = () => {};
    f.app.api.getProposal.mockImplementation(() => new Promise((done) => { resolve = done; }));
    f.modal.open(); await flush(); f.content.button("Review").click(); f.content.button("Back to proposals").click(); await flush();
    resolve(f.proposal); await flush(); expect(f.content.button("Review")).toBeDefined(); expect(f.content.button("Approve")).toBeUndefined();
  });
  it("never renders untrusted Markdown through HTML or Markdown execution APIs", () => {
    const source = readFileSync(new URL("./reviewModal.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|MarkdownRenderer|eval\(/u);
  });
});
