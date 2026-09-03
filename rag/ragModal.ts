import { App, MarkdownView, Modal, Notice, TFile } from "obsidian";
import { t as tr } from "../i18n";
import { semanticBreadcrumb } from "../semantic/semanticSearchModal";
import type {
  RagAskCallbacks,
  RagAskResult,
  RagContext,
  RagSource,
} from "./types";

export interface RagModalDelegate {
  askVault(
    question: string,
    callbacks: RagAskCallbacks,
    signal: AbortSignal,
  ): Promise<RagAskResult>;
  errorMessage(error: unknown): string;
}

function sourceSnippet(text: string, maxCodePoints = 240): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const points = Array.from(normalized);
  return points.length <= maxCodePoints
    ? normalized
    : `${points.slice(0, maxCodePoints).join("")}…`;
}

export async function openRagSource(
  app: App,
  source: RagSource,
): Promise<void> {
  const file = app.vault.getFileByPath(source.path);
  if (!(file instanceof TFile)) {
    new Notice(tr("Заметка больше не существует."));
    return;
  }
  try {
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(file);
    if (leaf.view instanceof MarkdownView) {
      const position = { line: source.source.startLine, ch: 0 };
      try {
        leaf.view.editor.setCursor(position);
        leaf.view.editor.scrollIntoView(
          { from: position, to: position },
          true,
        );
        leaf.view.editor.focus();
      } catch {
        // Exact-path opening is primary; source-line navigation is best effort.
      }
    }
  } catch {
    new Notice(tr("Не удалось открыть найденную заметку."));
  }
}

export class AskVaultModal extends Modal {
  private questionEl: HTMLTextAreaElement | null = null;
  private askButton: HTMLButtonElement | null = null;
  private cancelButton: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;
  private answerEl: HTMLElement | null = null;
  private sourcesEl: HTMLElement | null = null;
  private busy = false;
  private openState = false;
  private requestGeneration = 0;
  private abortController: AbortController | null = null;
  private streamedAnswer = "";

  constructor(
    app: App,
    private readonly delegate: RagModalDelegate,
  ) {
    super(app);
  }

  onOpen(): void {
    this.openState = true;
    this.titleEl.setText(tr("Спросить Vault"));
    this.contentEl.empty();
    this.contentEl.addClass("ai-semantic-search-modal", "ai-rag-modal");

    this.questionEl = this.contentEl.createEl("textarea", {
      cls: "ai-rag-question",
      attr: {
        placeholder: tr("Задайте вопрос по содержимому Vault"),
        "aria-label": tr("Вопрос к Vault"),
        rows: "4",
      },
    });
    const actions = this.contentEl.createDiv({ cls: "ai-rag-actions" });
    this.cancelButton = actions.createEl("button", {
      text: tr("Отменить генерацию"),
      attr: { type: "button" },
    });
    this.cancelButton.disabled = true;
    this.askButton = actions.createEl("button", {
      text: tr("Спросить"),
      cls: "mod-cta",
      attr: { type: "button" },
    });
    this.statusEl = this.contentEl.createDiv({ cls: "ai-rag-status" });
    this.answerEl = this.contentEl.createDiv({ cls: "ai-rag-answer" });
    this.sourcesEl = this.contentEl.createDiv({ cls: "ai-rag-sources" });

    this.questionEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void this.runAsk();
      }
    });
    this.askButton.addEventListener("click", () => void this.runAsk());
    this.cancelButton.addEventListener("click", () => {
      this.abortController?.abort();
    });
    this.questionEl.focus();
  }

  onClose(): void {
    this.openState = false;
    this.requestGeneration++;
    this.abortController?.abort();
    this.abortController = null;
    this.busy = false;
    this.streamedAnswer = "";
    this.contentEl.empty();
    this.questionEl = null;
    this.askButton = null;
    this.cancelButton = null;
    this.statusEl = null;
    this.answerEl = null;
    this.sourcesEl = null;
  }

  private async runAsk(): Promise<void> {
    if (this.busy || !this.questionEl) return;
    const question = this.questionEl.value.trim();
    if (!question) {
      this.setStatus(tr("Введите непустой вопрос."), "empty");
      return;
    }

    this.busy = true;
    this.streamedAnswer = "";
    const request = ++this.requestGeneration;
    const controller = new AbortController();
    this.abortController = controller;
    this.setBusy(true);
    this.answerEl?.empty();
    this.sourcesEl?.empty();
    this.setStatus(tr("Ищу контекст в Vault..."), "loading");

    const callbacks: RagAskCallbacks = {
      onContext: (context) => {
        if (!this.isCurrent(request)) return;
        this.setStatus(
          `${tr("Найдено релевантных источников: {n}.", {
            n: context.sources.length,
          })}\n${tr("Генерирую ответ...")}`,
          "loading",
        );
        this.renderSources(context);
      },
      onToken: (token) => {
        if (!this.isCurrent(request)) return;
        this.streamedAnswer += token;
        this.answerEl?.setText(this.streamedAnswer);
      },
    };

    try {
      const result = await this.delegate.askVault(
        question,
        callbacks,
        controller.signal,
      );
      if (!this.isCurrent(request)) return;
      this.setStatus(
        tr("Ответ готов. Источников: {n}.", {
          n: result.context.sources.length,
        }),
        "ready",
      );
    } catch (error) {
      if (!this.isCurrent(request)) return;
      if (error instanceof Error && error.name === "AbortError") {
        this.setStatus(tr("Генерация отменена."), "empty");
      } else {
        this.setStatus(this.delegate.errorMessage(error), "error");
      }
    } finally {
      if (this.isCurrent(request)) {
        this.busy = false;
        this.abortController = null;
        this.setBusy(false);
      }
    }
  }

  private renderSources(context: RagContext): void {
    if (!this.sourcesEl) return;
    this.sourcesEl.empty();
    this.sourcesEl.createEl("h3", { text: tr("Источники") });
    for (const source of context.sources) {
      const card = this.sourcesEl.createEl("button", {
        cls: "ai-rag-source",
        attr: {
          type: "button",
          "aria-label": tr("Открыть заметку {path}", { path: source.path }),
        },
      });
      card.createDiv({
        cls: "ai-rag-source-title",
        text: `[${source.id}] ${source.path}`,
      });
      const breadcrumb = semanticBreadcrumb(source.headingPath);
      if (breadcrumb) {
        card.createDiv({ cls: "ai-rag-source-heading", text: breadcrumb });
      }
      card.createDiv({
        cls: "ai-rag-source-range",
        text: tr("Строки {start}–{end}", {
          start: source.source.startLine + 1,
          end: source.source.endLine + 1,
        }),
      });
      const snippet = sourceSnippet(source.text);
      if (snippet) {
        card.createDiv({ cls: "ai-rag-source-snippet", text: snippet });
      }
      card.addEventListener("click", () => {
        void openRagSource(this.app, source);
      });
    }
  }

  private isCurrent(request: number): boolean {
    return this.openState && request === this.requestGeneration;
  }

  private setBusy(value: boolean): void {
    if (this.questionEl) this.questionEl.disabled = value;
    if (this.askButton) this.askButton.disabled = value;
    if (this.cancelButton) this.cancelButton.disabled = !value;
  }

  private setStatus(
    text: string,
    kind: "loading" | "empty" | "error" | "ready",
  ): void {
    if (!this.statusEl) return;
    this.statusEl.setText(text);
    this.statusEl.setAttribute("data-state", kind);
  }
}

export { sourceSnippet };
