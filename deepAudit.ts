import { t as tr } from "./i18n";
import {
  App,
  TFile,
  Notice,
  Modal,
  Setting,
  ButtonComponent,
} from "obsidian";
import { AIHubSettings } from "./settings";
import { callOpenRouter } from "./api";
import { NoteIndexManager, NoteRecord } from "./noteIndex";
import { MAX_TOKENS_BATCH, MAX_TOKENS_AUDIT } from "./constants";

// === НАСТРОЙКИ ГЛУБОКОГО АУДИТА ===
export interface DeepAuditConfig {
  batchSize: number; // Сколько файлов в одном запросе к ЛЛМ
  maxConcurrent: number; // Сколько батчей обрабатываем параллельно
  maxFileChars: number; // Лимит символов на один файл (чтобы не раздувать контекст)
  maxBatchChars: number; // Лимит символов на весь батч
  delayBetweenBatchesMs: number; // Задержка между группами запросов (для rate limit)
  maxRetries: number; // Количество повторов при ошибке API
  reduceGroupSize: number; // Сколько Map-резюме объединяем в один Reduce-запрос
}

export const DEFAULT_DEEP_AUDIT_CONFIG: DeepAuditConfig = {
  batchSize: 5,
  maxConcurrent: 3,
  maxFileChars: 4000,
  maxBatchChars: 20000,
  delayBetweenBatchesMs: 1000,
  maxRetries: 2,
  reduceGroupSize: 8,
};

// === РЕЗУЛЬТАТЫ ФАЗ ===
export interface FileSummary {
  path: string;
  basename: string;
  topics: string[];
  keyIdeas: string;
  entities: string[];
  quality: "draft" | "developed" | "polished";
  suggestedTags: string[];
  suggestedLinks: string[];
  orphan: boolean;
}

export interface BatchSummary {
  files: FileSummary[];
  batchIndex: number;
  error?: string;
}

export interface ClusterSummary {
  name: string;
  description: string;
  fileCount: number;
  filePaths: string[];
  suggestedMOC: string;
}

export interface FinalAuditReport {
  totalFiles: number;
  processedFiles: number;
  failedFiles: number;
  clusters: ClusterSummary[];
  globalInsights: string;
  actionPlan: string;
  durationMs: number;
}

// === ПРОМПТЫ ===
const MAP_SYSTEM_PROMPT = () => tr("@map_sys");

const REDUCE_CLUSTER_PROMPT = () => tr("@cluster_sys");

const FINAL_INSIGHTS_PROMPT = () => tr("@final_sys");

// === УТИЛИТЫ ===

/**
 * Умная обрезка Markdown-контента: сохраняет frontmatter целиком,
 * затем распределяет бюджет символов по секциям заголовков.
 */
function smartTruncate(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;

  // Всегда сохраняем frontmatter целиком
  let fm = "";
  let body = content;
  const fmMatch = content.match(/^---[\s\S]*?---\n*/);
  if (fmMatch) {
    fm = fmMatch[0];
    body = content.slice(fm.length);
  }

  const bodyBudget = Math.max(0, maxChars - fm.length);
  if (bodyBudget <= 100) return content.slice(0, maxChars) + "\n…";

  // Разбиваем тело на секции по заголовкам
  const sectionRe = /(?=^#{1,4} )/m;
  const sections = body.split(sectionRe);
  const avgBudget = Math.floor(bodyBudget / Math.max(sections.length, 1));

  let result = fm;
  for (const section of sections) {
    if (result.length >= maxChars) break;
    const budget = Math.min(avgBudget, maxChars - result.length);
    if (section.length <= budget) {
      result += section;
    } else {
      // Заголовок + первые параграфы
      const paras = section.split(/\n\n/);
      let sec = "";
      for (const para of paras) {
        if (sec.length + para.length + 2 > budget) {
          sec += para.slice(0, budget - sec.length) + "…";
          break;
        }
        sec += para + "\n\n";
      }
      result += sec;
    }
  }

  if (result.length < content.length) result += "\n\n*[содержание сокращено]*";
  return result;
}

export function extractJSON<T>(raw: string): T {
  // Убираем markdown-обёртку если есть
  const cleaned = raw
    .replace(/```json\n?/gi, "")
    .replace(/```\n?/g, "")
    .trim();
  // Пытаемся найти первый { или [
  const jsonStart = Math.min(
    ...[cleaned.indexOf("{"), cleaned.indexOf("[")].filter((i) => i >= 0),
  );
  if (!Number.isFinite(jsonStart))
    throw new Error(tr("JSON не найден в ответе модели"));

  const jsonStr = cleaned.slice(jsonStart);
  return JSON.parse(jsonStr) as T;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  signal: AbortSignal,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal.aborted) throw new Error(tr("Отменено пользователем"));
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (signal.aborted) throw new Error(tr("Отменено пользователем"));
      if (attempt < retries) {
        const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
        await new Promise((r) => window.setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// === ОСНОВНОЙ КЛАСС ===
export class DeepAuditEngine {
  private config: DeepAuditConfig;
  private abortController: AbortController;
  public onProgress?: (
    stage: string,
    current: number,
    total: number,
    detail?: string,
  ) => void;

  constructor(
    private app: App,
    private settings: AIHubSettings,
    config: Partial<DeepAuditConfig> = {},
    private index?: NoteIndexManager, // ← необязательный параметр
  ) {
    this.config = { ...DEFAULT_DEEP_AUDIT_CONFIG, ...config };
    this.abortController = new AbortController();
  }

  abort() {
    this.abortController.abort();
  }

  private get signal() {
    return this.abortController.signal;
  }

  // === ГЛАВНЫЙ МЕТОД ===
  async run(): Promise<FinalAuditReport> {
    const startTime = Date.now();

    // 1. Отбираем файлы
    this.report("collect", 0, 1, tr("Сбор файлов..."));
    const files = this.collectFiles();
    if (files.length === 0) {
      throw new Error(tr("Нет файлов для анализа"));
    }

    // 2. Формируем батчи
    const batches = await this.buildBatches(files);
    this.report(
      "batched",
      batches.length,
      batches.length,
      `Сформировано батчей: ${batches.length}`,
    );

    // 3. MAP-фаза: параллельный анализ батчей
    const mapResults = await this.runMapPhase(batches);

    const allSummaries = mapResults.flatMap((b) => b.files);
    const failedCount =
      batches.length * this.config.batchSize - allSummaries.length;

    if (allSummaries.length === 0) {
      throw new Error(tr("Не удалось проанализировать ни одного файла"));
    }

    // 4. REDUCE-фаза: кластеризация (возможно иерархически).
    // Дедупликация одинаковых тем — здесь, одним местом на все пути reduce
    const clusters = this.dedupeClusters(
      await this.runReducePhase(allSummaries),
    );

    // Сохраняем кластеры в индекс — их использует генератор MOC
    if (this.index) {
      this.index.setClusters(
        clusters.map((c) => ({
          name: c.name,
          description: c.description,
          filePaths: c.filePaths,
        })),
      );
      await this.index.save();
    }

    // 5. Финальные инсайты и план
    const { globalInsights, actionPlan } = await this.runFinalSynthesis(
      clusters,
      allSummaries,
    );

    return {
      totalFiles: files.length,
      processedFiles: allSummaries.length,
      failedFiles: Math.max(0, failedCount),
      clusters,
      globalInsights,
      actionPlan,
      durationMs: Date.now() - startTime,
    };
  }

  // === 1. Сбор файлов ===
  private collectFiles(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((f) => {
      const path = f.path.toLowerCase();
      return (
        !path.startsWith(this.app.vault.configDir.toLowerCase() + "/") &&
        !path.startsWith("templates/") &&
        !path.startsWith(".ai-backup") &&
        !f.basename.startsWith(".")
      );
    });
  }

  // === 2. Формирование батчей ===
  private async buildBatches(
    files: TFile[],
  ): Promise<Array<{ index: number; payload: string; files: TFile[] }>> {
    const batches: Array<{ index: number; payload: string; files: TFile[] }> =
      [];
    let currentBatch: TFile[] = [];
    let currentPayload = "";
    let batchIndex = 0;

    const flush = () => {
      if (currentBatch.length === 0) return;
      batches.push({
        index: batchIndex++,
        payload: currentPayload,
        files: currentBatch,
      });
      currentBatch = [];
      currentPayload = "";
    };

    for (let i = 0; i < files.length; i++) {
      if (this.signal.aborted) throw new Error(tr("Отменено пользователем"));
      this.report(
        "reading",
        i + 1,
        files.length,
        `Чтение: ${files[i].basename}`,
      );

      const file = files[i];

      // Если есть индекс и файл не изменился — пропускаем
      if (this.index && !this.index.isStale(file)) {
        this.report(
          "reading",
          i + 1,
          files.length,
          `Кэш: ${files[i].basename}`,
        );
        continue;
      }

      let content: string;
      try {
        content = await this.app.vault.cachedRead(file);
      } catch {
        continue;
      }

      const cache = this.app.metadataCache.getFileCache(file);
      const existingTags = (cache?.tags ?? []).map((t) => t.tag).join(", ");
      const truncated = smartTruncate(content, this.config.maxFileChars);

      const fileBlock = `\n=== FILE ===\nPATH: ${file.path}\nBASENAME: ${file.basename}\nEXISTING_TAGS: ${existingTags}\nCONTENT:\n${truncated}\n=== END FILE ===\n`;

      // Если добавление файла превысит лимит — сбрасываем батч
      if (
        currentBatch.length >= this.config.batchSize ||
        (currentPayload.length + fileBlock.length > this.config.maxBatchChars &&
          currentBatch.length > 0)
      ) {
        flush();
      }

      currentBatch.push(file);
      currentPayload += fileBlock;

      // Каждые N файлов уступаем UI-треду
      if (i % 20 === 0) await new Promise((r) => window.setTimeout(r, 1));
    }

    flush();
    return batches;
  }

  // === 3. MAP-фаза с параллелизмом ===
  private async runMapPhase(
    batches: Array<{ index: number; payload: string; files: TFile[] }>,
  ): Promise<BatchSummary[]> {
    const results: BatchSummary[] = new Array<BatchSummary>(batches.length);
    let completed = 0;

    // Семафор для ограничения параллельности
    const queue = [...batches];
    const workers: Promise<void>[] = [];

    const worker = async () => {
      while (queue.length > 0) {
        if (this.signal.aborted) return;
        const batch = queue.shift();
        if (!batch) return;

        try {
          const summary = await withRetry(
            () => this.analyzeBatch(batch),
            this.config.maxRetries,
            this.signal,
          );
          results[batch.index] = summary;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results[batch.index] = {
            files: [],
            batchIndex: batch.index,
            error: msg,
          };
          console.error(`[DeepAudit] Батч ${batch.index} провалился:`, err);
        }

        completed++;
        this.report(
          "mapping",
          completed,
          batches.length,
          tr("Обработано батчей: {a}/{b}", { a: completed, b: batches.length }),
        );

        // Rate limiting
        if (this.config.delayBetweenBatchesMs > 0) {
          await new Promise((r) =>
            window.setTimeout(r, this.config.delayBetweenBatchesMs),
          );
        }
      }
    };

    const concurrency = Math.max(
      1,
      Math.min(this.config.maxConcurrent, batches.length),
    );
    for (let i = 0; i < concurrency; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    if (this.signal.aborted) throw new Error(tr("Отменено пользователем"));

    return results.filter((r): r is BatchSummary => !!r);
  }

  private async analyzeBatch(batch: {
    index: number;
    payload: string;
    files: TFile[];
  }): Promise<BatchSummary> {
    const user = tr("@map_user", { payload: batch.payload, n: batch.files.length });

    const response = await callOpenRouter(
      this.settings,
      MAP_SYSTEM_PROMPT(),
      user,
      { maxTokens: MAX_TOKENS_BATCH, signal: this.signal },
    );

    let parsed: FileSummary[];
    try {
      parsed = extractJSON<FileSummary[]>(response);
      if (!Array.isArray(parsed)) throw new Error(tr("Ответ не массив"));
    } catch (err) {
      throw new Error(
        tr("Невалидный JSON от ЛЛМ: {err}", { err: err instanceof Error ? err.message : String(err) }),
      );
    }

    // Дополняем информацией о сиротах
    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    for (const s of parsed) {
      const f = batch.files.find((x) => x.path === s.path);
      if (!f) continue;
      const cache = this.app.metadataCache.getFileCache(f);
      const outLinks = cache?.links?.length ?? 0;
      const inLinks = this.countBacklinks(f.path, resolvedLinks);
      s.orphan = outLinks + inLinks === 0;
      s.basename = f.basename;
    }

    // Сохраняем результаты в индекс
    if (this.index) {
      for (const s of parsed) {
        const f = batch.files.find((x) => x.path === s.path);
        if (!f) continue;
        const wc = (await this.app.vault.cachedRead(f).catch(() => ""))
          .split(/\s+/)
          .filter(Boolean).length;
        this.index.set(s.path, {
          mtime: f.stat.mtime,
          analyzedAt: Date.now(),
          mainIdea: s.keyIdeas ?? "",
          keyPoints: s.topics ?? [],
          entities: s.entities ?? [],
          quality: s.quality ?? "draft",
          suggestedTags: s.suggestedTags ?? [],
          wordCount: wc,
          topics: s.topics,
          suggestedLinks: s.suggestedLinks,
          orphan: s.orphan,
          mode: "batch",
        });
      }
      await this.index.save();
    }

    return { files: parsed, batchIndex: batch.index };
  }

  private countBacklinks(
    path: string,
    resolvedLinks: Record<string, Record<string, number>>,
  ): number {
    let count = 0;
    for (const src in resolvedLinks) {
      if (resolvedLinks[src][path]) count++;
    }
    return count;
  }

  // === 4. REDUCE-фаза (иерархическая кластеризация) ===
  private async runReducePhase(
    summaries: FileSummary[],
  ): Promise<ClusterSummary[]> {
    // Готовим компактное представление для ЛЛМ
    const compact = summaries.map((s) => ({
      p: s.path,
      t: s.topics,
      k: s.keyIdeas,
      tags: s.suggestedTags,
    }));

    // Если сводок немного — один запрос
    const groupSize = this.config.reduceGroupSize;
    const asString = JSON.stringify(compact);

    if (asString.length < 40000) {
      this.report("reducing", 1, 1, tr("Финальная кластеризация..."));
      return await this.clusterize(compact);
    }

    // Иерархическая свёртка: делим на группы, кластеризуем, потом мержим
    this.report("reducing", 0, 1, tr("Иерархическая кластеризация..."));
    const groups: (typeof compact)[] = [];
    for (let i = 0; i < compact.length; i += groupSize * 3) {
      groups.push(compact.slice(i, i + groupSize * 3));
    }

    const partialClusters: ClusterSummary[][] = [];
    for (let i = 0; i < groups.length; i++) {
      if (this.signal.aborted) throw new Error(tr("Отменено пользователем"));
      this.report(
        "reducing",
        i + 1,
        groups.length,
        tr("Группа {a}/{b}", { a: i + 1, b: groups.length }),
      );
      const c = await withRetry(
        () => this.clusterize(groups[i]),
        this.config.maxRetries,
        this.signal,
      );
      partialClusters.push(c);
      if (this.config.delayBetweenBatchesMs > 0) {
        await new Promise((r) =>
          window.setTimeout(r, this.config.delayBetweenBatchesMs),
        );
      }
    }

    // Финальный merge кластеров (рекурсивно уже не делаем — просто объединяем)
    const flat = partialClusters.flat();
    if (flat.length <= 10) return flat;

    // Если кластеров слишком много — просим модель их объединить
    this.report(
      "reducing",
      groups.length,
      groups.length,
      tr("Объединение кластеров..."),
    );
    return await this.mergeClusters(flat);
  }

  /**
   * Детерминированное объединение кластеров с одинаковым именем.
   * LLM-merge обеспечивает уникальность тем только промптом; здесь
   * гарантия кодом: пути объединяются без дублей, из описаний берётся
   * более содержательное.
   */
  private dedupeClusters(clusters: ClusterSummary[]): ClusterSummary[] {
    const byName = new Map<string, ClusterSummary>();
    let unnamed = 0;
    for (const c of clusters) {
      // Безымянные кластеры не сливаем между собой — у каждого свой ключ
      const key =
        (c.name ?? "").trim().toLowerCase() || ` unnamed-${unnamed++}`;
      const prev = byName.get(key);
      if (!prev) {
        byName.set(key, { ...c, filePaths: [...new Set(c.filePaths)] });
        continue;
      }
      prev.filePaths = [...new Set([...prev.filePaths, ...c.filePaths])];
      if (
        (c.description ?? "").trim().length >
        (prev.description ?? "").trim().length
      ) {
        prev.description = c.description;
      }
      if (!(prev.suggestedMOC ?? "").trim() && (c.suggestedMOC ?? "").trim()) {
        prev.suggestedMOC = c.suggestedMOC;
      }
    }
    return Array.from(byName.values()).map((c) => ({
      ...c,
      fileCount: c.filePaths.length,
    }));
  }

  private async clusterize(data: unknown[]): Promise<ClusterSummary[]> {
    const user = tr("@cluster_user", { data: JSON.stringify(data, null, 0) });
    const response = await callOpenRouter(
      this.settings,
      REDUCE_CLUSTER_PROMPT(),
      user,
      { maxTokens: MAX_TOKENS_AUDIT, signal: this.signal },
    );
    const parsed = extractJSON<{ clusters: ClusterSummary[] }>(response);
    const clusters = parsed.clusters || [];

    // Достраиваем fileCount и страхуем обязательные поля (LLM может
    // вернуть объект без name/description — дальше по коду это краш)
    return clusters.map((c) => ({
      ...c,
      name: (c.name ?? "").trim(),
      description: c.description ?? "",
      suggestedMOC: c.suggestedMOC ?? "",
      fileCount: c.filePaths?.length ?? 0,
      filePaths: c.filePaths || [],
    }));
  }

  private async mergeClusters(
    clusters: ClusterSummary[],
  ): Promise<ClusterSummary[]> {
    const compact = clusters.map((c) => ({
      name: c.name,
      description: c.description,
      filePaths: c.filePaths,
    }));
    const user = tr("@merge_user", { data: JSON.stringify(compact) });
    const response = await callOpenRouter(
      this.settings,
      REDUCE_CLUSTER_PROMPT(),
      user,
      { maxTokens: MAX_TOKENS_AUDIT, signal: this.signal },
    );
    const parsed = extractJSON<{ clusters: ClusterSummary[] }>(response);
    return (parsed.clusters || []).map((c) => ({
      ...c,
      name: (c.name ?? "").trim(),
      description: c.description ?? "",
      suggestedMOC: c.suggestedMOC ?? "",
      fileCount: c.filePaths?.length ?? 0,
      filePaths: c.filePaths || [],
    }));
  }

  // === 5. Финальный синтез ===
  private async runFinalSynthesis(
    clusters: ClusterSummary[],
    summaries: FileSummary[],
  ): Promise<{ globalInsights: string; actionPlan: string }> {
    this.report("synthesizing", 0, 1, tr("Формирование отчёта..."));

    const orphanCount = summaries.filter((s) => s.orphan).length;
    const qualityStats = {
      draft: summaries.filter((s) => s.quality === "draft").length,
      developed: summaries.filter((s) => s.quality === "developed").length,
      polished: summaries.filter((s) => s.quality === "polished").length,
    };

    const compactClusters = clusters.map((c) => ({
      name: c.name,
      description: c.description,
      fileCount: c.fileCount,
      suggestedMOC: c.suggestedMOC,
    }));

    const user = tr("@final_user", {
      clusters: JSON.stringify(compactClusters, null, 2),
      total: summaries.length,
      orphans: orphanCount,
      draft: qualityStats.draft,
      dev: qualityStats.developed,
      pol: qualityStats.polished,
    });

    const response = await callOpenRouter(
      this.settings,
      FINAL_INSIGHTS_PROMPT(),
      user,
      { maxTokens: 3500, signal: this.signal },
    );

    // Разбиваем на две секции
    const insightsMatch = response.match(/##\s*🔍.*?(?=##\s*🎯|$)/s);
    const planMatch = response.match(/##\s*🎯.*?(?=##\s*⚠️|$)/s);
    const issuesMatch = response.match(/##\s*⚠️.*/s);

    const globalInsights = (insightsMatch?.[0] ?? response).trim();
    const actionPlan = [planMatch?.[0], issuesMatch?.[0]]
      .filter(Boolean)
      .join("\n\n")
      .trim();

    this.report("synthesizing", 1, 1, tr("Готово"));
    return { globalInsights, actionPlan: actionPlan || response };
  }

  private report(
    stage: string,
    current: number,
    total: number,
    detail?: string,
  ) {
    this.onProgress?.(stage, current, total, detail);
  }
}

// === МОДАЛКА ПРОГРЕССА (DeepAudit batch) ===
export class DeepAuditProgressModal extends Modal {
  private stageEl!: HTMLElement;
  private barEl!: HTMLProgressElement;
  private detailEl!: HTMLElement;
  private etaEl!: HTMLElement;
  private logEl!: HTMLElement;
  private cancelBtn!: ButtonComponent;
  private startTime = Date.now();
  private engine?: DeepAuditEngine;
  public isCancelled = false;

  constructor(app: App) {
    super(app);
    this.titleEl.setText(tr("🔬 Глубокий аудит хранилища"));
  }

  attachEngine(engine: DeepAuditEngine) {
    this.engine = engine;
    engine.onProgress = (stage, current, total, detail) => {
      this.updateProgress(stage, current, total, detail);
    };
  }

  onOpen() {
    const root = this.contentEl.createDiv({ cls: "ai-hub-progress-root" });

    this.stageEl = root.createEl("h3", {
      text: tr("Подготовка..."),
      cls: "ai-hub-progress-stage",
    });

    this.barEl = root.createEl("progress", { cls: "ai-hub-progress-bar" });
    this.barEl.max = 100;
    this.barEl.value = 0;

    this.detailEl = root.createDiv({
      cls: "ai-hub-progress-text",
      text: tr("Инициализация..."),
    });
    this.etaEl = root.createDiv({
      cls: "ai-hub-progress-text ai-hub-progress-eta",
    });

    this.logEl = root.createDiv({ cls: "ai-hub-progress-log" });

    const btnRow = new Setting(root);
    btnRow.addButton((btn) => {
      this.cancelBtn = btn
        .setButtonText(tr("Отменить"))
        .setWarning()
        .onClick(() => {
          this.isCancelled = true;
          this.engine?.abort();
          btn.setDisabled(true).setButtonText(tr("Отмена..."));
          new Notice(tr("⏹ Останавливаем после текущего запроса..."));
        });
    });
  }

  private stageLabels: Record<string, string> = {
    collect: tr("📥 Сбор файлов"),
    reading: tr("📖 Чтение содержимого"),
    batched: tr("📦 Подготовка батчей"),
    mapping: tr("🗺️ Анализ батчей (Map)"),
    reducing: tr("🔗 Кластеризация (Reduce)"),
    synthesizing: tr("✨ Финальный синтез"),
  };

  private updateProgress(
    stage: string,
    current: number,
    total: number,
    detail?: string,
  ) {
    const label = this.stageLabels[stage] ?? stage;
    this.stageEl.setText(label);

    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    this.barEl.value = percent;

    if (detail) {
      this.detailEl.setText(`${detail} (${current}/${total}, ${percent}%)`);
    } else {
      this.detailEl.setText(`${current}/${total} (${percent}%)`);
    }

    // ETA
    const elapsed = Date.now() - this.startTime;
    if (current > 0 && total > 0 && stage === "mapping") {
      const perItem = elapsed / current;
      const remaining = Math.max(0, (total - current) * perItem);
      const remSec = Math.round(remaining / 1000);
      this.etaEl.setText(
        tr("⏱ Прошло: {a}с · Осталось ~{b}с", { a: Math.round(elapsed / 1000), b: remSec }),
      );
    } else {
      this.etaEl.setText(tr("⏱ Прошло: {a}с", { a: Math.round(elapsed / 1000) }));
    }

    // Лог только значимых событий
    if (stage === "mapping" || stage === "reducing") {
      const entry = this.logEl.createDiv({
        cls: "ai-hub-log-entry ai-hub-log-success",
        text: `[${label}] ${detail ?? ""}`,
      });
      entry.scrollIntoView({ block: "end" });
      // Ограничиваем лог
      while (this.logEl.children.length > 50) {
        this.logEl.firstChild?.remove();
      }
    }
  }

  finish() {
    this.cancelBtn?.setDisabled(true).setButtonText(tr("Готово"));
    window.setTimeout(() => this.close(), 800);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Конфигурация Single-режима
// ─────────────────────────────────────────────────────────────────────
export interface SingleAuditConfig {
  /** Максимум символов на файл (намного больше чем в batch) */
  maxFileChars: number;
  /** Задержка между файлами в мс */
  delayMs: number;
  /** Повторов при ошибке */
  maxRetries: number;
  /** Пропускать файлы, у которых mtime совпадает с индексом */
  onlyStale: boolean;
}

export const DEFAULT_SINGLE_AUDIT_CONFIG: SingleAuditConfig = {
  maxFileChars: 15_000,
  delayMs: 1_500,
  maxRetries: 2,
  onlyStale: true,
};

export interface SingleAuditReport {
  totalFiles: number;
  processedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  durationMs: number;
}

// Промпт для глубокого анализа одиночной заметки
const SINGLE_NOTE_PROMPT = `Ты — аналитик персональной базы знаний Obsidian.
Детально проанализируй одну заметку. Верни СТРОГО валидный JSON-объект (не массив, не markdown):

{
  "mainIdea": "главная мысль в 1-2 предложениях на русском",
  "keyPoints": ["тезис 1", "тезис 2", "тезис 3"],
  "entities": ["имя/концепт/технология из текста"],
  "quality": "draft",
  "suggestedTags": ["#тег1", "#тег2"],
  "suggestedLinks": ["название заметки которая вероятно связана"],
  "topics": ["тема1", "тема2"]
}

Правила quality:
- "draft" — пустая, заглушка, менее 100 слов без смысла
- "developed" — есть содержание, но не завершена
- "polished" — завершённая, структурированная

Отвечай ТОЛЬКО JSON. Никаких пояснений, никакого markdown вокруг JSON.`;

export class SingleAuditEngine {
  private config: SingleAuditConfig;
  private abortController: AbortController;

  public onProgress?: (
    current: number,
    total: number,
    fileName: string,
    status: "pending" | "done" | "error" | "skipped",
    detail?: string,
  ) => void;

  constructor(
    private app: App,
    private settings: AIHubSettings,
    private index: NoteIndexManager,
    config: Partial<SingleAuditConfig> = {},
  ) {
    this.config = { ...DEFAULT_SINGLE_AUDIT_CONFIG, ...config };
    this.abortController = new AbortController();
  }

  abort(): void {
    this.abortController.abort();
  }

  private get signal(): AbortSignal {
    return this.abortController.signal;
  }

  async run(): Promise<SingleAuditReport> {
    const startTime = Date.now();
    const files = this.collectFiles();
    let processed = 0,
      skipped = 0,
      failed = 0;

    for (let i = 0; i < files.length; i++) {
      if (this.signal.aborted) break;

      const file = files[i];

      // Проверяем нужно ли анализировать
      if (this.config.onlyStale && !this.index.isStale(file)) {
        skipped++;
        this.onProgress?.(i + 1, files.length, file.basename, "skipped");
        continue;
      }

      this.onProgress?.(i + 1, files.length, file.basename, "pending");

      try {
        const record = await withRetry(
          () => this.analyzeFile(file),
          this.config.maxRetries,
          this.signal,
        );
        this.index.set(file.path, record);
        await this.index.save();
        processed++;
        this.onProgress?.(
          i + 1,
          files.length,
          file.basename,
          "done",
          record.quality + " · " + record.mainIdea.slice(0, 60),
        );
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        this.onProgress?.(
          i + 1,
          files.length,
          file.basename,
          "error",
          msg.slice(0, 80),
        );
        console.warn(`[SingleAudit] Ошибка для ${file.path}:`, err);
      }

      if (
        i < files.length - 1 &&
        this.config.delayMs > 0 &&
        !this.signal.aborted
      ) {
        await new Promise((r) => window.setTimeout(r, this.config.delayMs));
      }
    }

    return {
      totalFiles: files.length,
      processedFiles: processed,
      skippedFiles: skipped,
      failedFiles: failed,
      durationMs: Date.now() - startTime,
    };
  }

  private async analyzeFile(file: TFile): Promise<NoteRecord> {
    let content = await this.app.vault.read(file);
    const wordCount = content.trim().split(/\s+/).filter(Boolean).length;

    // Умная обрезка с бо́льшим лимитом чем в batch
    content = smartTruncate(content, this.config.maxFileChars);

    const cache = this.app.metadataCache.getFileCache(file);
    const existingTags = (cache?.tags ?? []).map((t) => t.tag).join(", ");
    const outLinks = cache?.links?.length ?? 0;
    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    const inLinks = Object.values(resolvedLinks).filter(
      (targets) => targets[file.path] !== undefined,
    ).length;

    const user = tr("@single_user", {
      path: file.path,
      tags: existingTags || tr(tr("нет")),
      out: outLinks,
      inn: inLinks,
      content,
    });

    const response = await callOpenRouter(
      this.settings,
      SINGLE_NOTE_PROMPT,
      user,
      { maxTokens: 600, signal: this.signal },
    );

    let parsed: Partial<NoteRecord> = {};
    try {
      parsed = extractJSON<Partial<NoteRecord>>(response);
    } catch {
      // Если JSON не распарсился — минимальная запись
      parsed = {
        mainIdea: tr("Не удалось распарсить ответ модели"),
        quality: "draft",
      };
    }

    return {
      mtime: file.stat.mtime,
      analyzedAt: Date.now(),
      mainIdea: (parsed.mainIdea ?? "").slice(0, 300),
      keyPoints: Array.isArray(parsed.keyPoints)
        ? parsed.keyPoints.slice(0, 7)
        : [],
      entities: Array.isArray(parsed.entities)
        ? parsed.entities.slice(0, 15)
        : [],
      quality: (["draft", "developed", "polished"] as readonly string[]).includes(
        String(parsed.quality),
      )
        ? (parsed.quality as NoteRecord["quality"])
        : "draft",
      suggestedTags: Array.isArray(parsed.suggestedTags)
        ? parsed.suggestedTags.slice(0, 8)
        : [],
      wordCount,
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      suggestedLinks: Array.isArray(parsed.suggestedLinks)
        ? parsed.suggestedLinks.slice(0, 5)
        : [],
      orphan: outLinks + inLinks === 0,
      mode: "single",
    };
  }

  private collectFiles(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((f) => {
      const p = f.path.toLowerCase();
      return (
        !p.startsWith(this.app.vault.configDir.toLowerCase() + "/") &&
        !p.startsWith("templates/") &&
        !p.startsWith(".ai-backup") &&
        !f.basename.startsWith(".")
      );
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Модалка прогресса Single-режима
// ─────────────────────────────────────────────────────────────────────
export class SingleAuditProgressModal extends Modal {
  private engine: SingleAuditEngine | null = null;
  private barEl!: HTMLProgressElement;
  private currentFileEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private etaEl!: HTMLElement;
  private logEl!: HTMLElement;
  private startTime = Date.now();
  private counts = { done: 0, skipped: 0, error: 0 };
  public isCancelled = false;

  constructor(app: App) {
    super(app);
    this.titleEl.setText(tr("Глубокий аудит — Single"));
  }

  attachEngine(engine: SingleAuditEngine): void {
    this.engine = engine;
    engine.onProgress = (current, total, name, status, detail) => {
      this.update(current, total, name, status, detail);
    };
  }

  onOpen(): void {
    const root = this.contentEl.createDiv({ cls: "ai-hub-progress-root" });

    // Текущий файл
    this.currentFileEl = root.createDiv({
      cls: "ai-hub-progress-text",
      text: tr("Инициализация..."),
    });

    // Прогресс-бар
    this.barEl = root.createEl("progress", { cls: "ai-hub-progress-bar" });
    this.barEl.max = 100;
    this.barEl.value = 0;

    // Статистика
    this.statsEl = root.createDiv({ cls: "ai-hub-progress-stats" });
    this.renderStats();

    // ETA
    this.etaEl = root.createDiv({
      cls: "ai-hub-progress-text ai-hub-progress-eta",
    });

    // Лог
    this.logEl = root.createDiv({ cls: "ai-hub-progress-log" });
    this.logEl.setAttribute("role", "log");
    this.logEl.setAttribute("aria-live", "polite");

    // Кнопка остановки
    const btnRow = root.createDiv({ cls: "ai-hub-progress-btnrow" });
    new Setting(btnRow).addButton((btn) =>
      btn
        .setButtonText(tr("Остановить"))
        .setIcon("square")
        .setWarning()
        .onClick(() => {
          this.isCancelled = true;
          this.engine?.abort();
          btn.setDisabled(true).setButtonText(tr("Остановка..."));
          new Notice(tr("⏹ Остановка после текущего файла..."));
        }),
    );
  }

  private renderStats(): void {
    this.statsEl.empty();
    this.statsEl.createEl("span", {
      text: `✓ ${this.counts.done}`,
      cls: "ai-hub-stat-done",
    });
    this.statsEl.createEl("span", {
      text: `⟳ ${this.counts.skipped}`,
      cls: "ai-hub-stat-skip",
    });
    this.statsEl.createEl("span", {
      text: `✗ ${this.counts.error}`,
      cls: "ai-hub-stat-error",
    });
  }

  private update(
    current: number,
    total: number,
    name: string,
    status: "pending" | "done" | "error" | "skipped",
    detail?: string,
  ): void {
    if (status !== "pending") {
      if (status === "done") this.counts.done++;
      else if (status === "skipped") this.counts.skipped++;
      else if (status === "error") this.counts.error++;
    }

    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    this.barEl.value = pct;
    this.barEl.setAttribute("aria-valuenow", String(pct));

    this.currentFileEl.setText(
      status === "pending"
        ? tr("⏳ Анализирую: {name}", { name })
        : `${pct}% — ${current}/${total}`,
    );

    this.renderStats();

    // ETA
    const elapsed = Date.now() - this.startTime;
    if (current > 0) {
      const rate = elapsed / current;
      const remaining = Math.max(0, (total - current) * rate);
      this.etaEl.setText(
        tr("⏱ {a}с · осталось ~{b}с", { a: Math.round(elapsed / 1000), b: Math.round(remaining / 1000) }),
      );
    }

    // Лог-запись
    if (status !== "pending") {
      const cls =
        status === "done"
          ? "ai-hub-log-success"
          : status === "skipped"
            ? "ai-hub-log-pending"
            : "ai-hub-log-error";
      const icon = status === "done" ? "✓" : status === "skipped" ? "⟳" : "✗";
      const entry = this.logEl.createDiv({ cls: `ai-hub-log-entry ${cls}` });
      entry.setText(`${icon} ${name}${detail ? " — " + detail : ""}`);
      this.logEl.scrollTop = this.logEl.scrollHeight;
      while (this.logEl.children.length > 100) this.logEl.firstChild?.remove();
    }
  }

  finish(): void {
    this.currentFileEl.setText(tr("✅ Анализ завершён"));
    window.setTimeout(() => this.close(), 1200);
  }
}