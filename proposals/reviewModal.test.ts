import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { stableHash } from "../chunking/hash";
import type { ProposalDetail } from "../companion/src/proposals/types";

const mocks = vi.hoisted(() => {
  class Element {
    children: Element[] = []; text = ""; cls = ""; tag = "div"; disabled = false;
    listeners: Array<() => void> = [];
    private create(tag: string, opts: { text?: string; cls?: string } = {}): Element {
      const child = new Element(); child.tag = tag; child.text = opts.text ?? ""; child.cls = opts.cls ?? ""; this.children.push(child); return child;
    }
    createEl(tag: string, opts: { text?: string; cls?: string } = {}): Element { return this.create(tag, opts); }
    createDiv(opts: { cls?: string } = {}): Element { return this.create("div", opts); }
    empty(): void { this.children = []; this.text = ""; }
    setText(text: string): void { this.text = text; }
    addEventListener(_type: string, listener: () => void): void { this.listeners.push(listener); }
    click(): void { for (const fn of this.listeners) fn(); } // Deliberately dispatch even when disabled to test handler guard.
    all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())]; }
    button(text: string): Element { return this.all().find((child) => child.tag === "button" && child.text === text)!; }
    texts(): string { return this.all().map((child) => child.text).join("\n"); }
  }
  class Modal {
    contentEl = new Element(); titleEl = new Element();
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
    listProposals: vi.fn(async () => ({ proposals: [proposal], nextCursor: null })), getProposal: vi.fn(async () => proposal),
  }, approve: vi.fn(async () => ({ status: "APPLIED", completionPending: false })), reject: vi.fn(async () => ({ ...proposal, status: "REJECTED" })) };
  const modal = new ProposalReviewModal({} as never, app as unknown as ProposalApplication);
  const content = modal.contentEl as unknown as InstanceType<typeof mocks.Element>;
  return { app, modal, content, proposal };
}

describe("proposal review UI", () => {
  it("shows pending state and inert diff without approving on open, fetch, or review", async () => {
    const f = fixture(); f.modal.open(); await flush();
    expect(f.content.texts()).toContain("1 pending"); expect(f.content.texts()).toContain("UPDATE_NOTE: A.md"); expect(f.content.texts()).toContain("PENDING");
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
  });
  it("Reject requires a click and never calls approval", async () => {
    const f = fixture(); f.modal.open(); await flush(); f.content.button("Review").click(); await flush();
    f.content.button("Reject").click(); await flush(); expect(f.app.reject).toHaveBeenCalledExactlyOnceWith(f.proposal.proposalId);
    expect(f.app.approve).not.toHaveBeenCalled(); expect(f.content.texts()).toContain("REJECTED");
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
  it("never renders untrusted Markdown through HTML or Markdown execution APIs", () => {
    const source = readFileSync(new URL("./reviewModal.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|MarkdownRenderer|eval\(/u);
  });
});
