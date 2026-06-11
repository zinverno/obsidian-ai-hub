import {
  Plugin,
  Notice,
  Editor,
  Modal,
  Menu,
  App,
  TFile,
  Setting,
  ButtonComponent,
  setIcon,
  normalizePath,
  CachedMetadata,
} from "obsidian";
import {
  AIHubSettingTab,
  AIHubSettings,
  DEFAULT_SETTINGS,
  InsertionType,
} from "./settings";
import { validateSettings, callOpenRouter, streamOpenRouter } from "./api";
import {
  SELECTION_INSERTION_OPTIONS,
  INSERTION_OPTIONS,
  INSERTION_LABELS,
  INSERTION_ICONS,
  BATCH_PRESETS,
  BatchPreset,
  VAULT_SNAPSHOT_MAX_CHARS,
  STREAM_CONTEXT_MAX_CHARS,
  BATCH_DELAY_MS,
  MAX_TOKENS_STREAM,
  MAX_TOKENS_AUDIT,
  MAX_TOKENS_DATAVIEW,
  MAX_TOKENS_BATCH,
} from "./constants";
import {
  DeepAuditEngine,
  DeepAuditProgressModal,
  FinalAuditReport,
  ClusterSummary,
  DeepAuditConfig,
  DEFAULT_DEEP_AUDIT_CONFIG,
  SingleAuditEngine,
  SingleAuditProgressModal,
  SingleAuditReport,
} from "./deepAudit";
import { NoteIndexManager, IndexStats } from "./noteIndex";

type Mode = "simple" | "selection" | "vault";

interface VaultAuditStats {
  total: number;
  withTags: number;
  orphaned: number;
  folderDistribution: Record<string, number>;
  tagUsage: Record<string, number>;
}

export default class AIHubPlugin extends Plugin {
  settings: AIHubSettings;
  lastPrompt = "";

  async onload() {
    try {
      await this.loadSettings();

      this.addRibbonIcon("sparkles", "AI Hub: Панель управления", () => {
        new BatchProcessModal(this.app, this).open();
      });

      this.addCommand({
        id: "ai-hub-open-panel",
        name: "AI Hub: Открыть панель управления",
        callback: () => new BatchProcessModal(this.app, this).open(),
      });

      this.addCommand({
        id: "ai-deep-vault-audit",
        name: "AI Hub: Глубокий аудит — выбор режима",
        callback: () => {
          void this.openAuditModeModal();
        },
      });

      this.addCommand({
        id: "ai-simple-append",
        name: "AI: Простое дополнение",
        editorCallback: (e) => {
          void this.runAIStream(e, "simple");
        },
      });

      this.addCommand({
        id: "ai-vault-append",
        name: "AI: Умное дополнение (Vault)",
        editorCallback: (e) => {
          void this.runAIStream(e, "vault");
        },
      });

      this.addCommand({
        id: "ai-selection",
        name: "AI: Обработать выделение",
        editorCheckCallback: (checking, e) => {
          if (!e.getSelection()?.trim()) return false;
          if (!checking) void this.runAIStream(e, "selection");
          return true;
        },
      });

      this.addCommand({
        id: "ai-dataview-generate",
        name: "AI: Создать Dataview",
        editorCallback: (e) => {
          void this.generateDataview(e);
        },
      });

      this.addCommand({
        id: "ai-vault-audit",
        name: "AI Hub: Проанализировать структуру хранилища",
        callback: () => {
          void this.runVaultAudit();
        },
      });

      this.addCommand({
        id: "ai-batch-process",
        name: "AI: Обработать несколько заметок",
        callback: () => new BatchProcessModal(this.app, this).open(),
      });

      if (this.settings.showContextMenu) {
        this.registerEvent(
          this.app.workspace.on("editor-menu", (menu, editor) => {
            this.addContextMenuItems(menu, editor);
          }),
        );
      }

      this.addSettingTab(new AIHubSettingTab(this.app, this));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`❌ Ошибка загрузки AI Hub: ${msg}`);
    }
  }
  onunload() {
    const style = document.getElementById("ai-hub-styles");
    if (style) style.remove();
  }
  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

    // Миграция: если provider не задан — определяем по baseUrl
    if (!data?.provider && this.settings.baseUrl) {
      const url = this.settings.baseUrl.toLowerCase();
      if (url.includes("openrouter")) this.settings.provider = "openrouter";
      else if (url.includes("localhost") || url.includes("ollama"))
        this.settings.provider = "ollama";
      else if (url.includes("openai.com")) this.settings.provider = "openai";
      else if (url.includes("groq.com")) this.settings.provider = "groq";
      else this.settings.provider = "custom";
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async openAuditModeModal() {
    const err = validateSettings(this.settings);
    if (err) {
      new Notice(err);
      return;
    }
    new AuditModeModal(this.app, this).open();
  }

  async runDeepVaultAudit() {
    const err = validateSettings(this.settings);
    if (err) {
      new Notice(err);
      return;
    }

    // Подтверждение с оценкой стоимости
    const files = this.app.vault.getMarkdownFiles().filter((f) => {
      const p = f.path.toLowerCase();
      return (
        !p.startsWith(".obsidian/") &&
        !p.startsWith("templates/") &&
        !p.startsWith(".ai-backup")
      );
    });

    // ✅ Собираем config из настроек пользователя + дефолты для незаданных полей
    const config: Partial<DeepAuditConfig> = {
      batchSize: this.settings.deepAudit.batchSize,
      maxConcurrent: this.settings.deepAudit.maxConcurrent,
      delayBetweenBatchesMs: this.settings.deepAudit.delayMs,
    };

    // Для оценки используем финальные значения (с fallback на дефолты)
    const effectiveConfig = { ...DEFAULT_DEEP_AUDIT_CONFIG, ...config };
    const estimatedBatches = Math.ceil(
      files.length / effectiveConfig.batchSize,
    );
    const estimatedRequests =
      estimatedBatches +
      Math.ceil(estimatedBatches / effectiveConfig.reduceGroupSize) +
      1;
    const estimatedMinutes = Math.ceil(
      (estimatedBatches * (effectiveConfig.delayBetweenBatchesMs + 3000)) /
      effectiveConfig.maxConcurrent /
      60000,
    );
    const confirmed = await this.confirmDeepAudit(
      files.length,
      estimatedRequests,
      estimatedMinutes,
    );
    if (!confirmed) return;

    // Запускаем
    const index = new NoteIndexManager(this.app);
    await index.load();
    const engine = new DeepAuditEngine(this.app, this.settings, config, index);
    const progressModal = new DeepAuditProgressModal(this.app);
    progressModal.attachEngine(engine);
    progressModal.open();

    try {
      const report = await engine.run();
      progressModal.finish();
      await this.saveDeepAuditReport(report);
      new Notice(
        `✅ Глубокий аудит завершён за ${Math.round(report.durationMs / 1000)}с`,
      );
    } catch (err) {
      progressModal.close();
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Отменено")) {
        new Notice("⏹ Аудит отменён");
      } else {
        new Notice(`❌ Ошибка аудита: ${msg}`);
      }
    }
  }

  async runSingleAudit(index: NoteIndexManager, onlyStale: boolean) {
    const config = {
      delayMs: this.settings.deepAudit.delayMs,
      maxRetries: 2,
      maxFileChars: 15_000,
      onlyStale,
    };

    const engine = new SingleAuditEngine(
      this.app,
      this.settings,
      index,
      config,
    );
    const progressModal = new SingleAuditProgressModal(this.app);
    progressModal.attachEngine(engine);
    progressModal.open();

    try {
      const report: SingleAuditReport = await engine.run();
      progressModal.finish();

      const msg = [
        `✅ Single аудит завершён!`,
        `Проанализировано: ${report.processedFiles}`,
        `Пропущено (кэш): ${report.skippedFiles}`,
        `Ошибок: ${report.failedFiles}`,
        `Время: ${Math.round(report.durationMs / 1000)}с`,
      ].join("\n");

      new Notice(msg, 8000);
    } catch (err) {
      progressModal.close();
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Отменено") || msg.includes("abort")) {
        new Notice("⏹ Аудит остановлен");
      } else {
        new Notice(`❌ Ошибка Single аудита: ${msg}`);
      }
    }
  }

  private confirmDeepAudit(
    fileCount: number,
    requests: number,
    minutes: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new Modal(this.app);
      modal.titleEl.setText("🔬 Глубокий аудит хранилища");
      const c = modal.contentEl;

      c.createEl("p", {
        text: "Эта операция прочитает содержимое каждой заметки и отправит пакетами в ЛЛМ для детального анализа.",
      });

      const stats = c.createDiv({ cls: "ai-hub-query-box" });
      const statsData: Array<{ icon: string; label: string; value: string }> = [
        { icon: "file-text", label: "Файлов", value: String(fileCount) },
        { icon: "zap", label: "Запросов к API", value: `~${requests}` },
        { icon: "clock", label: "Примерное время", value: `~${minutes} мин` },
      ];
      statsData.forEach(({ icon, label, value }) => {
        const row = stats.createDiv({ cls: "ai-hub-cost-row" });
        const iconEl = row.createSpan({ cls: "ai-hub-cost-icon" });
        setIcon(iconEl, icon);
        row.createSpan({ text: `${label}: `, cls: "ai-hub-cost-label" });
        row.createSpan({ text: value, cls: "ai-hub-cost-val" });
      });
      stats.createDiv({
        text: "Стоимость зависит от вашего провайдера и тарифа",
        cls: "ai-hub-cost-note",
      });

      c.createDiv({
        text: "На бесплатном тире OpenRouter возможны ошибки rate-limit. Ничего в хранилище не изменяется.",
        cls: "ai-hub-warning",
      });

      let done = false;
      const btns = c.createDiv({ cls: "modal-button-container" });
      new ButtonComponent(btns)
        .setButtonText("Отмена")
        .setIcon("x")
        .onClick(() => {
          done = true;
          resolve(false);
          modal.close();
        });
      new ButtonComponent(btns)
        .setButtonText("Начать анализ")
        .setIcon("play")
        .setCta()
        .onClick(() => {
          done = true;
          resolve(true);
          modal.close();
        });
      modal.onClose = () => {
        if (!done) resolve(false);
      };
      modal.open();
    });
  }

  private async saveDeepAuditReport(report: FinalAuditReport) {
    const dateStr = new Date()
      .toLocaleString("ru-RU")
      .replace(/[/:]/g, "-")
      .replace(",", "");
    const durationStr = `${Math.round(report.durationMs / 1000)}с`;

    const clustersMd = report.clusters
      .map((c) => {
        const files = c.filePaths
          .slice(0, 20)
          .map((p) => {
            const basename = p.split("/").pop()?.replace(/\.md$/, "") ?? p;
            return `  - [[${basename}]]`;
          })
          .join("\n");
        const more =
          c.filePaths.length > 20
            ? `\n  - _...и ещё ${c.filePaths.length - 20} файлов_`
            : "";
        return `### 📚 ${c.name}\n*${c.description}*\n\n**Файлов:** ${c.fileCount} · **Предлагаемая MOC:** \`${c.suggestedMOC}\`\n\n**Файлы:**\n${files}${more}`;
      })
      .join("\n\n---\n\n");

    const content = `---
type: deep-audit-report
date: ${new Date().toISOString()}
duration: ${durationStr}
files_analyzed: ${report.processedFiles}
files_failed: ${report.failedFiles}
---

# 🔬 Глубокий аудит хранилища

> [!abstract] Сводка
> - **Проанализировано файлов:** ${report.processedFiles} из ${report.totalFiles}
> - **Не удалось обработать:** ${report.failedFiles}
> - **Найдено кластеров:** ${report.clusters.length}
> - **Время выполнения:** ${durationStr}

---

## 🧠 Тематические кластеры

${clustersMd}

---

${report.globalInsights}

---

${report.actionPlan}

---

> [!tip] Что дальше?
> 1. Создайте MOC-заметки из предложенных выше.
> 2. Свяжите файлы из кластеров через обратные ссылки.
> 3. Запустите массовую обработку для добавления тегов из рекомендаций.
`;

    const path = normalizePath(`Deep-Audit-${dateStr}.md`);
    const file = await this.app.vault.create(path, content);

    // Создаём расширенный Canvas
    await this.createDeepAuditCanvas(dateStr, report);

    await this.app.workspace.getLeaf().openFile(file);
  }

  private async createDeepAuditCanvas(
    dateStr: string,
    report: FinalAuditReport,
  ) {
    const canvasPath = normalizePath(`Deep-Audit-Map-${dateStr}.canvas`);

    const nodes: any[] = [
      {
        id: "center",
        type: "text",
        text: `# 🔬 Deep Audit\n${new Date().toLocaleDateString("ru-RU")}\n\n**${report.processedFiles}** файлов\n**${report.clusters.length}** кластеров`,
        x: 0,
        y: 0,
        width: 400,
        height: 250,
        color: "4",
      },
    ];

    const edges: any[] = [];
    const radius = 700;
    const angleStep = (2 * Math.PI) / Math.max(1, report.clusters.length);

    report.clusters.forEach((cluster, i) => {
      const angle = i * angleStep;
      const x = Math.round(Math.cos(angle) * radius) - 175;
      const y = Math.round(Math.sin(angle) * radius) - 125;

      const nodeId = `cluster-${i}`;
      const fileList = cluster.filePaths
        .slice(0, 10)
        .map((p) => `- [[${p.split("/").pop()?.replace(/\.md$/, "")}]]`)
        .join("\n");

      nodes.push({
        id: nodeId,
        type: "text",
        text: `## ${cluster.name}\n*${cluster.description}*\n\n**MOC:** \`${cluster.suggestedMOC}\`\n\n${fileList}${cluster.filePaths.length > 10 ? `\n_...+${cluster.filePaths.length - 10}_` : ""}`,
        x,
        y,
        width: 350,
        height: 300,
        color: String((i % 6) + 1),
      });

      edges.push({
        id: `edge-${i}`,
        fromNode: "center",
        toNode: nodeId,
      });
    });

    await this.app.vault.create(
      canvasPath,
      JSON.stringify({ nodes, edges }, null, 2),
    );
  }
  // === Основной стриминг ===
  async runAIStream(editor: Editor, mode: Mode) {
    const err = validateSettings(this.settings);
    if (err) {
      new Notice(err);
      return;
    }

    const selPreview =
      mode === "selection" ? editor.getSelection()?.slice(0, 200) : undefined;
    const prompt = await promptUser(
      this.app,
      mode === "vault" ? "Запрос для поиска:" : "Что добавить/изменить?",
      {
        mode,
        selectionPreview: selPreview,
        modelName: this.settings.model,
        lastPrompt: this.lastPrompt || undefined,
      },
    );
    if (!prompt) return;
    this.lastPrompt = prompt;

    const target = await this.awaitInsertionMenu(editor, mode);
    if (!target) return;

    const loadingNotice = notify("loading", "AI думает и пишет...");

    try {
      const { system, user } = this.buildPrompts(editor, mode, prompt);

      if (target === "clipboard") {
        const fullRes = await callOpenRouter(this.settings, system, user);
        await navigator.clipboard.writeText(fullRes);
        loadingNotice.hide();
        notify("success", "Скопировано в буфер");
        return;
      }

      if (target === "new") {
        await this.streamToNewNote(system, user, prompt);
        loadingNotice.hide();
        notify("success", "Новая заметка создана");
        return;
      }

      await this.prepareInsertionPoint(editor, target);
      await this.streamIntoEditor(editor, target, system, user);

      loadingNotice.hide();
      notify("success", "Готово");
    } catch (err) {
      loadingNotice.hide();
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`❌ Ошибка генерации: ${msg}`);
    }
  }

  private buildPrompts(
    editor: Editor,
    mode: Mode,
    prompt: string,
  ): { system: string; user: string } {
    const sel = editor.getSelection();

    if (mode === "selection" && sel?.trim()) {
      return {
        system:
          "Ты — редактор. Обработай текст по инструкции. Верни ТОЛЬКО результат без пояснений. Не повторяй фразы. Остановись когда задача выполнена.",
        user: `Текст:\n${sel}\n\nИнструкция: ${prompt}`,
      };
    }

    let fullText = editor.getValue();
    if (fullText.length > STREAM_CONTEXT_MAX_CHARS) {
      fullText =
        fullText.slice(0, STREAM_CONTEXT_MAX_CHARS) +
        "\n... [контекст обрезан]";
    }

    return {
      system:
        "Ты — ассистент для заметок Obsidian. " +
        "Дополни заметку согласно задаче. " +
        "НИКОГДА не повторяй уже написанный текст. " +
        "Остановись когда задача выполнена, не продолжай бесконечно.",
      user: `Заметка:\n${fullText}\n\nЗадача: ${prompt}`,
    };
  }

  private async streamToNewNote(system: string, user: string, prompt: string) {
    const folder = this.settings.newNoteFolder?.trim() ?? "";
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
    const timeStr = now.toTimeString().slice(0, 5).replace(":", "");
    const topicStr =
      prompt
        .slice(0, 30)
        .replace(/[^a-zA-Z0-9а-яА-ЯёЁ\s]/g, "")
        .trim()
        .replace(/\s+/g, "-") || "response";

    const filename = (this.settings.filenameTemplate || "AI-{{date}}-{{topic}}")
      .replace("{{date}}", dateStr)
      .replace("{{time}}", timeStr)
      .replace("{{topic}}", topicStr);

    const path = normalizePath(
      folder ? `${folder}/${filename}.md` : `${filename}.md`,
    );

    if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder).catch(() => {
        /* уже существует */
      });
    }

    const newFile = await this.app.vault.create(path, "");
    await this.app.workspace.getLeaf().openFile(newFile);

    const newEditor = this.app.workspace.activeEditor?.editor;
    if (!newEditor)
      throw new Error("Не удалось получить редактор новой заметки");

    let line = 0;
    let ch = 0;

    await streamOpenRouter(
      this.settings,
      system,
      user,
      (chunk) => {
        newEditor.replaceRange(chunk, { line, ch });
        const newlines = chunk.split("\n");
        if (newlines.length > 1) {
          line += newlines.length - 1;
          ch = newlines[newlines.length - 1].length;
        } else {
          ch += chunk.length;
        }
      },
      { maxTokens: MAX_TOKENS_STREAM },
    );
  }

  private async streamIntoEditor(
    editor: Editor,
    target: InsertionType,
    system: string,
    user: string,
  ) {
    const startPos = editor.getCursor("to");
    let line = startPos.line;
    let ch = startPos.ch;

    await streamOpenRouter(
      this.settings,
      system,
      user,
      (chunk) => {
        editor.replaceRange(chunk, { line, ch });

        const newlines = chunk.split("\n");
        if (newlines.length > 1) {
          line += newlines.length - 1;
          ch = newlines[newlines.length - 1].length;
        } else {
          ch += chunk.length;
        }

        if (target !== "replace") {
          editor.setCursor({ line, ch });
        }
      },
      { maxTokens: MAX_TOKENS_STREAM },
    );
  }

  async awaitInsertionMenu(
    editor: Editor,
    mode: Mode,
  ): Promise<InsertionType | null> {
    const opts =
      mode === "selection" ? SELECTION_INSERTION_OPTIONS : INSERTION_OPTIONS;
    const def: InsertionType = opts.includes(this.settings.defaultInsertion)
      ? this.settings.defaultInsertion
      : opts[0];

    return new Promise((resolve) => {
      const menu = new Menu();
      let resolved = false;

      opts.forEach((opt) => {
        menu.addItem((item) => {
          item
            .setTitle(INSERTION_LABELS[opt])
            .setIcon(opt === def ? "check" : INSERTION_ICONS[opt])
            .onClick(() => {
              resolved = true;
              resolve(opt);
            });
        });
      });

      menu.onHide(() => {
        if (!resolved) resolve(null);
      });

      try {
        const cursor = editor.getCursor("from");
        const pos = (editor as any).coordsAtPos(cursor.ch);
        if (pos && "left" in pos) {
          menu.showAtPosition({ x: pos.left, y: pos.top });
          return;
        }
      } catch {
        /* fallback ниже */
      }

      const rect = document.body.getBoundingClientRect();
      menu.showAtPosition({ x: rect.width / 2, y: rect.height / 3 });
    });
  }

  async prepareInsertionPoint(editor: Editor, target: InsertionType) {
    switch (target) {
      case "end": {
        const lastLine = editor.lastLine();
        const lastCh = editor.getLine(lastLine).length;
        editor.replaceRange("\n\n", { line: lastLine, ch: lastCh });
        editor.setCursor({ line: lastLine + 2, ch: 0 });
        break;
      }
      case "beginning":
        editor.setCursor({ line: 0, ch: 0 });
        editor.replaceRange("\n\n", { line: 0, ch: 0 });
        editor.setCursor({ line: 0, ch: 0 });
        break;
      case "replace":
        break;
      case "after":
        editor.setCursor(editor.getCursor("to"));
        editor.replaceSelection("\n\n");
        break;
      case "cursor":
        editor.replaceSelection("");
        break;
    }
  }

  // === Dataview ===
  async generateDataview(editor: Editor) {
    const err = validateSettings(this.settings);
    if (err) {
      new Notice(err);
      return;
    }

    const p = await promptUser(this.app, "Что показать?");
    if (!p) return;

    const notice = notify("loading", "Генерирую Dataview...");
    try {
      const r = await callOpenRouter(
        this.settings,
        "Только код dataview. Начинай с TABLE/LIST/TASK/CALENDAR. Без markdown-обёртки.",
        `Запрос: ${p}`,
        { maxTokens: MAX_TOKENS_DATAVIEW },
      );
      const cleaned = r
        .replace(/```[a-zA-Z]*\n?/g, "")
        .replace(/```/g, "")
        .trim()
        .replace(/^dataview\s*/i, "");

      if (!/^(TABLE|LIST|TASK|CALENDAR|FROM)/i.test(cleaned)) {
        throw new Error("Некорректный ответ AI");
      }
      editor.replaceSelection(`\n\`\`\`dataview\n${cleaned}\n\`\`\`\n`);
      notice.hide();
      notify("success", "Dataview создан");
    } catch (err) {
      notice.hide();
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`❌ Ошибка генерации: ${msg}`);
    }
  }

  // === Контекстное меню ===
  addContextMenuItems(menu: Menu, editor: Editor) {
    const sel = editor.getSelection() || "";

    menu.addSeparator();
    menu.addItem((item) => {
      const submenu = (
        item.setTitle("AI Hub").setIcon("sparkles") as any
      ).setSubmenu();

      submenu.addItem((sub) =>
        sub
          .setTitle("Улучшить стиль")
          .setIcon("sparkles")
          .onClick(() => this.quickAction(editor, sel, "Улучши стиль")),
      );
      submenu.addItem((sub) =>
        sub
          .setTitle("Сократить")
          .setIcon("minimize-2")
          .onClick(() => this.quickAction(editor, sel, "Сократи")),
      );
      submenu.addItem((sub) =>
        sub
          .setTitle("Перефразировать")
          .setIcon("refresh-cw")
          .onClick(() => this.quickAction(editor, sel, "Перефразируй")),
      );
      submenu.addItem((sub) =>
        sub
          .setTitle("Создать Dataview")
          .setIcon("table")
          .onClick(() => this.generateDataview(editor)),
      );
    });
  }

  async quickAction(editor: Editor, sel: string, action: string) {
    if (!sel.trim()) {
      new Notice("Сначала выделите текст");
      return;
    }
    const notice = new Notice("🤖 Думаю...", 0);
    try {
      const r = await callOpenRouter(
        this.settings,
        "Верни только результат, без пояснений.",
        `Текст:\n${sel}\n\nИнструкция: ${action}`,
        { maxTokens: MAX_TOKENS_BATCH },
      );
      const cleaned = r
        .replace(/```[a-zA-Z]*\n?/g, "")
        .replace(/```/g, "")
        .trim();
      editor.replaceSelection(cleaned);
      notice.hide();
      new Notice("✅ Готово");
    } catch (err) {
      notice.hide();
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`❌ Ошибка: ${msg}`);
    }
  }

  // === Аудит хранилища ===
  async runVaultAudit() {
    const progressModal = new ProgressModal(this.app, "Анализ хранилища");
    progressModal.open();

    const allFiles = this.app.vault.getMarkdownFiles().filter((file) => {
      const path = file.path.toLowerCase();
      return (
        !path.startsWith(".obsidian/") &&
        !path.startsWith("templates/") &&
        !file.basename.startsWith(".")
      );
    });

    const stats: VaultAuditStats = {
      total: allFiles.length,
      withTags: 0,
      orphaned: 0,
      folderDistribution: {},
      tagUsage: {},
    };

    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    let snapshot = "NAME | PATH | TAGS | LINKS\n";

    for (let i = 0; i < allFiles.length; i++) {
      const file = allFiles[i];
      progressModal.update(i, allFiles.length);

      const cache = this.app.metadataCache.getFileCache(file);
      const tags = this.extractAllTags(cache);
      const linksCount = cache?.links?.length ?? 0;
      const backlinksCount = this.countBacklinks(file, resolvedLinks);
      const totalConnections = linksCount + backlinksCount;

      if (tags.length > 0) stats.withTags++;
      if (totalConnections === 0) stats.orphaned++;

      const folder = file.parent?.path || "root";
      stats.folderDistribution[folder] =
        (stats.folderDistribution[folder] || 0) + 1;
      tags.forEach((t) => (stats.tagUsage[t] = (stats.tagUsage[t] || 0) + 1));

      snapshot += `${file.basename} | ${file.path} | ${tags.join(", ")} | ${totalConnections}\n`;

      if (i % 40 === 0) await new Promise((r) => setTimeout(r, 1));
    }

    progressModal.close();

    if (snapshot.length > VAULT_SNAPSHOT_MAX_CHARS) {
      new Notice("Хранилище большое — данные для API обрезаны.");
      snapshot =
        snapshot.slice(0, VAULT_SNAPSHOT_MAX_CHARS) + "\n... [обрезано]";
    }

    const isChaos = stats.withTags < stats.total * 0.2;
    const topFolders = Object.entries(stats.folderDistribution)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    const topTags = Object.entries(stats.tagUsage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);

    const auditPrompt = `Проанализируй структуру Obsidian-хранилища.

ОБЩАЯ СТАТИСТИКА:
- Заметок: ${stats.total}
- С тегами: ${stats.withTags}
- Без связей: ${stats.orphaned}
- Состояние: ${isChaos ? "ХАОС (нужна первичная структура)" : "ЕСТЬ СТРУКТУРА (нужна оптимизация)"}

СПИСОК ФАЙЛОВ (Формат: Имя | Путь | Теги | Связи):
${snapshot}

ЗАДАЧА:
1. Выяви 3-5 тематических кластеров.
2. Дай 5 конкретных шагов реорганизации.
3. Предложи 3-5 названий MOC-заметок.
Отвечай кратко и структурно на русском.`;

    await this.generateFinalReport(auditPrompt, stats, topFolders, topTags);
  }

  private async generateFinalReport(
    prompt: string,
    stats: VaultAuditStats,
    folders: Array<[string, number]>,
    tags: Array<[string, number]>,
  ) {
    const notice = new Notice("ИИ формирует дашборд...", 0);
    try {
      const aiAdvice = await callOpenRouter(
        { ...this.settings, temperature: 0.3 },
        "Ты эксперт по визуализации знаний в Obsidian.",
        prompt,
        { maxTokens: MAX_TOKENS_AUDIT },
      );

      const dateStr = new Date().toLocaleString("ru-RU").replace(/[/:]/g, "-");
      const connectivity =
        stats.total > 0
          ? Math.round(((stats.total - stats.orphaned) / stats.total) * 100)
          : 0;

      const report = `---
type: audit-dashboard
date: ${new Date().toISOString()}
---
# 🚀 Дашборд аудита хранилища

> [!abstract] Краткая сводка
> - **Всего файлов:** ${stats.total}
> - **Связанность:** ${connectivity}%
> - **Статус:** ${stats.orphaned > stats.total * 0.3 ? "⚠️ Требуется структуризация" : "✅ В порядке"}

---

## 🤖 Рекомендации ИИ
${aiAdvice}

---

## 📂 Архитектура (Топ папок)
> [!info] Распределение
${folders.map((f) => `> - **${f[0]}**: ${f[1]} файлов`).join("\n")}

## 🏷️ Облако тегов
> [!quote] Основные ветви
> ${tags.map((t) => `#${t[0].replace("#", "")}`).join(" ")}

---
## 🔗 Изолированные заметки
> [!warning] Найдено сирот: ${stats.orphaned}
> Рекомендуется связать их с MOC.
`;

      const reportFile = await this.app.vault.create(
        normalizePath(`Audit-Dashboard-${dateStr}.md`),
        report,
      );
      await this.createAuditCanvas(dateStr, stats, aiAdvice, folders);
      await this.app.workspace.getLeaf().openFile(reportFile);

      notice.hide();
      new Notice("✅ Дашборд и Canvas созданы");
    } catch (err) {
      notice.hide();
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`❌ Ошибка создания дашборда: ${msg}`);
    }
  }

  private async createAuditCanvas(
    dateStr: string,
    stats: VaultAuditStats,
    aiAdvice: string,
    folders: Array<[string, number]>,
  ) {
    const canvasPath = normalizePath(`Audit-Map-${dateStr}.canvas`);
    const canvasData = {
      nodes: [
        {
          id: "center",
          type: "text",
          text: `# 📊 Vault Audit\n${new Date().toLocaleDateString()}`,
          x: 0,
          y: 0,
          width: 400,
          height: 200,
          color: "1",
        },
        {
          id: "stats",
          type: "text",
          text: `## 📈 Статистика\n- Файлов: ${stats.total}\n- Сирот: ${stats.orphaned}`,
          x: -450,
          y: -100,
          width: 300,
          height: 200,
        },
        {
          id: "advice",
          type: "text",
          text: `## 💡 Советы ИИ\n${aiAdvice.slice(0, 1000)}${aiAdvice.length > 1000 ? "..." : ""}`,
          x: 0,
          y: 250,
          width: 850,
          height: 400,
        },
        {
          id: "folders",
          type: "text",
          text: `## 📂 Структура папок\n${folders.map((f) => `- ${f[0]}`).join("\n")}`,
          x: 450,
          y: -100,
          width: 300,
          height: 200,
        },
      ],
      edges: [
        {
          id: "e1",
          fromNode: "center",
          fromSide: "left",
          toNode: "stats",
          toSide: "right",
        },
        {
          id: "e2",
          fromNode: "center",
          fromSide: "right",
          toNode: "folders",
          toSide: "left",
        },
        {
          id: "e3",
          fromNode: "center",
          fromSide: "bottom",
          toNode: "advice",
          toSide: "top",
        },
      ],
    };

    await this.app.vault.create(
      canvasPath,
      JSON.stringify(canvasData, null, 2),
    );
  }

  private extractAllTags(cache: CachedMetadata | null): string[] {
    const tags: string[] = cache?.tags?.map((t) => t.tag) ?? [];
    const fm = cache?.frontmatter;
    const fmTags = fm?.tags ?? fm?.tag;
    if (fmTags) {
      const extra = Array.isArray(fmTags)
        ? fmTags
        : String(fmTags).split(/[,\s]+/);
      extra.forEach((raw) => {
        const t = String(raw).trim();
        if (t) tags.push(t.startsWith("#") ? t : `#${t}`);
      });
    }
    return [...new Set(tags)];
  }

  private countBacklinks(
    file: TFile,
    resolvedLinks: Record<string, Record<string, number>>,
  ): number {
    let count = 0;
    for (const sourcePath in resolvedLinks) {
      if (resolvedLinks[sourcePath][file.path]) count++;
    }
    return count;
  }

  // === Батч-обработка ===
  async runBatchProcessing(files: TFile[], query: string) {
    const backupFolder = normalizePath(`.ai-backup-${Date.now()}`);
    await this.app.vault.createFolder(backupFolder).catch(() => {
      /* уже есть */
    });

    new Notice(`📦 Начало обработки ${files.length} заметок...`);
    const progress = new BatchProgressModal(this.app, files.length);
    progress.open();

    let processed = 0;
    let errorCount = 0;
    const errors: string[] = [];

    for (const file of files) {
      if (progress.isCancelled) break;

      try {
        progress.logPending(file.name);
        const content = await this.app.vault.read(file);

        const newContent = await callOpenRouter(
          this.settings,
          "Ты — редактор. Верни ТОЛЬКО изменённый текст, без пояснений.",
          `Текст заметки:\n${content}\n\nИнструкция: ${query}\n\nВерни полный изменённый текст.`,
        );

        const backupPath = normalizePath(`${backupFolder}/${file.name}`);
        await this.app.vault.create(backupPath, content).catch(() => {
          /* skip */
        });
        await this.app.vault.modify(file, newContent);

        processed++;
        progress.update(processed, errorCount);
        progress.logSuccess(file.name);

        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      } catch (err) {
        errorCount++;
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${file.name}: ${msg}`);
        progress.update(processed, errorCount);
        progress.logError(file.name, msg);
      }
    }

    await new Promise((r) => setTimeout(r, 1500));
    progress.close();

    let report =
      `# AI Batch Report\n\n` +
      `📊 **Результат**\n` +
      `- Успешно: ${processed}\n` +
      `- Ошибок: ${errorCount}\n` +
      `- Backup: \`${backupFolder}/\`\n`;
    if (errors.length) {
      report += `\n## ⚠️ Ошибки\n${errors
        .slice(0, 20)
        .map((e) => `- ${e}`)
        .join("\n")}\n`;
    }

    const reportPath = normalizePath(
      `AI Batch Report ${new Date().toISOString().slice(0, 10)}.md`,
    );
    const reportFile = await this.app.vault
      .create(reportPath, report)
      .catch(
        async () =>
          await this.app.vault.create(
            normalizePath(`AI Batch Report ${Date.now()}.md`),
            report,
          ),
      );
    await this.app.workspace.getLeaf().openFile(reportFile);

    new Notice(`✅ Готово! Успешно: ${processed}, ошибок: ${errorCount}`);
  }
}

// === ПРОГРЕСС-МОДАЛКИ ===
class ProgressModal extends Modal {
  private bar: HTMLProgressElement;
  private text: HTMLElement;
  private spinner: HTMLElement;

  constructor(app: App, title: string) {
    super(app);
    this.titleEl.setText(title);
  }

  onOpen() {
    const root = this.contentEl.createDiv({ cls: "ai-hub-progress-root" });

    const statusRow = root.createDiv({ cls: "ai-hub-status-row" });
    this.spinner = statusRow.createSpan({ cls: "ai-hub-spinner" });
    this.text = statusRow.createDiv({
      cls: "ai-hub-progress-text",
      text: "Сбор данных...",
    });
    this.text.addClass("ai-hub-status-text");

    this.bar = root.createEl("progress", { cls: "ai-hub-progress-bar" });
    this.bar.setAttribute("aria-label", "Прогресс операции");
    this.bar.max = 100;
    this.bar.value = 0;
  }

  update(current: number, total: number) {
    if (total <= 0) return;
    const percent = Math.round((current / total) * 100);
    this.bar.value = percent;
    this.bar.setAttribute("aria-valuenow", String(percent));
    this.text.setText(`Обработано: ${current} / ${total} — ${percent}%`);
    if (percent >= 100) this.spinner.addClass("ai-hub-hidden");
  }
}

class BatchProgressModal extends Modal {
  private bar: HTMLProgressElement;
  private text: HTMLElement;
  private log: HTMLElement;
  private spinner: HTMLElement;
  isCancelled = false;
  private total: number;

  constructor(app: App, total: number) {
    super(app);
    this.total = total;
    this.titleEl.setText("Пакетная обработка");
  }

  onOpen() {
    const root = this.contentEl.createDiv({ cls: "ai-hub-progress-root" });

    const statusRow = root.createDiv({ cls: "ai-hub-status-row" });
    this.spinner = statusRow.createSpan({ cls: "ai-hub-spinner" });
    this.text = statusRow.createDiv({
      cls: "ai-hub-progress-text",
      text: `0 / ${this.total}`,
    });
    this.text.addClass("ai-hub-status-text");

    this.bar = root.createEl("progress", { cls: "ai-hub-progress-bar" });
    this.bar.setAttribute("aria-label", "Прогресс обработки заметок");
    this.bar.max = this.total;
    this.bar.value = 0;

    this.log = root.createDiv({ cls: "ai-hub-progress-log" });
    this.log.setAttribute("role", "log");
    this.log.setAttribute("aria-live", "polite");
    this.log.setAttribute("aria-label", "Журнал обработки");

    const btnRow = root.createDiv({ cls: "ai-hub-progress-btnrow" });
    new Setting(btnRow).addButton((btn) =>
      btn
        .setButtonText("Остановить")
        .setIcon("square")
        .setWarning()
        .onClick(() => {
          this.isCancelled = true;
          this.spinner.addClass("ai-hub-hidden");
          new Notice("⏹ Остановка после текущей заметки...");
        }),
    );
  }

  update(processed: number, errors: number) {
    const done = processed + errors;
    this.bar.value = done;
    this.bar.setAttribute("aria-valuenow", String(done));
    const pct = this.total > 0 ? Math.round((done / this.total) * 100) : 0;
    this.text.setText(`${done} / ${this.total} (${pct}%) · ошибок: ${errors}`);
  }

  private addEntry(text: string, cls: string) {
    const el = this.log.createDiv({ cls: `ai-hub-log-entry ${cls}` });
    el.setText(text);
    this.log.scrollTop = this.log.scrollHeight;
  }

  logPending(name: string) {
    this.addEntry(`⧗ ${name}`, "ai-hub-log-pending");
  }
  logSuccess(name: string) {
    this.addEntry(`✓ ${name}`, "ai-hub-log-success");
  }
  logError(name: string, msg: string) {
    this.addEntry(`✗ ${name}: ${msg}`, "ai-hub-log-error");
  }
}

// === УВЕДОМЛЕНИЯ ===
/**
 * Типизированные уведомления с цветовой полосой слева.
 * type: 'success' | 'error' | 'warning' | 'info' | 'loading'
 * loading — timeout=0 (не исчезает), скрывай вручную через notice.hide()
 */
function notify(
  type: "success" | "error" | "warning" | "info" | "loading",
  message: string,
  durationMs?: number,
): Notice {
  const defaultDur: Record<string, number> = {
    success: 3500,
    error: 7000,
    warning: 5000,
    info: 3000,
    loading: 0,
  };
  const n = new Notice(message, durationMs ?? defaultDur[type]);
  n.noticeEl.addClass("ai-hub-notice", `ai-hub-notice-${type}`);
  return n;
}

// === БЫСТРЫЙ ВВОД ===
function promptUser(
  app: App,
  placeholder: string,
  opts?: {
    mode?: Mode;
    selectionPreview?: string;
    modelName?: string;
    lastPrompt?: string;
  },
): Promise<string | null> {
  return new Promise((resolve) => {
    new SimplePromptModal(app, placeholder, resolve, opts).open();
  });
}

class SimplePromptModal extends Modal {
  private resolve: (result: string | null) => void;
  private placeholder: string;
  private resolved = false;
  private readonly maxLength = 2000;
  private opts: {
    mode?: Mode;
    selectionPreview?: string;
    modelName?: string;
    lastPrompt?: string;
  };

  constructor(
    app: App,
    placeholder: string,
    resolve: (result: string | null) => void,
    opts?: {
      mode?: Mode;
      selectionPreview?: string;
      modelName?: string;
      lastPrompt?: string;
    },
  ) {
    super(app);
    this.placeholder = placeholder;
    this.resolve = resolve;
    this.opts = opts ?? {};
    this.modalEl.addClass("ai-hub-prompt-modal");
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    // ── Шапка: иконка + заголовок + бейдж модели ──────────────────
    const header = contentEl.createDiv({ cls: "ai-hub-prompt-header" });

    const titleDiv = header.createDiv({ cls: "ai-hub-prompt-title" });
    const iconSpan = titleDiv.createSpan({ cls: "ai-hub-accent-icon" });
    let titleText = "AI Запрос";
    let iconName = "sparkles";
    if (this.opts.mode === "selection") {
      titleText = "Обработать выделение";
      iconName = "text-cursor";
    } else if (this.opts.mode === "vault") {
      titleText = "Запрос по хранилищу";
      iconName = "database";
    }
    setIcon(iconSpan, iconName);
    titleDiv.createSpan({ text: titleText });

    if (this.opts.modelName) {
      const shortName =
        this.opts.modelName.split("/").pop() ?? this.opts.modelName;
      const badge = header.createSpan({ cls: "ai-hub-model-badge" });
      badge.setText(shortName);
      badge.setAttribute("title", this.opts.modelName);
    }

    // ── Сниппет выделенного текста ─────────────────────────────────
    if (this.opts.selectionPreview?.trim()) {
      const preview = contentEl.createDiv({ cls: "ai-hub-context-preview" });
      preview.setText(
        this.opts.selectionPreview.trim().slice(0, 160) +
        (this.opts.selectionPreview.length > 160 ? "…" : ""),
      );
    }

    // ── Quick chips ────────────────────────────────────────────────
    const chipsData =
      this.opts.mode === "selection"
        ? [
          "Улучши стиль",
          "Сократи",
          "Объясни",
          "Переведи на EN",
          "Исправь ошибки",
        ]
        : ["Добавь резюме", "Дополни идеи", "Структурируй", "Добавь теги"];

    const chipsRow = contentEl.createDiv({ cls: "ai-hub-chips" });
    for (const action of chipsData) {
      const chip = chipsRow.createEl("button", {
        cls: "ai-hub-chip",
        text: action,
      });
      chip.setAttribute("type", "button");
      chip.addEventListener("click", () => this.submit(action));
    }

    // ── Textarea ───────────────────────────────────────────────────
    const textarea = contentEl.createEl("textarea", {
      cls: "ai-hub-prompt-textarea",
      attr: {
        placeholder: this.placeholder,
        rows: "4",
        maxlength: String(this.maxLength),
        "aria-label": "Введите запрос к AI",
        "aria-multiline": "true",
      },
    });
    if (this.opts.lastPrompt) {
      textarea.value = this.opts.lastPrompt;
    }

    // ── Счётчик символов ──────────────────────────────────────────
    const charRow = contentEl.createDiv({ cls: "ai-hub-char-row" });
    const updateCounter = () => {
      const len = textarea.value.length;
      charRow.setText(`${len} / ${this.maxLength}`);
      charRow.toggleClass("ai-hub-char-warn", len > this.maxLength * 0.85);
    };
    updateCounter();
    textarea.addEventListener("input", updateCounter);

    // ── Footer: подсказка + кнопки ────────────────────────────────
    const footer = contentEl.createDiv({ cls: "ai-hub-prompt-footer" });

    const hint = footer.createSpan({ cls: "ai-hub-hint" });
    hint.setText("⌘/Ctrl+Enter — отправить · Esc — отмена");

    const btnGroup = footer.createDiv({ cls: "ai-hub-btn-group" });

    new ButtonComponent(btnGroup)
      .setButtonText("Отмена")
      .onClick(() => this.submit(null));

    new ButtonComponent(btnGroup)
      .setIcon("send")
      .setButtonText("Отправить")
      .setTooltip("Ctrl+Enter")
      .setCta()
      .onClick(() => this.submit(textarea.value));

    // ── Фокус и клавиши ───────────────────────────────────────────
    setTimeout(() => {
      textarea.focus();
      if (this.opts.lastPrompt) textarea.select();
    }, 50);

    textarea.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        this.submit(textarea.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.submit(null);
      }
    });
  }

  private submit(value: string | null) {
    if (this.resolved) return;
    this.resolved = true;
    const trimmed = value?.trim() || null;
    this.resolve(trimmed);
    this.close();
  }

  onClose() {
    if (!this.resolved) {
      this.resolved = true;
      this.resolve(null);
    }
    this.contentEl.empty();
  }
}

// === БАТЧ-МОДАЛКА ===
export class BatchProcessModal extends Modal {
  plugin: AIHubPlugin;
  filterFolder = "";
  filterTags = "";
  filterDateFrom = "";
  filterDateTo = "";
  private countElement: HTMLElement | null = null;
  private previewListEl: HTMLElement | null = null;
  private previewToggleIconEl: HTMLElement | null = null;
  private filterPillsEl: HTMLElement | null = null;
  private previewOpen = false;

  constructor(app: App, plugin: AIHubPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ai-hub-modal-content");

    this.renderHeader(contentEl);
    this.renderFilters(contentEl);
    this.renderPresets(contentEl);
    this.renderCustomPrompt(contentEl);
    this.renderFooter(contentEl);

    this.updateCount();
  }

  private renderHeader(container: HTMLElement) {
    const header = container.createDiv({ cls: "ai-hub-modal-header" });

    const h2 = header.createEl("h2", { cls: "ai-hub-modal-h2" });

    const titleRow = h2.createDiv({ cls: "ai-hub-title-row" });
    const iconSpan = titleRow.createSpan({ cls: "ai-hub-accent-icon" });
    setIcon(iconSpan, "package");
    titleRow.createSpan({ text: "Массовая обработка" });

    // Живой счётчик прямо в шапке
    this.countElement = h2.createSpan({
      cls: "ai-hub-count-live empty",
      text: "0 заметок",
    });

    header.createEl("p", {
      text: "Шаг 1: настрой фильтры · Шаг 2: выбери действие",
    });
  }

  private renderFilters(container: HTMLElement) {
    // Шаг 1 лейбл
    const stepLabel = container.createDiv({ cls: "ai-hub-step-label" });
    stepLabel.createSpan({ text: "Шаг 1 — Фильтры" });

    const filtersDiv = container.createDiv({ cls: "ai-hub-filters" });

    const addIconedSetting = (name: string, icon: string): Setting => {
      const s = new Setting(filtersDiv).setName("");
      const nameEl = s.nameEl;
      const iconSpan = nameEl.createSpan({ cls: "ai-hub-accent-icon" });
      setIcon(iconSpan, icon);
      nameEl.createSpan({ text: ` ${name}` });
      return s;
    };

    addIconedSetting("Папка", "folder").addDropdown((dropdown) => {
      dropdown.addOption("", "Все папки");
      for (const folder of this.collectFolders()) {
        dropdown.addOption(folder, folder);
      }
      dropdown.setValue(this.filterFolder);
      dropdown.onChange((v) => {
        this.filterFolder = v;
        this.updateCount();
      });
    });

    addIconedSetting("Теги", "tag").addText((text) => {
      text.inputEl.setAttribute("aria-label", "Теги через запятую");
      text
        .setPlaceholder("tag1, tag2")
        .setValue(this.filterTags)
        .onChange((v) => {
          this.filterTags = v;
          this.updateCount();
        });
    });

    addIconedSetting("С", "calendar").addText((text) => {
      text.inputEl.type = "date";
      text.setValue(this.filterDateFrom).onChange((v) => {
        this.filterDateFrom = v;
        this.updateCount();
      });
    });

    addIconedSetting("По", "calendar").addText((text) => {
      text.inputEl.type = "date";
      text.setValue(this.filterDateTo).onChange((v) => {
        this.filterDateTo = v;
        this.updateCount();
      });
    });

    // Активные пилюли фильтров
    this.filterPillsEl = container.createDiv({ cls: "ai-hub-filter-pills" });

    // Превью файлов (сворачиваемое)
    const previewWrap = container.createDiv({ cls: "ai-hub-file-preview" });
    const toggle = previewWrap.createDiv({ cls: "ai-hub-preview-toggle" });
    this.previewToggleIconEl = toggle.createSpan({
      cls: "ai-hub-preview-icon",
    });
    setIcon(this.previewToggleIconEl, "chevron-right");
    toggle.createSpan({ text: "Показать файлы" });

    this.previewListEl = previewWrap.createDiv({ cls: "ai-hub-preview-list" });
    this.previewListEl.addClass("ai-hub-hidden");

    toggle.addEventListener("click", () => {
      this.previewOpen = !this.previewOpen;
      if (this.previewListEl) {
        this.previewListEl.toggleClass("ai-hub-hidden", !this.previewOpen);
      }
      if (this.previewToggleIconEl) {
        this.previewToggleIconEl.classList.toggle("open", this.previewOpen);
        setIcon(
          this.previewToggleIconEl,
          this.previewOpen ? "chevron-down" : "chevron-right",
        );
      }
      // Обновляем список только при открытии
      if (this.previewOpen) this.renderPreviewList();
    });
  }

  private renderPreviewList() {
    if (!this.previewListEl) return;
    this.previewListEl.empty();
    const files = this.getFilesToProcess();
    const MAX_SHOW = 30;
    files.slice(0, MAX_SHOW).forEach((f) => {
      this.previewListEl!.createDiv({
        cls: "ai-hub-preview-item",
        text: f.path,
      });
    });
    if (files.length > MAX_SHOW) {
      this.previewListEl.createDiv({
        cls: "ai-hub-preview-more",
        text: `…и ещё ${files.length - MAX_SHOW} файлов`,
      });
    }
    if (files.length === 0) {
      this.previewListEl.createDiv({
        cls: "ai-hub-preview-more",
        text: "Нет файлов, подходящих под фильтры",
      });
    }
  }

  private collectFolders(): string[] {
    const folderSet = new Set<string>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const parts = f.path.split("/");
      if (parts.length <= 1) continue;
      let cur = "";
      for (let i = 0; i < parts.length - 1; i++) {
        cur = cur ? `${cur}/${parts[i]}` : parts[i];
        if (!cur.startsWith(".")) folderSet.add(cur);
      }
    }
    return Array.from(folderSet).sort();
  }

  private renderPresets(container: HTMLElement) {
    const stepLabel = container.createDiv({ cls: "ai-hub-step-label" });
    stepLabel.createSpan({ text: "Шаг 2 — Выберите действие" });
    const grid = container.createDiv({ cls: "ai-hub-grid" });

    BATCH_PRESETS.forEach((p: BatchPreset) => {
      const card = grid.createDiv({ cls: "ai-hub-card" });
      card.setAttribute("tabindex", "0");
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", `Пресет: ${p.title} — ${p.desc}`);

      const iconDiv = card.createDiv({ cls: "ai-hub-card-icon" });
      setIcon(iconDiv, p.icon);

      card.createDiv({ text: p.title, cls: "ai-hub-card-title" });
      card.createDiv({ text: p.desc, cls: "ai-hub-card-desc" });

      card.addEventListener("click", () => {
        void this.confirmAndRun(p.prompt, p.title);
      });
      card.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void this.confirmAndRun(p.prompt, p.title);
        }
      });
    });
  }

  private renderCustomPrompt(container: HTMLElement) {
    const stepLabel = container.createDiv({ cls: "ai-hub-step-label" });
    stepLabel.createSpan({ text: "или свой промпт" });
    const customArea = container.createDiv({ cls: "ai-hub-custom-prompt" });

    const textarea = customArea.createEl("textarea", {
      attr: {
        placeholder: "Введите инструкцию для AI...",
        "aria-label": "Собственный промпт для обработки заметок",
        rows: "3",
      },
    });

    new Setting(customArea).addButton((btn) =>
      btn
        .setButtonText("Запустить")
        .setIcon("play")
        .setCta()
        .onClick(() => {
          const v = textarea.value.trim();
          if (v) void this.confirmAndRun(v, "Custom");
          else notify("warning", "Введите промпт для обработки");
        }),
    );
  }

  private renderFooter(container: HTMLElement) {
    const footer = container.createDiv({ cls: "ai-hub-footer-row" });
    new ButtonComponent(footer)
      .setButtonText("Закрыть")
      .setIcon("x")
      .onClick(() => this.close());
  }

  getFilesToProcess(): TFile[] {
    const tagsToFind = this.filterTags.trim()
      ? this.filterTags
        .split(",")
        .map((t) => t.trim().toLowerCase().replace(/^#/, ""))
        .filter(Boolean)
      : [];
    const dateFromTs = this.filterDateFrom
      ? new Date(this.filterDateFrom).getTime()
      : null;
    const dateToTs = this.filterDateTo
      ? new Date(this.filterDateTo).getTime() + 86_400_000
      : null;
    const targetFolder = this.filterFolder.trim()
      ? this.filterFolder.endsWith("/")
        ? this.filterFolder
        : this.filterFolder + "/"
      : "";

    return this.app.vault.getMarkdownFiles().filter((file) => {
      const path = file.path;
      if (path.startsWith(".") || path.startsWith("templates/")) return false;

      if (targetFolder && !path.startsWith(targetFolder)) return false;

      if (tagsToFind.length) {
        const cache = this.app.metadataCache.getFileCache(file);
        const fileTags =
          cache?.tags?.map((t) => t.tag.toLowerCase().replace(/^#/, "")) ?? [];
        if (!tagsToFind.some((t) => fileTags.includes(t))) return false;
      }

      if (dateFromTs !== null && file.stat.mtime < dateFromTs) return false;
      if (dateToTs !== null && file.stat.mtime > dateToTs) return false;

      return true;
    });
  }

  updateCount() {
    const files = this.getFilesToProcess();
    const n = files.length;

    // Живой счётчик в шапке
    if (this.countElement) {
      this.countElement.setText(
        n === 0
          ? "0 заметок"
          : `${n} ${n === 1 ? "заметка" : n < 5 ? "заметки" : "заметок"}`,
      );
      this.countElement.classList.toggle("empty", n === 0);
    }

    // Пилюли активных фильтров
    if (this.filterPillsEl) {
      this.filterPillsEl.empty();
      if (this.filterFolder) {
        const pill = this.filterPillsEl.createSpan({
          cls: "ai-hub-filter-pill",
        });
        const ic = pill.createSpan();
        setIcon(ic, "folder");
        pill.createSpan({ text: this.filterFolder });
      }
      if (this.filterTags.trim()) {
        const pill = this.filterPillsEl.createSpan({
          cls: "ai-hub-filter-pill",
        });
        const ic = pill.createSpan();
        setIcon(ic, "tag");
        pill.createSpan({ text: this.filterTags });
      }
      if (this.filterDateFrom || this.filterDateTo) {
        const pill = this.filterPillsEl.createSpan({
          cls: "ai-hub-filter-pill",
        });
        const ic = pill.createSpan();
        setIcon(ic, "calendar");
        const range = [this.filterDateFrom, this.filterDateTo]
          .filter(Boolean)
          .join(" — ");
        pill.createSpan({ text: range });
      }
    }

    // Обновляем превью если оно открыто
    if (this.previewOpen) this.renderPreviewList();
  }

  private async confirmAndRun(prompt: string, actionName: string) {
    const files = this.getFilesToProcess();
    if (files.length === 0) {
      notify("warning", "Нет заметок под эти фильтры");
      return;
    }
    this.close();

    const confirmed = await this.askConfirm(prompt, actionName, files.length);
    if (confirmed) await this.plugin.runBatchProcessing(files, prompt);
  }

  private askConfirm(
    prompt: string,
    actionName: string,
    count: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new Modal(this.app);
      modal.titleEl.setText("Подтверждение");
      const c = modal.contentEl;

      c.createEl("p", {
        text: `Действие: ${actionName}`,
        cls: "ai-hub-confirm-title",
      });
      c.createEl("p", {
        text: `Файлов: ${count}`,
        cls: "ai-hub-confirm-count",
      });

      const box = c.createDiv({ cls: "ai-hub-query-box" });
      box.setText(prompt);

      c.createDiv({
        text: "Заметки будут изменены. Автобекап сохраняется в .ai-backup-*",
        cls: "ai-hub-warning",
      });

      let done = false;
      const btns = c.createDiv({ cls: "modal-button-container" });
      new ButtonComponent(btns)
        .setButtonText("Отмена")
        .setIcon("x")
        .onClick(() => {
          done = true;
          resolve(false);
          modal.close();
        });
      new ButtonComponent(btns)
        .setButtonText("Запустить")
        .setIcon("play")
        .setCta()
        .onClick(() => {
          done = true;
          resolve(true);
          modal.close();
        });

      modal.onClose = () => {
        if (!done) resolve(false);
      };
      modal.open();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Модальное окно выбора режима аудита
// ─────────────────────────────────────────────────────────────────────
class AuditModeModal extends Modal {
  private index: NoteIndexManager;
  private files: TFile[] = [];
  private statsEl: HTMLElement | null = null;

  constructor(
    app: App,
    private plugin: AIHubPlugin,
  ) {
    super(app);
    this.index = new NoteIndexManager(app);
  }

  async onOpen() {
    this.titleEl.setText("Аудит хранилища");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ai-hub-modal-content");

    // Шапка
    const header = contentEl.createDiv({ cls: "ai-hub-modal-header" });
    const h2 = header.createEl("h2");
    const iconSpan = h2.createSpan({ cls: "ai-hub-accent-icon" });
    setIcon(iconSpan, "microscope");
    h2.createSpan({ text: "Выберите режим аудита" });
    header.createEl("p", {
      text: "Каждый режим оптимизирован под свою задачу",
    });

    // Загружаем индекс и считаем статистику
    await this.index.load();
    this.files = this.app.vault.getMarkdownFiles().filter((f) => {
      const p = f.path.toLowerCase();
      return (
        !p.startsWith(".obsidian/") &&
        !p.startsWith("templates/") &&
        !p.startsWith(".ai-backup")
      );
    });

    const stats = this.index.stats(this.files);

    // Блок текущего состояния индекса
    const statusCard = contentEl.createDiv({ cls: "ai-hub-status-card" });

    const statusRow = statusCard.createDiv({ cls: "ai-hub-index-status-row" });
    const sIcon = statusRow.createSpan({ cls: "ai-hub-accent-color" });
    setIcon(sIcon, "database");
    statusRow.createSpan({ text: "Состояние индекса" });

    const grid = statusCard.createDiv({ cls: "ai-hub-stat-grid" });

    const addStat = (label: string, value: string | number, color?: string) => {
      const row = grid.createDiv({ cls: "ai-hub-stat-grid-row" });
      row.createSpan({ text: label });
      const val = row.createSpan({ text: String(value) });
      if (color) {
        val.addClass("ai-hub-stat-val-colored");
        val.setCssProps({ "--ai-stat-color": color });
      } else {
        val.addClass("ai-hub-stat-val");
      }
    };

    addStat("Всего заметок", stats.total);
    addStat(
      "В индексе (актуальные)",
      stats.fresh,
      "var(--color-green,#4caf50)",
    );
    addStat(
      "Изменились",
      stats.stale,
      stats.stale > 0 ? "var(--text-warning,orange)" : undefined,
    );
    addStat(
      "Новые (не в индексе)",
      stats.unseen,
      stats.unseen > 0 ? "var(--interactive-accent)" : undefined,
    );
    addStat("Последний запуск", this.index.getUpdatedAt());

    // Карточки режимов
    const modesGrid = contentEl.createDiv({ cls: "ai-hub-grid" });

    // ── BATCH режим ──────────────────────────────────────────────────
    const batchToProcess = stats.stale + stats.unseen;
    // this.createModeCard(modesGrid, {
    //   icon: "layers",
    //   title: "Batch Аудит",
    //   badge:
    //     batchToProcess > 0 ? `${batchToProcess} к обработке` : "Всё актуально",
    //   badgeColor:
    //     batchToProcess > 0
    //       ? "var(--interactive-accent)"
    //       : "var(--color-green,#4caf50)",
    //   lines: [
    //     `По ${this.plugin.settings.deepAudit.batchSize} файлов за запрос`,
    //     "Параллельные запросы к API",
    //     "Инкрементальный (пропускает кэш)",
    //     "Финальный отчёт + Canvas-карта",
    //   ],
    //   speed: "Быстрый",
    //   context: "~4 000 симв./файл",
    //   onClick: () => {
    //     this.close();
    //     void this.plugin.runDeepVaultAudit();
    //   },
    // });

    // ── SINGLE режим ─────────────────────────────────────────────────
    const singleToProcess = this.index.getStaleFiles(this.files).length;
    const estMinSingle = Math.ceil(
      (singleToProcess * (this.plugin.settings.deepAudit.delayMs + 5000)) /
      60000,
    );

    this.createModeCard(modesGrid, {
      icon: "scan-text",
      title: "Single Аудит",
      badge: `~${estMinSingle} мин`,
      badgeColor: "var(--text-muted)",
      lines: [
        "По одной заметке за запрос",
        "Максимальный контекст файла",
        "Детальный анализ каждой заметки",
        "Обновляет индекс по ходу",
      ],
      speed: "Медленный",
      context: "~15 000 симв./файл",
      onClick: () => {
        this.close();
        void this.plugin.runSingleAudit(this.index, true);
      },
    });

    // ── SINGLE (полный пересчёт) ──────────────────────────────────────
    this.createModeCard(modesGrid, {
      icon: "refresh-cw",
      title: "Single — Полный",
      badge: `${this.files.length} файлов`,
      badgeColor: "var(--text-muted)",
      lines: [
        "Анализирует ВСЕ заметки",
        "Игнорирует кэш",
        "Для первого запуска или сброса",
        "Занимает больше всего времени",
      ],
      speed: "Очень медленный",
      context: "~15 000 симв./файл",
      onClick: () => {
        this.close();
        void this.plugin.runSingleAudit(this.index, false);
      },
    });

    // ── Batch + финальный синтез ─────────────────────────────────────
    this.createModeCard(modesGrid, {
      icon: "brain",
      title: "Batch + Отчёт",
      badge: "Рекомендуется",
      badgeColor: "var(--interactive-accent)",
      lines: [
        "Batch анализ с кластеризацией",
        "Глобальные инсайты по базе",
        "Markdown-отчёт + Canvas",
        "Полный MapReduce pipeline",
      ],
      speed: "Средний",
      context: "~4 000 симв./файл",
      onClick: () => {
        this.close();
        void this.plugin.runDeepVaultAudit();
      },
    });
  }

  private createModeCard(
    container: HTMLElement,
    opts: {
      icon: string;
      title: string;
      badge: string;
      badgeColor: string;
      lines: string[];
      speed: string;
      context: string;
      onClick: () => void;
    },
  ): void {
    const card = container.createDiv({ cls: "ai-hub-card" });
    card.setAttribute("tabindex", "0");
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Режим: ${opts.title}`);

    // Иконка + заголовок
    const topRow = card.createDiv({ cls: "ai-hub-card-top" });
    const iconEl = topRow.createDiv({ cls: "ai-hub-card-icon" });
    setIcon(iconEl, opts.icon);

    const badge = topRow.createSpan({
      text: opts.badge,
      cls: "ai-hub-card-badge",
    });
    badge.setCssProps({ "--ai-badge-color": opts.badgeColor });

    card.createDiv({ text: opts.title, cls: "ai-hub-card-title" });

    // Список особенностей
    const ul = card.createEl("ul", { cls: "ai-hub-card-ul" });
    for (const line of opts.lines) {
      ul.createEl("li", { text: line });
    }

    // Метаданные скорость/контекст
    const meta = card.createDiv({ cls: "ai-hub-card-meta" });
    const sp = meta.createSpan({ text: "⚡ " + opts.speed });
    const ct = meta.createSpan({ text: "📄 " + opts.context });
    void sp;
    void ct;

    card.addEventListener("click", opts.onClick);
    card.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        opts.onClick();
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

// Алиас для совместимости
export const AIHubPanelModal = BatchProcessModal;