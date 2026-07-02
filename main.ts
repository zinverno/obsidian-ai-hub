import { t as tr, setLanguage, dateLocale } from "./i18n";
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
  DeepAuditConfig,
  DEFAULT_DEEP_AUDIT_CONFIG,
  SingleAuditEngine,
  SingleAuditProgressModal,
  SingleAuditReport,
} from "./deepAudit";
import { NoteIndexManager } from "./noteIndex";

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
      setLanguage(this.settings.language ?? "auto");

      this.addRibbonIcon("sparkles", tr("AI Hub: Панель управления"), () => {
        new BatchProcessModal(this.app, this).open();
      });

      this.addCommand({
        id: "ai-hub-open-panel",
        name: tr("Открыть панель управления"),
        callback: () => new BatchProcessModal(this.app, this).open(),
      });

      this.addCommand({
        id: "ai-deep-vault-audit",
        name: tr("Глубокий аудит — выбор режима"),
        callback: () => {
          void this.openAuditModeModal();
        },
      });

      this.addCommand({
        id: "ai-simple-append",
        name: tr("AI: Простое дополнение"),
        editorCallback: (e) => {
          void this.runAIStream(e, "simple");
        },
      });

      this.addCommand({
        id: "ai-vault-append",
        name: tr("AI: Умное дополнение (Vault)"),
        editorCallback: (e) => {
          void this.runAIStream(e, "vault");
        },
      });

      this.addCommand({
        id: "ai-selection",
        name: tr("AI: Обработать выделение"),
        editorCheckCallback: (checking, e) => {
          if (!e.getSelection()?.trim()) return false;
          if (!checking) void this.runAIStream(e, "selection");
          return true;
        },
      });

      this.addCommand({
        id: "ai-dataview-generate",
        name: tr("AI: Создать Dataview"),
        editorCallback: (e) => {
          void this.generateDataview(e);
        },
      });

      this.addCommand({
        id: "ai-flashcards-note",
        name: tr("Сгенерировать флешкарты для текущей заметки"),
        editorCallback: (_e, view) => {
          if (view.file) void this.generateFlashcardsForNote(view.file);
        },
      });

      this.addCommand({
        id: "ai-vault-audit",
        name: tr("Проанализировать структуру хранилища"),
        callback: () => {
          void this.runVaultAudit();
        },
      });

      this.addCommand({
        id: "ai-batch-process",
        name: tr("AI: Обработать несколько заметок"),
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
      new Notice(tr("❌ Ошибка загрузки AI Hub: {msg}", { msg }));
    }
  }
  async loadSettings() {
    const data = (await this.loadData()) as Partial<AIHubSettings> | null;
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
      const cfg = this.app.vault.configDir.toLowerCase() + "/";
      return (
        !p.startsWith(cfg) &&
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
        tr("✅ Глубокий аудит завершён за {s}с", { s: Math.round(report.durationMs / 1000) }),
      );
    } catch (err) {
      progressModal.close();
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes(tr("Отменено"))) {
        new Notice(tr("⏹ Аудит отменён"));
      } else {
        new Notice(tr("❌ Ошибка аудита: {msg}", { msg }));
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
        tr(tr("✅ Single аудит завершён!")),
        tr("Проанализировано: {n}", { n: report.processedFiles }),
        tr("Пропущено (кэш): {n}", { n: report.skippedFiles }),
        tr("Ошибок: {n}", { n: report.failedFiles }),
        tr("Время: {s}с", { s: Math.round(report.durationMs / 1000) }),
      ].join("\n");

      new Notice(msg, 8000);
    } catch (err) {
      progressModal.close();
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes(tr("Отменено")) || msg.includes("abort")) {
        new Notice(tr("⏹ Аудит остановлен"));
      } else {
        new Notice(tr("❌ Ошибка Single аудита: {msg}", { msg }));
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
      modal.titleEl.setText(tr("🔬 Глубокий аудит хранилища"));
      const c = modal.contentEl;

      c.createEl("p", {
        text: tr("Эта операция прочитает содержимое каждой заметки и отправит пакетами в ЛЛМ для детального анализа."),
      });

      const stats = c.createDiv({ cls: "ai-hub-query-box" });
      const statsData: Array<{ icon: string; label: string; value: string }> = [
        { icon: "file-text", label: tr("Файлов"), value: String(fileCount) },
        { icon: "zap", label: tr("Запросов к API"), value: `~${requests}` },
        { icon: "clock", label: tr("Примерное время"), value: `~${minutes} мин` },
      ];
      statsData.forEach(({ icon, label, value }) => {
        const row = stats.createDiv({ cls: "ai-hub-cost-row" });
        const iconEl = row.createSpan({ cls: "ai-hub-cost-icon" });
        setIcon(iconEl, icon);
        row.createSpan({ text: `${label}: `, cls: "ai-hub-cost-label" });
        row.createSpan({ text: value, cls: "ai-hub-cost-val" });
      });
      stats.createDiv({
        text: tr("Стоимость зависит от вашего провайдера и тарифа"),
        cls: "ai-hub-cost-note",
      });

      c.createDiv({
        text: tr("На бесплатном тире OpenRouter возможны ошибки rate-limit. Ничего в хранилище не изменяется."),
        cls: "ai-hub-warning",
      });

      let done = false;
      const btns = c.createDiv({ cls: "modal-button-container" });
      new ButtonComponent(btns)
        .setButtonText(tr("Отмена"))
        .setIcon("x")
        .onClick(() => {
          done = true;
          resolve(false);
          modal.close();
        });
      new ButtonComponent(btns)
        .setButtonText(tr("Начать анализ"))
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
      .toLocaleString(dateLocale())
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
            ? "\n" + tr("  - _...и ещё {n} файлов_", { n: c.filePaths.length - 20 })
            : "";
        return tr("@deep_cluster", {
          name: c.name,
          desc: c.description,
          count: c.fileCount,
          moc: c.suggestedMOC,
          files,
          more,
        });
      })
      .join("\n\n---\n\n");

    const content = tr("@deep_report", {
      iso: new Date().toISOString(),
      duration: durationStr,
      processed: report.processedFiles,
      failed: report.failedFiles,
      total: report.totalFiles,
      nclusters: report.clusters.length,
      clustersMd,
      insights: report.globalInsights,
      actionPlan: report.actionPlan,
    });

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

    const nodes: Record<string, unknown>[] = [
      {
        id: "center",
        type: "text",
        text: tr("@deep_canvas_center", {
          date: new Date().toLocaleDateString(dateLocale()),
          n: report.processedFiles,
          c: report.clusters.length,
        }),
        x: 0,
        y: 0,
        width: 400,
        height: 250,
        color: "4",
      },
    ];

    const edges: Record<string, unknown>[] = [];
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
      mode === "vault" ? tr("Запрос для поиска:") : tr("Что добавить/изменить?"),
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

    const loadingNotice = notify("loading", tr("AI думает и пишет..."));

    try {
      const { system, user } = this.buildPrompts(editor, mode, prompt);

      if (target === "clipboard") {
        const fullRes = await callOpenRouter(this.settings, system, user);
        await navigator.clipboard.writeText(fullRes);
        loadingNotice.hide();
        notify("success", tr("Скопировано в буфер"));
        return;
      }

      if (target === "new") {
        await this.streamToNewNote(system, user, prompt);
        loadingNotice.hide();
        notify("success", tr("Новая заметка создана"));
        return;
      }

      await this.prepareInsertionPoint(editor, target);
      await this.streamIntoEditor(editor, target, system, user);

      loadingNotice.hide();
      notify("success", tr("Готово"));
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
          tr("Ты — редактор. Обработай текст по инструкции. Верни ТОЛЬКО результат без пояснений. Не повторяй фразы. Остановись когда задача выполнена."),
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
        tr("Ты — ассистент для заметок Obsidian. ") +
        tr("Дополни заметку согласно задаче. ") +
        tr("НИКОГДА не повторяй уже написанный текст. ") +
        tr("Остановись когда задача выполнена, не продолжай бесконечно."),
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
      throw new Error(tr("Не удалось получить редактор новой заметки"));

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
            .setTitle(tr(INSERTION_LABELS[opt]))
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
        const ed = editor as unknown as {
          coordsAtPos(ch: number): { left: number; top: number } | null;
        };
        const pos = ed.coordsAtPos(cursor.ch);
        if (pos) {
          menu.showAtPosition({ x: pos.left, y: pos.top });
          return;
        }
      } catch {
        /* fallback ниже */
      }

      const rect = activeDocument.body.getBoundingClientRect();
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

    const p = await promptUser(this.app, tr("Что показать?"));
    if (!p) return;

    const notice = notify("loading", tr("Генерирую Dataview..."));
    try {
      const r = await callOpenRouter(
        this.settings,
        tr("Только код dataview. Начинай с TABLE/LIST/TASK/CALENDAR. Без markdown-обёртки."),
        `Запрос: ${p}`,
        { maxTokens: MAX_TOKENS_DATAVIEW },
      );
      const cleaned = r
        .replace(/```[a-zA-Z]*\n?/g, "")
        .replace(/```/g, "")
        .trim()
        .replace(/^dataview\s*/i, "");

      if (!/^(TABLE|LIST|TASK|CALENDAR|FROM)/i.test(cleaned)) {
        throw new Error(tr("Некорректный ответ AI"));
      }
      editor.replaceSelection(`\n\`\`\`dataview\n${cleaned}\n\`\`\`\n`);
      notice.hide();
      notify("success", tr("Dataview создан"));
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
        item.setTitle("AI Hub").setIcon("sparkles") as unknown as {
          setSubmenu(): Menu;
        }
      ).setSubmenu();

      submenu.addItem((sub) =>
        sub
          .setTitle(tr("Улучшить стиль"))
          .setIcon("sparkles")
          .onClick(() => this.quickAction(editor, sel, tr("Улучши стиль"))),
      );
      submenu.addItem((sub) =>
        sub
          .setTitle(tr("Сократить"))
          .setIcon("minimize-2")
          .onClick(() => this.quickAction(editor, sel, tr("Сократи"))),
      );
      submenu.addItem((sub) =>
        sub
          .setTitle(tr("Перефразировать"))
          .setIcon("refresh-cw")
          .onClick(() => this.quickAction(editor, sel, tr("Перефразируй"))),
      );
      submenu.addItem((sub) =>
        sub
          .setTitle(tr("Создать Dataview"))
          .setIcon("table")
          .onClick(() => this.generateDataview(editor)),
      );
      submenu.addItem((sub) =>
        sub
          .setTitle(tr("Флешкарты"))
          .setIcon("layers")
          .onClick(() => {
            const file = this.app.workspace.getActiveFile();
            if (file) void this.generateFlashcardsForNote(file);
          }),
      );
    });
  }

  async quickAction(editor: Editor, sel: string, action: string) {
    if (!sel.trim()) {
      new Notice(tr("Сначала выделите текст"));
      return;
    }
    const notice = new Notice(tr("🤖 Думаю..."), 0);
    try {
      const r = await callOpenRouter(
        this.settings,
        tr("Верни только результат, без пояснений."),
        `Текст:\n${sel}\n\nИнструкция: ${action}`,
        { maxTokens: MAX_TOKENS_BATCH },
      );
      const cleaned = r
        .replace(/```[a-zA-Z]*\n?/g, "")
        .replace(/```/g, "")
        .trim();
      editor.replaceSelection(cleaned);
      notice.hide();
      new Notice(tr("✅ Готово"));
    } catch (err) {
      notice.hide();
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`❌ Ошибка: ${msg}`);
    }
  }

  // === Аудит хранилища ===
  async runVaultAudit() {
    const progressModal = new ProgressModal(this.app, tr("Анализ хранилища"));
    progressModal.open();

    const allFiles = this.app.vault.getMarkdownFiles().filter((file) => {
      const path = file.path.toLowerCase();
      const cfg = this.app.vault.configDir.toLowerCase() + "/";
      return (
        !path.startsWith(cfg) &&
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

      if (i % 40 === 0) await new Promise((r) => window.setTimeout(r, 1));
    }

    progressModal.close();

    if (snapshot.length > VAULT_SNAPSHOT_MAX_CHARS) {
      new Notice(tr("Хранилище большое — данные для API обрезаны."));
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

    const stateStr = isChaos
      ? tr(tr("ХАОС (нужна первичная структура)"))
      : tr(tr("ЕСТЬ СТРУКТУРА (нужна оптимизация)"));
    const auditPrompt = tr("@audit_prompt", {
      total: stats.total,
      withTags: stats.withTags,
      orphans: stats.orphaned,
      state: stateStr,
      snapshot,
    });

    await this.generateFinalReport(auditPrompt, stats, topFolders, topTags);
  }

  private async generateFinalReport(
    prompt: string,
    stats: VaultAuditStats,
    folders: Array<[string, number]>,
    tags: Array<[string, number]>,
  ) {
    const notice = new Notice(tr("ИИ формирует дашборд..."), 0);
    try {
      const aiAdvice = await callOpenRouter(
        { ...this.settings, temperature: 0.3 },
        tr("Ты эксперт по визуализации знаний в Obsidian."),
        prompt,
        { maxTokens: MAX_TOKENS_AUDIT },
      );

      const dateStr = new Date().toLocaleString(dateLocale()).replace(/[/:]/g, "-");
      const connectivity =
        stats.total > 0
          ? Math.round(((stats.total - stats.orphaned) / stats.total) * 100)
          : 0;

      const statusStr =
        stats.orphaned > stats.total * 0.3
          ? tr(tr("⚠️ Требуется структуризация"))
          : tr(tr("✅ В порядке"));
      const report = tr("@dash_report", {
        iso: new Date().toISOString(),
        total: stats.total,
        conn: connectivity,
        status: statusStr,
        advice: aiAdvice,
        folders: folders
          .map((f) => tr("@folder_line", { name: f[0], n: f[1] }))
          .join("\n"),
        tags: tags.map((x) => `#${x[0].replace("#", "")}`).join(" "),
        orphans: stats.orphaned,
      });

      const reportFile = await this.app.vault.create(
        normalizePath(`Audit-Dashboard-${dateStr}.md`),
        report,
      );
      await this.createAuditCanvas(dateStr, stats, aiAdvice, folders);
      await this.app.workspace.getLeaf().openFile(reportFile);

      notice.hide();
      new Notice(tr("✅ Дашборд и Canvas созданы"));
    } catch (err) {
      notice.hide();
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(tr("❌ Ошибка создания дашборда: {msg}", { msg }));
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
          text: tr("@canvas_stats", { total: stats.total, orphans: stats.orphaned }),
          x: -450,
          y: -100,
          width: 300,
          height: 200,
        },
        {
          id: "advice",
          type: "text",
          text: tr("@canvas_advice", { advice: aiAdvice.slice(0, 1000) + (aiAdvice.length > 1000 ? "..." : "") }),
          x: 0,
          y: 250,
          width: 850,
          height: 400,
        },
        {
          id: "folders",
          type: "text",
          text: tr("@canvas_folders", { folders: folders.map((f) => `- ${f[0]}`).join("\n") }),
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
    const fmTags: unknown = fm?.tags ?? fm?.tag;
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
  async runBatchProcessing(files: TFile[], query: string, append = false) {
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

        let newContent: string;
        if (append) {
          // Флешкарты: модель возвращает ТОЛЬКО карточки, основной текст
          // не трогаем — дописываем отдельной секцией в конец заметки.
          newContent = (await this.buildFlashcardsContent(content, query))
            .newContent;
        } else {
          newContent = await callOpenRouter(
            this.settings,
            tr("Ты — редактор. Верни ТОЛЬКО изменённый текст, без пояснений."),
            `Текст заметки:\n${content}\n\nИнструкция: ${query}\n\nВерни полный изменённый текст.`,
          );
        }

        const backupPath = normalizePath(`${backupFolder}/${file.name}`);
        await this.app.vault.create(backupPath, content).catch(() => {
          /* skip */
        });
        await this.app.vault.modify(file, newContent);

        processed++;
        progress.update(processed, errorCount);
        progress.logSuccess(file.name);

        await new Promise((r) => window.setTimeout(r, BATCH_DELAY_MS));
      } catch (err) {
        errorCount++;
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${file.name}: ${msg}`);
        progress.update(processed, errorCount);
        progress.logError(file.name, msg);
      }
    }

    await new Promise((r) => window.setTimeout(r, 1500));
    progress.close();

    let report = tr("@batch_report", {
      ok: processed,
      err: errorCount,
      backup: backupFolder,
    });
    if (errors.length) {
      report += tr("@batch_errors", {
        list: errors
          .slice(0, 20)
          .map((e) => `- ${e}`)
          .join("\n"),
      });
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

    new Notice(tr("✅ Готово! Успешно: {ok}, ошибок: {err}", { ok: processed, err: errorCount }));
  }

  // === Флешкарты (общая логика для батча и одной заметки) ===
  /**
   * Генерирует карточки по содержимому заметки и собирает новый контент:
   * исходный текст + секция "## Flashcards" с тегом #flashcards в конце.
   */
  async buildFlashcardsContent(
    content: string,
    prompt: string,
  ): Promise<{ newContent: string; cardCount: number }> {
    const raw = await callOpenRouter(this.settings, prompt, content);
    const cards = extractFlashcards(raw);
    if (!cards) throw new Error(tr("Некорректный ответ AI"));
    const newContent = `${content.replace(/\s+$/, "")}\n\n## Flashcards\n#flashcards\n\n${cards}\n`;
    return { newContent, cardCount: cards.split("\n").length };
  }

  async generateFlashcardsForNote(file: TFile) {
    const err = validateSettings(this.settings);
    if (err) {
      new Notice(err);
      return;
    }

    const notice = notify("loading", tr("Генерирую флешкарты..."));
    try {
      const content = await this.app.vault.read(file);
      const { newContent, cardCount } = await this.buildFlashcardsContent(
        content,
        tr("@flashcards_prompt"),
      );
      await this.app.vault.modify(file, newContent);
      notice.hide();
      notify("success", tr("✅ Создано флешкарт: {n}", { n: cardCount }));
    } catch (err) {
      notice.hide();
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`❌ Ошибка: ${msg}`);
    }
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
      text: tr("Сбор данных..."),
    });
    this.text.addClass("ai-hub-status-text");

    this.bar = root.createEl("progress", { cls: "ai-hub-progress-bar" });
    this.bar.setAttribute("aria-label", tr("Прогресс операции"));
    this.bar.max = 100;
    this.bar.value = 0;
  }

  update(current: number, total: number) {
    if (total <= 0) return;
    const percent = Math.round((current / total) * 100);
    this.bar.value = percent;
    this.bar.setAttribute("aria-valuenow", String(percent));
    this.text.setText(tr("Обработано: {cur} / {total} — {pct}%", { cur: current, total, pct: percent }));
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
    this.titleEl.setText(tr("Пакетная обработка"));
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
    this.bar.setAttribute("aria-label", tr("Прогресс обработки заметок"));
    this.bar.max = this.total;
    this.bar.value = 0;

    this.log = root.createDiv({ cls: "ai-hub-progress-log" });
    this.log.setAttribute("role", "log");
    this.log.setAttribute("aria-live", "polite");
    this.log.setAttribute("aria-label", tr("Журнал обработки"));

    const btnRow = root.createDiv({ cls: "ai-hub-progress-btnrow" });
    new Setting(btnRow).addButton((btn) =>
      btn
        .setButtonText(tr("Остановить"))
        .setIcon("square")
        .setWarning()
        .onClick(() => {
          this.isCancelled = true;
          this.spinner.addClass("ai-hub-hidden");
          new Notice(tr("⏹ Остановка после текущей заметки..."));
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

// === ФЛЕШКАРТЫ ===
/**
 * Чистит ответ модели до валидных inline-карточек Spaced Repetition.
 * Оставляет только строки вида «Вопрос::Ответ», срезает нумерацию,
 * маркеры списков, markdown-обёртки и любые вступления/комментарии,
 * которые модель могла добавить вопреки промпту.
 */
function extractFlashcards(raw: string): string {
  return raw
    .replace(/```[a-zA-Z]*\n?/g, "")
    .replace(/```/g, "")
    .split("\n")
    .map((line) => line.trim().replace(/^(?:[-*+•]|\d+[.)])\s+/, "").trim())
    .filter((line) => {
      // Валидная карточка: непустой текст по обе стороны первого "::"
      const sep = line.indexOf("::");
      if (sep === -1) return false;
      return (
        line.slice(0, sep).trim().length > 0 &&
        line.slice(sep + 2).trim().length > 0
      );
    })
    .join("\n")
    .trim();
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
    let titleText = tr("AI Запрос");
    let iconName = "sparkles";
    if (this.opts.mode === "selection") {
      titleText = tr("Обработать выделение");
      iconName = "text-cursor";
    } else if (this.opts.mode === "vault") {
      titleText = tr("Запрос по хранилищу");
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
          tr("Улучши стиль"),
          tr("Сократи"),
          tr("Объясни"),
          tr("Переведи на EN"),
          tr("Исправь ошибки"),
        ]
        : [tr("Добавь резюме"), tr("Дополни идеи"), tr("Структурируй"), tr("Добавь теги")];

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
        "aria-label": tr("Введите запрос к AI"),
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
    hint.setText(tr("⌘/Ctrl+Enter — отправить · Esc — отмена"));

    const btnGroup = footer.createDiv({ cls: "ai-hub-btn-group" });

    new ButtonComponent(btnGroup)
      .setButtonText(tr("Отмена"))
      .onClick(() => this.submit(null));

    new ButtonComponent(btnGroup)
      .setIcon("send")
      .setButtonText(tr("Отправить"))
      .setTooltip("Ctrl+Enter")
      .setCta()
      .onClick(() => this.submit(textarea.value));

    // ── Фокус и клавиши ───────────────────────────────────────────
    window.setTimeout(() => {
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
    titleRow.createSpan({ text: tr("Массовая обработка") });

    // Живой счётчик прямо в шапке
    this.countElement = h2.createSpan({
      cls: "ai-hub-count-live empty",
      text: tr("0 заметок"),
    });

    header.createEl("p", {
      text: tr("Шаг 1: настрой фильтры · Шаг 2: выбери действие"),
    });
  }

  private renderFilters(container: HTMLElement) {
    // Шаг 1 лейбл
    const stepLabel = container.createDiv({ cls: "ai-hub-step-label" });
    stepLabel.createSpan({ text: tr("Шаг 1 — Фильтры") });

    const filtersDiv = container.createDiv({ cls: "ai-hub-filters" });

    const addIconedSetting = (name: string, icon: string): Setting => {
      const s = new Setting(filtersDiv).setName("");
      const nameEl = s.nameEl;
      const iconSpan = nameEl.createSpan({ cls: "ai-hub-accent-icon" });
      setIcon(iconSpan, icon);
      nameEl.createSpan({ text: ` ${name}` });
      return s;
    };

    addIconedSetting(tr("Папка"), "folder").addDropdown((dropdown) => {
      dropdown.addOption("", tr("Все папки"));
      for (const folder of this.collectFolders()) {
        dropdown.addOption(folder, folder);
      }
      dropdown.setValue(this.filterFolder);
      dropdown.onChange((v) => {
        this.filterFolder = v;
        this.updateCount();
      });
    });

    addIconedSetting(tr("Теги"), "tag").addText((text) => {
      text.inputEl.setAttribute("aria-label", tr("Теги через запятую"));
      text
        .setPlaceholder("tag1, tag2")
        .setValue(this.filterTags)
        .onChange((v) => {
          this.filterTags = v;
          this.updateCount();
        });
    });

    addIconedSetting(tr("С"), "calendar").addText((text) => {
      text.inputEl.type = "date";
      text.setValue(this.filterDateFrom).onChange((v) => {
        this.filterDateFrom = v;
        this.updateCount();
      });
    });

    addIconedSetting(tr("По"), "calendar").addText((text) => {
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
    toggle.createSpan({ text: tr("Показать файлы") });

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
        text: tr("Нет файлов, подходящих под фильтры"),
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
    stepLabel.createSpan({ text: tr("Шаг 2 — Выберите действие") });
    const grid = container.createDiv({ cls: "ai-hub-grid" });

    BATCH_PRESETS.forEach((p: BatchPreset) => {
      const card = grid.createDiv({ cls: "ai-hub-card" });
      card.setAttribute("tabindex", "0");
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", `Пресет: ${p.title} — ${p.desc}`);

      const iconDiv = card.createDiv({ cls: "ai-hub-card-icon" });
      setIcon(iconDiv, p.icon);

      card.createDiv({ text: tr(p.title), cls: "ai-hub-card-title" });
      card.createDiv({ text: tr(p.desc), cls: "ai-hub-card-desc" });

      card.addEventListener("click", () => {
        void this.confirmAndRun(tr(p.prompt), tr(p.title), p.append);
      });
      card.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void this.confirmAndRun(tr(p.prompt), tr(p.title), p.append);
        }
      });
    });
  }

  private renderCustomPrompt(container: HTMLElement) {
    const stepLabel = container.createDiv({ cls: "ai-hub-step-label" });
    stepLabel.createSpan({ text: tr("или свой промпт") });
    const customArea = container.createDiv({ cls: "ai-hub-custom-prompt" });

    const textarea = customArea.createEl("textarea", {
      attr: {
        placeholder: tr("Введите инструкцию для AI..."),
        "aria-label": tr("Собственный промпт для обработки заметок"),
        rows: "3",
      },
    });

    new Setting(customArea).addButton((btn) =>
      btn
        .setButtonText(tr("Запустить"))
        .setIcon("play")
        .setCta()
        .onClick(() => {
          const v = textarea.value.trim();
          if (v) void this.confirmAndRun(v, "Custom");
          else notify("warning", tr("Введите промпт для обработки"));
        }),
    );
  }

  private renderFooter(container: HTMLElement) {
    const footer = container.createDiv({ cls: "ai-hub-footer-row" });
    new ButtonComponent(footer)
      .setButtonText(tr("Закрыть"))
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
          ? tr("0 заметок")
          : `${n} ${n === 1 ? tr("заметка") : n < 5 ? tr("заметки") : tr("заметок")}`,
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

  private async confirmAndRun(
    prompt: string,
    actionName: string,
    append = false,
  ) {
    const files = this.getFilesToProcess();
    if (files.length === 0) {
      notify("warning", tr("Нет заметок под эти фильтры"));
      return;
    }
    this.close();

    const confirmed = await this.askConfirm(prompt, actionName, files.length);
    if (confirmed) await this.plugin.runBatchProcessing(files, prompt, append);
  }

  private askConfirm(
    prompt: string,
    actionName: string,
    count: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new Modal(this.app);
      modal.titleEl.setText(tr("Подтверждение"));
      const c = modal.contentEl;

      c.createEl("p", {
        text: `Действие: ${actionName}`,
        cls: "ai-hub-confirm-title",
      });
      c.createEl("p", {
        text: tr("Файлов: {n}", { n: count }),
        cls: "ai-hub-confirm-count",
      });

      const box = c.createDiv({ cls: "ai-hub-query-box" });
      box.setText(prompt);

      c.createDiv({
        text: tr("Заметки будут изменены. Автобекап сохраняется в .ai-backup-*"),
        cls: "ai-hub-warning",
      });

      let done = false;
      const btns = c.createDiv({ cls: "modal-button-container" });
      new ButtonComponent(btns)
        .setButtonText(tr("Отмена"))
        .setIcon("x")
        .onClick(() => {
          done = true;
          resolve(false);
          modal.close();
        });
      new ButtonComponent(btns)
        .setButtonText(tr("Запустить"))
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
    this.titleEl.setText(tr("Аудит хранилища"));
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ai-hub-modal-content");

    // Шапка
    const header = contentEl.createDiv({ cls: "ai-hub-modal-header" });
    const h2 = header.createEl("h2");
    const iconSpan = h2.createSpan({ cls: "ai-hub-accent-icon" });
    setIcon(iconSpan, "microscope");
    h2.createSpan({ text: tr("Выберите режим аудита") });
    header.createEl("p", {
      text: tr("Каждый режим оптимизирован под свою задачу"),
    });

    // Загружаем индекс и считаем статистику
    await this.index.load();
    this.files = this.app.vault.getMarkdownFiles().filter((f) => {
      const p = f.path.toLowerCase();
      const cfg = this.app.vault.configDir.toLowerCase() + "/";
      return (
        !p.startsWith(cfg) &&
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
    statusRow.createSpan({ text: tr("Состояние индекса") });

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

    addStat(tr("Всего заметок"), stats.total);
    addStat(
      tr("В индексе (актуальные)"),
      stats.fresh,
      "var(--color-green,#4caf50)",
    );
    addStat(
      tr("Изменились"),
      stats.stale,
      stats.stale > 0 ? "var(--text-warning,orange)" : undefined,
    );
    addStat(
      tr("Новые (не в индексе)"),
      stats.unseen,
      stats.unseen > 0 ? "var(--interactive-accent)" : undefined,
    );
    addStat(tr("Последний запуск"), this.index.getUpdatedAt() || tr("никогда"));

    // Карточки режимов
    const modesGrid = contentEl.createDiv({ cls: "ai-hub-grid" });

    // ── BATCH режим ──────────────────────────────────────────────────
    // this.createModeCard(modesGrid, {
    //   icon: "layers",
    //   title: tr("Batch Аудит"),
    //   badge:
    //     batchToProcess > 0 ? tr("{n} к обработке", { n: batchToProcess }) : tr("Всё актуально"),
    //   badgeColor:
    //     batchToProcess > 0
    //       ? "var(--interactive-accent)"
    //       : "var(--color-green,#4caf50)",
    //   lines: [
    //     tr("По {n} файлов за запрос", { n: this.plugin.settings.deepAudit.batchSize }),
    //     tr("Параллельные запросы к API"),
    //     tr("Инкрементальный (пропускает кэш)"),
    //     tr("Финальный отчёт + Canvas-карта"),
    //   ],
    //   speed: tr("Быстрый"),
    //   context: tr("~4 000 симв./файл"),
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
      title: tr("Single Аудит"),
      badge: tr("~{n} мин", { n: estMinSingle }),
      badgeColor: "var(--text-muted)",
      lines: [
        tr("По одной заметке за запрос"),
        tr("Максимальный контекст файла"),
        tr("Детальный анализ каждой заметки"),
        tr("Обновляет индекс по ходу"),
      ],
      speed: tr("Медленный"),
      context: tr("~15 000 симв./файл"),
      onClick: () => {
        this.close();
        void this.plugin.runSingleAudit(this.index, true);
      },
    });

    // ── SINGLE (полный пересчёт) ──────────────────────────────────────
    this.createModeCard(modesGrid, {
      icon: "refresh-cw",
      title: tr("Single — Полный"),
      badge: tr("{n} файлов", { n: this.files.length }),
      badgeColor: "var(--text-muted)",
      lines: [
        tr("Анализирует ВСЕ заметки"),
        tr("Игнорирует кэш"),
        tr("Для первого запуска или сброса"),
        tr("Занимает больше всего времени"),
      ],
      speed: tr("Очень медленный"),
      context: tr("~15 000 симв./файл"),
      onClick: () => {
        this.close();
        void this.plugin.runSingleAudit(this.index, false);
      },
    });

    // ── Batch + финальный синтез ─────────────────────────────────────
    this.createModeCard(modesGrid, {
      icon: "brain",
      title: tr("Batch + Отчёт"),
      badge: tr("Рекомендуется"),
      badgeColor: "var(--interactive-accent)",
      lines: [
        tr("Batch анализ с кластеризацией"),
        tr("Глобальные инсайты по базе"),
        tr("Markdown-отчёт + Canvas"),
        tr("Полный MapReduce pipeline"),
      ],
      speed: tr("Средний"),
      context: tr("~4 000 симв./файл"),
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
    card.setAttribute("aria-label", tr("Режим: {m}", { m: opts.title }));

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