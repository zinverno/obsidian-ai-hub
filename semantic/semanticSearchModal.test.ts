import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class FakeElement {
    readonly children: FakeElement[] = [];
    readonly listeners = new Map<string, Array<(event: any) => void>>();
    tag = "div";
    cls = "";
    text = "";
    value = "";
    disabled = false;
    focused = false;
    attributes = new Map<string, string>();

    createDiv(options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
      return this.create("div", options);
    }

    createSpan(options: { cls?: string; text?: string } = {}) {
      return this.create("span", options);
    }

    createEl(
      tag: string,
      options: {
        cls?: string;
        text?: string;
        type?: string;
        attr?: Record<string, string>;
      } = {},
    ) {
      return this.create(tag, options);
    }

    private create(
      tag: string,
      options: {
        cls?: string;
        text?: string;
        type?: string;
        attr?: Record<string, string>;
      },
    ) {
      const child = new FakeElement();
      child.tag = tag;
      child.cls = options.cls ?? "";
      child.text = options.text ?? "";
      if (options.type) child.attributes.set("type", options.type);
      for (const [key, value] of Object.entries(options.attr ?? {})) {
        child.attributes.set(key, value);
      }
      this.children.push(child);
      return child;
    }

    addClass(value: string) {
      this.cls = `${this.cls} ${value}`.trim();
    }

    empty() {
      this.children.length = 0;
      this.text = "";
    }

    setText(value: string) {
      this.text = value;
    }

    setAttribute(key: string, value: string) {
      this.attributes.set(key, value);
    }

    addEventListener(type: string, listener: (event: any) => void) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    trigger(type: string, event: any = {}) {
      for (const listener of this.listeners.get(type) ?? []) {
        listener({
          key: event.key,
          preventDefault: vi.fn(),
        });
      }
    }

    focus() {
      this.focused = true;
    }

    findByClass(value: string): FakeElement[] {
      const matches = this.cls.split(/\s+/).includes(value) ? [this] : [];
      return [
        ...matches,
        ...this.children.flatMap((child) => child.findByClass(value)),
      ];
    }

    findByTag(value: string): FakeElement[] {
      const matches = this.tag === value ? [this] : [];
      return [
        ...matches,
        ...this.children.flatMap((child) => child.findByTag(value)),
      ];
    }
  }

  class TFile {}
  class MarkdownView {
    editor = {
      setCursor: vi.fn(),
      scrollIntoView: vi.fn(),
      focus: vi.fn(),
    };
  }
  class Notice {
    static messages: string[] = [];
    constructor(message: string) {
      Notice.messages.push(message);
    }
  }
  class Modal {
    app: any;
    titleEl = new FakeElement();
    contentEl = new FakeElement();
    closed = false;
    constructor(app: any) {
      this.app = app;
    }
    open() {
      (this as any).onOpen();
    }
    close() {
      this.closed = true;
      (this as any).onClose();
    }
  }
  return { FakeElement, TFile, MarkdownView, Notice, Modal };
});

vi.mock("obsidian", () => ({
  App: class {},
  MarkdownView: mocks.MarkdownView,
  Modal: mocks.Modal,
  Notice: mocks.Notice,
  TFile: mocks.TFile,
  getLanguage: () => "ru",
}));

import {
  formatSemanticScore,
  SemanticSearchModal,
  semanticBasename,
  semanticBreadcrumb,
} from "./semanticSearchModal";
import type { SemanticDocumentResult } from "./types";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function result(preview?: string): SemanticDocumentResult {
  return {
    path: "Folder/Alpha.md",
    score: 0.8421,
    matches: [
      {
        id: "alpha:0",
        path: "Folder/Alpha.md",
        headingPath: ["Alpha", "Section"],
        ordinal: 0,
        preview,
        source: {
          startOffset: 0,
          endOffset: 1,
          startLine: 4,
          endLine: 4,
        },
        score: 0.8421,
      },
    ],
  };
}

function harness(results = [result("safe preview")]) {
  const file = Object.assign(Object.create(mocks.TFile.prototype), {
    path: "Folder/Alpha.md",
  });
  const view = new mocks.MarkdownView();
  const leaf = {
    view,
    openFile: vi.fn(async () => undefined),
  };
  const app = {
    vault: { getFileByPath: vi.fn(() => file) },
    workspace: { getLeaf: vi.fn(() => leaf) },
  };
  const delegate = {
    prepareSearch: vi.fn(async () => ({
      initialized: true,
      indexing: false,
      vectorCount: 1,
      vectorGeneration: 1,
      dimensions: 3,
      embeddingSpaceId: "space",
    })),
    search: vi.fn(async () => results),
    errorMessage: vi.fn((_error: unknown) => "safe error"),
  };
  const modal = new SemanticSearchModal(app as never, delegate);
  modal.open();
  const content = modal.contentEl as unknown as InstanceType<
    typeof mocks.FakeElement
  >;
  return { modal, content, delegate, app, leaf, view };
}

describe("SemanticSearchModal helpers and behavior", () => {
  it("formats scores, basenames, and breadcrumbs", () => {
    expect(formatSemanticScore(0.8421)).toBe("0.842");
    expect(semanticBasename("Folder/Alpha.md")).toBe("Alpha");
    expect(semanticBreadcrumb(["One", "", "Two"])).toBe("One › Two");
  });

  it("focuses the input and does not search an empty query", async () => {
    const { content, delegate } = harness();
    const input = content.findByTag("input")[0];
    expect(input.focused).toBe(true);
    content.findByTag("button")[0].trigger("click");
    await flush();
    expect(delegate.prepareSearch).not.toHaveBeenCalled();
    expect(content.findByClass("ai-semantic-search-status")[0].text).toBe(
      "Введите непустой запрос.",
    );
  });

  it("runs on Enter and renders preview as text", async () => {
    const { content, delegate } = harness();
    const input = content.findByTag("input")[0];
    input.value = "meaning";
    input.trigger("keydown", { key: "Enter" });
    await flush();
    expect(delegate.search).toHaveBeenCalledWith("meaning");
    expect(
      content.findByClass("ai-semantic-result-preview")[0].text,
    ).toBe("safe preview");
  });

  it("handles an empty preview without creating a preview element", async () => {
    const { content } = harness([result(undefined)]);
    const input = content.findByTag("input")[0];
    input.value = "meaning";
    content.findByTag("button")[0].trigger("click");
    await flush();
    expect(content.findByClass("ai-semantic-result-preview")).toEqual([]);
  });

  it("prevents parallel searches while busy", async () => {
    let release: () => void = () => {};
    const { content, delegate } = harness();
    delegate.prepareSearch.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              initialized: true,
              indexing: false,
              vectorCount: 1,
              vectorGeneration: 1,
              dimensions: 3,
              embeddingSpaceId: "space",
            });
        }),
    );
    const input = content.findByTag("input")[0];
    const button = content.findByTag("button")[0];
    input.value = "meaning";
    button.trigger("click");
    button.trigger("click");
    expect(delegate.prepareSearch).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);
    release();
    await flush();
  });

  it("shows the empty-index message without calling the query search", async () => {
    const { content, delegate } = harness();
    delegate.errorMessage.mockImplementation(
      (error) => (error as Error).message,
    );
    delegate.prepareSearch.mockResolvedValue({
      initialized: false,
      indexing: false,
      vectorCount: 0,
      vectorGeneration: 0,
      dimensions: 0,
      embeddingSpaceId: "",
    });
    const input = content.findByTag("input")[0];
    input.value = "must not be embedded";
    content.findByTag("button")[0].trigger("click");
    await flush();
    expect(delegate.prepareSearch).toHaveBeenCalledOnce();
    expect(delegate.search).not.toHaveBeenCalled();
    expect(content.findByClass("ai-semantic-search-status")[0].text).toBe(
      "Семантический индекс пуст. Сначала обновите индекс Vault.",
    );
  });

  it("ignores a stale response after close", async () => {
    let release: () => void = () => {};
    const { modal, content, delegate } = harness();
    delegate.search.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve([result("late")]);
        }),
    );
    const input = content.findByTag("input")[0];
    input.value = "meaning";
    content.findByTag("button")[0].trigger("click");
    await Promise.resolve();
    modal.close();
    release();
    await flush();
    expect(content.children).toEqual([]);
  });

  it("opens the exact file, moves the cursor, then closes", async () => {
    const { modal, content, leaf, view } = harness();
    const input = content.findByTag("input")[0];
    input.value = "meaning";
    content.findByTag("button")[0].trigger("click");
    await flush();
    content.findByClass("ai-semantic-result-card")[0].trigger("click");
    await flush();
    expect(leaf.openFile).toHaveBeenCalledOnce();
    expect(view.editor.setCursor).toHaveBeenCalledWith({ line: 4, ch: 0 });
    expect((modal as unknown as { closed: boolean }).closed).toBe(true);
  });

  it("keeps the modal open when the exact file is missing", async () => {
    mocks.Notice.messages = [];
    const { modal, content, app } = harness();
    app.vault.getFileByPath.mockReturnValue(null);
    const input = content.findByTag("input")[0];
    input.value = "meaning";
    content.findByTag("button")[0].trigger("click");
    await flush();
    content.findByClass("ai-semantic-result-card")[0].trigger("click");
    await flush();
    expect(mocks.Notice.messages).toContain(
      "Заметка больше не существует.",
    );
    expect((modal as unknown as { closed: boolean }).closed).toBe(false);
  });

  it("never assigns user strings through innerHTML", () => {
    const source = readFileSync(
      new URL("./semanticSearchModal.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("insertAdjacentHTML");
  });
});
