import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  interface FakeEvent {
    key?: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    preventDefault?: () => void;
  }

  class FakeElement {
    readonly children: FakeElement[] = [];
    readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();
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

    addClass(...values: string[]) {
      this.cls = [this.cls, ...values].filter(Boolean).join(" ");
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

    addEventListener(type: string, listener: (event: FakeEvent) => void) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    trigger(type: string, event: FakeEvent = {}) {
      for (const listener of this.listeners.get(type) ?? []) {
        listener({
          ...event,
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

  class TFile {
    path = "";
  }

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
    app: unknown;
    titleEl = new FakeElement();
    modalEl = new FakeElement();
    contentEl = new FakeElement();
    constructor(app: unknown) {
      this.app = app;
    }
    onOpen() {}
    onClose() {}
    open() {
      this.onOpen();
    }
    close() {
      this.onClose();
    }
  }

  return { FakeElement, MarkdownView, Modal, Notice, TFile };
});

vi.mock("obsidian", () => ({
  App: class {},
  MarkdownView: mocks.MarkdownView,
  Modal: mocks.Modal,
  Notice: mocks.Notice,
  TFile: mocks.TFile,
  getLanguage: () => "ru",
}));

import { AskVaultModal, openRagSource, sourceSnippet } from "./ragModal";
import type {
  RagAskCallbacks,
  RagAskResult,
  RagContext,
} from "./types";

function context(): RagContext {
  return {
    usedCodePoints: 20,
    sources: [
      {
        id: "S1",
        path: "Folder/Alpha.md",
        headingPath: ["Alpha", "Relevant"],
        chunkId: "alpha",
        contentHash: "hash-alpha",
        source: {
          startOffset: 4,
          endOffset: 24,
          startLine: 7,
          endLine: 9,
        },
        score: 0.9,
        text: "complete source text for the answer",
      },
    ],
  };
}

function result(answer = "Grounded [S1]"): RagAskResult {
  return {
    answer,
    context: context(),
    citedSourceIds: ["S1"],
    unknownCitationIds: [],
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function harness() {
  const file = new mocks.TFile();
  file.path = "Folder/Alpha.md";
  const view = new mocks.MarkdownView();
  const leaf = {
    view,
    openFile: vi.fn(async () => undefined),
  };
  const app = {
    vault: {
      getFileByPath: vi.fn<
        () => InstanceType<typeof mocks.TFile> | null
      >(() => file),
    },
    workspace: {
      getLeaf: vi.fn(() => leaf),
    },
  };
  const delegate = {
    askVault: vi.fn(async (
      _question: string,
      callbacks: RagAskCallbacks,
      _signal: AbortSignal,
    ) => {
      callbacks.onContext?.(context());
      callbacks.onToken?.("Grounded ");
      callbacks.onToken?.("[S1]");
      return result();
    }),
    errorMessage: vi.fn(() => "safe RAG error"),
  };
  const modal = new AskVaultModal(app as never, delegate);
  modal.open();
  const content = modal.contentEl as unknown as InstanceType<
    typeof mocks.FakeElement
  >;
  return { app, content, delegate, leaf, modal, view };
}

function cssRule(styles: string, selector: string): string {
  const marker = `${selector} {`;
  const start = styles.indexOf(marker);
  if (start < 0) {
    throw new Error(`Missing CSS rule: ${selector}`);
  }
  const end = styles.indexOf("}", start);
  if (end < 0) {
    throw new Error(`Unterminated CSS rule: ${selector}`);
  }
  return styles.slice(start, end + 1);
}

describe("AskVaultModal", () => {
  it("uses a bounded column hierarchy for compose and result states", () => {
    const { content, modal } = harness();
    const shell = modal.modalEl as unknown as InstanceType<
      typeof mocks.FakeElement
    >;
    const compose = content.findByClass("ai-rag-compose")[0];
    const results = content.findByClass("ai-rag-results")[0];

    expect(shell.findByClass("ai-rag-shell")).toHaveLength(1);
    expect(content.children).toEqual([compose, results]);
    expect(compose.findByClass("ai-rag-question")).toHaveLength(1);
    expect(compose.findByClass("ai-rag-actions")).toHaveLength(1);
    expect(compose.findByClass("ai-rag-status")).toHaveLength(1);
    expect(results.children.map((child) => child.cls)).toEqual([
      "ai-rag-answer",
      "ai-rag-sources",
    ]);
  });

  it("focuses the question and rejects an empty ask locally", async () => {
    const { content, delegate } = harness();
    const textarea = content.findByTag("textarea")[0];
    expect(textarea.focused).toBe(true);

    content.findByClass("mod-cta")[0].trigger("click");
    await flush();

    expect(delegate.askVault).not.toHaveBeenCalled();
    expect(content.findByClass("ai-rag-status")[0].text).toBe(
      "Введите непустой вопрос.",
    );
  });

  it("streams plain text and renders only trusted source objects", async () => {
    const { content } = harness();
    const textarea = content.findByTag("textarea")[0];
    textarea.value = "What is alpha?";
    content.findByClass("mod-cta")[0].trigger("click");
    await flush();

    expect(content.findByClass("ai-rag-answer")[0].text).toBe(
      "Grounded [S1]",
    );
    expect(content.findByClass("ai-rag-source")).toHaveLength(1);
    expect(content.findByClass("ai-rag-source-title")[0].text).toBe(
      "[S1] Folder/Alpha.md",
    );
    expect(content.findByClass("ai-rag-source-heading")[0].text).toBe(
      "Alpha › Relevant",
    );
  });

  it("renders many long trusted sources as sibling cards", async () => {
    const { content, delegate } = harness();
    const longPath = `Folder/${"unbroken-segment-".repeat(30)}/Note.md`;
    const sourceTemplate = context().sources[0];
    const manyContext: RagContext = {
      usedCodePoints: 10_000,
      sources: Array.from({ length: 30 }, (_, index) => ({
        ...sourceTemplate,
        id: `S${index + 1}`,
        path: `${longPath}-${index + 1}`,
        chunkId: `chunk-${index + 1}`,
        text: "x".repeat(500),
      })),
    };
    delegate.askVault.mockImplementation(async (
      _question,
      callbacks,
    ) => {
      callbacks.onContext?.(manyContext);
      callbacks.onToken?.("answer ".repeat(300));
      return {
        answer: "answer ".repeat(300),
        context: manyContext,
        citedSourceIds: manyContext.sources.map((source) => source.id),
        unknownCitationIds: [],
      };
    });

    const textarea = content.findByTag("textarea")[0];
    textarea.value = "question";
    content.findByClass("mod-cta")[0].trigger("click");
    await flush();

    const cards = content.findByClass("ai-rag-source");
    expect(cards).toHaveLength(30);
    expect(cards.every((card) => card.tag === "button")).toBe(true);
    expect(content.findByClass("ai-rag-source-title")[0].text).toBe(
      `[S1] ${longPath}-1`,
    );
    expect(Array.from(content.findByClass("ai-rag-source-snippet")[0].text))
      .toHaveLength(241);
  });

  it("does not create a fake source link from an unknown model citation", async () => {
    const { content, delegate } = harness();
    delegate.askVault.mockImplementation(async (
      _question,
      callbacks,
    ) => {
      callbacks.onContext?.(context());
      callbacks.onToken?.("Unknown [S999]");
      return result("Unknown [S999]");
    });
    const textarea = content.findByTag("textarea")[0];
    textarea.value = "question";
    content.findByClass("mod-cta")[0].trigger("click");
    await flush();

    expect(content.findByClass("ai-rag-answer")[0].text).toBe("Unknown [S999]");
    expect(content.findByClass("ai-rag-source")).toHaveLength(1);
    expect(content.findByClass("ai-rag-source-title")[0].text).not.toContain(
      "S999",
    );
  });

  it("prevents two concurrent generations from one modal", async () => {
    let release = () => {};
    const { content, delegate } = harness();
    delegate.askVault.mockImplementation(
      () => new Promise((resolve) => {
        release = () => resolve(result());
      }),
    );
    const textarea = content.findByTag("textarea")[0];
    textarea.value = "question";
    const ask = content.findByClass("mod-cta")[0];
    ask.trigger("click");
    ask.trigger("click");

    expect(delegate.askVault).toHaveBeenCalledOnce();
    expect(ask.disabled).toBe(true);
    release();
    await flush();
  });

  it("enables cancel only after retrieval materializes the context", async () => {
    let callbacks: RagAskCallbacks | undefined;
    let release = () => {};
    const { content, delegate } = harness();
    delegate.askVault.mockImplementation(
      (_question, nextCallbacks) =>
        new Promise((resolve) => {
          callbacks = nextCallbacks;
          release = () => resolve(result());
        }),
    );
    const textarea = content.findByTag("textarea")[0];
    const cancel = content.findByTag("button").find(
      (button) => button.text === "Отменить генерацию",
    );
    textarea.value = "question";
    content.findByClass("mod-cta")[0].trigger("click");

    expect(cancel?.disabled).toBe(true);
    callbacks?.onContext?.(context());
    expect(cancel?.disabled).toBe(false);

    release();
    await flush();
    expect(cancel?.disabled).toBe(true);
  });

  it("cancels active generation with the same AbortSignal", async () => {
    let observed: AbortSignal | undefined;
    const { content, delegate } = harness();
    delegate.askVault.mockImplementation(
      (_question, callbacks, signal) => {
        callbacks.onContext?.(context());
        return new Promise((_resolve, reject) => {
          observed = signal;
          signal.addEventListener("abort", () => {
            const error = new Error("cancelled");
            error.name = "AbortError";
            reject(error);
          });
        });
      },
    );
    const textarea = content.findByTag("textarea")[0];
    textarea.value = "question";
    content.findByClass("mod-cta")[0].trigger("click");
    const cancel = content.findByTag("button").find(
      (button) => button.text === "Отменить генерацию",
    );
    expect(cancel?.disabled).toBe(false);
    cancel?.trigger("click");
    await flush();

    expect(observed?.aborted).toBe(true);
    expect(content.findByClass("ai-rag-status")[0].text).toBe(
      "Генерация отменена.",
    );
  });

  it("closes during retrieval without starting generation or updating UI", async () => {
    let callbacks: RagAskCallbacks | undefined;
    let signal: AbortSignal | undefined;
    let finishRetrieval = () => {};
    const generation = vi.fn();
    const { content, delegate, modal } = harness();
    delegate.askVault.mockImplementation(
      async (_question, nextCallbacks, nextSignal) => {
        callbacks = nextCallbacks;
        signal = nextSignal;
        await new Promise<void>((resolve) => {
          finishRetrieval = resolve;
        });
        if (nextSignal.aborted) {
          const error = new Error("cancelled during retrieval");
          error.name = "AbortError";
          throw error;
        }
        nextCallbacks.onContext?.(context());
        generation();
        nextCallbacks.onToken?.("generated");
        return result();
      },
    );
    const textarea = content.findByTag("textarea")[0];
    textarea.value = "question";
    content.findByClass("mod-cta")[0].trigger("click");
    const cancel = content.findByTag("button").find(
      (button) => button.text === "Отменить генерацию",
    );

    expect(cancel?.disabled).toBe(true);
    modal.close();
    callbacks?.onToken?.("late secret");
    callbacks?.onContext?.(context());
    finishRetrieval();
    await flush();

    expect(signal?.aborted).toBe(true);
    expect(generation).not.toHaveBeenCalled();
    expect(content.children).toEqual([]);
    expect(content.text).not.toContain("late secret");
  });

  it("aborts on close during generation and ignores late streamed tokens", async () => {
    let callbacks: RagAskCallbacks | undefined;
    let signal: AbortSignal | undefined;
    let release = () => {};
    const { content, delegate, modal } = harness();
    delegate.askVault.mockImplementation(
      (_question, nextCallbacks, nextSignal) => {
        callbacks = nextCallbacks;
        signal = nextSignal;
        nextCallbacks.onContext?.(context());
        return new Promise((resolve) => {
          release = () => resolve(result());
        });
      },
    );
    const textarea = content.findByTag("textarea")[0];
    textarea.value = "question";
    content.findByClass("mod-cta")[0].trigger("click");
    const cancel = content.findByTag("button").find(
      (button) => button.text === "Отменить генерацию",
    );

    expect(cancel?.disabled).toBe(false);
    modal.close();
    callbacks?.onToken?.("late secret");
    release();
    await flush();

    expect(signal?.aborted).toBe(true);
    expect(content.children).toEqual([]);
    expect(content.text).not.toContain("late secret");
  });

  it("opens the exact trusted path and navigates to the reconstructed line", async () => {
    const { app, leaf, view } = harness();
    await openRagSource(app as never, context().sources[0]);

    expect(app.vault.getFileByPath).toHaveBeenCalledWith("Folder/Alpha.md");
    expect(leaf.openFile).toHaveBeenCalledOnce();
    expect(view.editor.setCursor).toHaveBeenCalledWith({ line: 7, ch: 0 });
  });

  it("handles a source deleted after answering without throwing", async () => {
    mocks.Notice.messages = [];
    const { app } = harness();
    app.vault.getFileByPath.mockReturnValue(null);

    await openRagSource(app as never, context().sources[0]);

    expect(mocks.Notice.messages).toContain("Заметка больше не существует.");
  });

  it("truncates source snippets by Unicode code points", () => {
    expect(sourceSnippet("😀😀😀", 2)).toBe("😀😀…");
  });

  it("never uses unsafe HTML APIs for model or source content", () => {
    const source = readFileSync(
      new URL("./ragModal.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("insertAdjacentHTML");
  });

  it("keeps the modal, result panes, and source cards overflow-safe", () => {
    const styles = readFileSync(
      new URL("../styles.css", import.meta.url),
      "utf8",
    );
    const shell = cssRule(styles, ".modal.ai-rag-shell");
    const modal = cssRule(styles, ".ai-rag-modal");
    const results = cssRule(styles, ".ai-rag-results");
    const sources = cssRule(styles, ".ai-rag-sources");
    const card = cssRule(styles, ".ai-rag-source");
    const title = cssRule(styles, ".ai-rag-source-title");

    expect(shell).toMatch(/height:\s*min\(/);
    expect(shell).toMatch(/overflow:\s*hidden/);
    expect(modal).toMatch(/display:\s*flex/);
    expect(modal).toMatch(/flex-direction:\s*column/);
    expect(modal).toMatch(/min-height:\s*0/);
    expect(results).toMatch(/min-width:\s*0/);
    expect(results).toMatch(/min-height:\s*0/);
    expect(results).toMatch(/overflow:\s*hidden/);
    expect(sources).toMatch(/flex-direction:\s*column/);
    expect(sources).toMatch(/flex:\s*1 1 0/);
    expect(sources).toMatch(/min-width:\s*0/);
    expect(sources).toMatch(/min-height:\s*0/);
    expect(sources).toMatch(/overflow-x:\s*hidden/);
    expect(sources).toMatch(/overflow-y:\s*auto/);
    expect(card).toMatch(/display:\s*block/);
    expect(card).toMatch(/flex:\s*0 0 auto/);
    expect(card).toMatch(/min-width:\s*0/);
    expect(card).toMatch(/height:\s*auto/);
    expect(card).toMatch(/white-space:\s*normal/);
    expect(title).toMatch(/overflow-wrap:\s*anywhere/);
    expect(title).toMatch(/word-break:\s*break-word/);
    const answer = cssRule(styles, ".ai-rag-answer");
    expect(answer).toMatch(/flex:\s*0 0 auto/);
  });
});
