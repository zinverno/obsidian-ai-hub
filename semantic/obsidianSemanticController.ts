import { App, Notice, Plugin, TFile } from "obsidian";
import { t as tr } from "../i18n";
import { MarkdownChunker } from "../chunking";
import {
  EMBEDDING_PROVIDER_PROFILES,
} from "../embeddings/types";
import type { EmbeddingSettings } from "../embeddings/types";
import {
  buildEmbeddingSpaceId,
  IndexingCompatibilityError,
  IndexingProviderError,
  IndexingSourceError,
} from "../indexing";
import type {
  IndexDocumentInput,
  IndexingRunResult,
} from "../indexing";
import {
  SemanticCompatibilityError,
  SemanticNotReadyError,
  SemanticProviderError,
  SemanticStorageError,
  SemanticValidationError,
} from "./errors";
import { AsyncReadWriteBarrier } from "./asyncReadWriteBarrier";
import { createObsidianSemanticRuntime } from "./obsidianSemanticRuntime";
import { confirmSemanticOperation } from "./semanticConfirmModal";
import type { SemanticConfirmation } from "./semanticConfirmModal";
import { probeSemanticIndex } from "./semanticIndexProbe";
import type {
  SemanticIndexDescriptor,
  SemanticIndexProbeResult,
} from "./semanticIndexProbe";
import { SemanticSearchModal } from "./semanticSearchModal";
import {
  resetSemanticStorage,
  semanticIndexBasePath,
} from "./semanticStorageMaintenance";
import { SemanticStoreRegistry } from "./semanticStoreRegistry";
import type {
  SemanticDocumentResult,
  SemanticRuntime,
  SemanticRuntimeStats,
  SemanticStatus,
} from "./types";

interface SemanticPluginHost {
  app: App;
  manifest: { id: string };
  settings: { semantic: EmbeddingSettings };
  addCommand(command: Parameters<Plugin["addCommand"]>[0]): unknown;
}

export interface SemanticControllerDependencies {
  runtimeFactory?: (input: {
    app: App;
    settings: EmbeddingSettings;
    basePath: string;
    storeRegistry: SemanticStoreRegistry;
    existingDescriptor?: SemanticIndexDescriptor;
  }) => SemanticRuntime;
  confirm?: (
    app: App,
    confirmation: SemanticConfirmation,
  ) => Promise<boolean>;
  notice?: (message: string, duration?: number) => { hide(): void };
  openSearchModal?: (
    app: App,
    controller: ObsidianSemanticController,
  ) => void;
  resetStorage?: typeof resetSemanticStorage;
  probeIndex?: typeof probeSemanticIndex;
  barrier?: AsyncReadWriteBarrier;
  storeRegistry?: SemanticStoreRegistry;
}

interface RuntimeSlot {
  signature: string;
  runtime: SemanticRuntime;
  snapshot: EmbeddingSettings;
  epoch: number;
}

type SemanticRuntimeIntent =
  | "inspect"
  | "search"
  | "index"
  | "clear"
  | "rebuild";

function safeSettingsSnapshot(settings: EmbeddingSettings): EmbeddingSettings {
  return {
    enabled: settings.enabled,
    embeddingProvider: settings.embeddingProvider,
    embeddingModel: settings.embeddingModel,
    embeddingBaseUrl: settings.embeddingBaseUrl,
    openRouterApiKey: settings.openRouterApiKey,
    openAICompatibleApiKey: settings.openAICompatibleApiKey,
  };
}

function selectedApiKey(settings: EmbeddingSettings): string {
  if (settings.embeddingProvider === "openrouter") {
    return settings.openRouterApiKey;
  }
  if (settings.embeddingProvider === "openai-compatible") {
    return settings.openAICompatibleApiKey;
  }
  return "";
}

function settingsSignature(settings: EmbeddingSettings): string {
  return JSON.stringify([
    settings.enabled,
    settings.embeddingProvider,
    settings.embeddingModel,
    settings.embeddingBaseUrl,
    selectedApiKey(settings),
  ]);
}

export class ObsidianSemanticController {
  private readonly runtimeFactory: NonNullable<
    SemanticControllerDependencies["runtimeFactory"]
  >;
  private readonly confirm: NonNullable<
    SemanticControllerDependencies["confirm"]
  >;
  private readonly notice: NonNullable<
    SemanticControllerDependencies["notice"]
  >;
  private readonly openSearchModal: NonNullable<
    SemanticControllerDependencies["openSearchModal"]
  >;
  private readonly resetStorage: NonNullable<
    SemanticControllerDependencies["resetStorage"]
  >;
  private readonly probeIndex: NonNullable<
    SemanticControllerDependencies["probeIndex"]
  >;
  private readonly barrier: AsyncReadWriteBarrier;
  private readonly storeRegistry: SemanticStoreRegistry;
  private runtimeSlot: RuntimeSlot | null = null;
  private operationBusy = false;
  private settingsEpoch = 0;
  private status: SemanticStatus;

  constructor(
    private readonly plugin: SemanticPluginHost,
    dependencies: SemanticControllerDependencies = {},
  ) {
    this.barrier = dependencies.barrier ?? new AsyncReadWriteBarrier();
    this.storeRegistry =
      dependencies.storeRegistry ?? new SemanticStoreRegistry();
    this.runtimeFactory =
      dependencies.runtimeFactory ?? createObsidianSemanticRuntime;
    this.confirm = dependencies.confirm ?? confirmSemanticOperation;
    this.notice =
      dependencies.notice ??
      ((message, duration) => new Notice(message, duration));
    this.openSearchModal =
      dependencies.openSearchModal ??
      ((app, controller) => {
        new SemanticSearchModal(app, controller).open();
      });
    this.resetStorage = dependencies.resetStorage ?? resetSemanticStorage;
    this.probeIndex = dependencies.probeIndex ?? probeSemanticIndex;
    this.status = this.defaultStatus(
      this.plugin.settings.semantic.enabled
        ? "not-initialized"
        : "disabled",
    );
  }

  registerCommands(): void {
    this.plugin.addCommand({
      id: "ai-semantic-search",
      name: tr("Семантический поиск"),
      callback: () => this.openSearch(),
    });
    this.plugin.addCommand({
      id: "ai-semantic-index-vault",
      name: tr("Обновить семантический индекс Vault"),
      callback: () => void this.indexVault(),
    });
    this.plugin.addCommand({
      id: "ai-semantic-index-current-note",
      name: tr("Обновить текущую заметку в семантическом индексе"),
      callback: () => void this.indexCurrentNote(),
    });
    this.plugin.addCommand({
      id: "ai-semantic-clear-index",
      name: tr("Очистить семантический индекс"),
      callback: () => void this.clearIndex(),
    });
    this.plugin.addCommand({
      id: "ai-semantic-rebuild-index",
      name: tr("Перестроить семантический индекс"),
      callback: () => void this.rebuildIndex(),
    });
  }

  getSemanticStatus(): SemanticStatus {
    this.reconcileCachedStatus();
    return { ...this.status };
  }

  notifySettingsChanged(): void {
    this.settingsEpoch++;
    this.runtimeSlot = null;
    this.status = this.defaultStatus(
      this.plugin.settings.semantic.enabled
        ? "not-initialized"
        : "disabled",
    );
  }

  async refreshSemanticStatus(): Promise<SemanticStatus> {
    if (!this.plugin.settings.semantic.enabled) return this.getSemanticStatus();
    try {
      return await this.barrier.withShared(async () => {
        // Settings may change while this operation waits behind an exclusive
        // clear/rebuild lease. Re-check only after the shared lease is held.
        if (!this.plugin.settings.semantic.enabled) {
          this.status = this.defaultStatus("disabled");
          return this.getSemanticStatus();
        }
        const snapshot = safeSettingsSnapshot(this.plugin.settings.semantic);
        const epoch = this.settingsEpoch;
        this.status = this.defaultStatus("initializing", snapshot);
        try {
          const runtime = await this.runtimeForSnapshot(
            snapshot,
            epoch,
            "inspect",
          );
          if (!runtime) {
            this.status = this.defaultStatus("not-initialized", snapshot);
            return this.getSemanticStatus();
          }
          await runtime.initialize();
          if (!this.snapshotIsCurrent(snapshot, epoch)) {
            return this.getSemanticStatus();
          }
          this.updateReadyStatus(runtime);
        } catch (error) {
          this.captureErrorStatus(error);
          this.showError(error);
        }
        return this.getSemanticStatus();
      });
    } catch (error) {
      // Defensive outer boundary: no click handler or command should observe
      // an unhandled rejection from barrier acquisition or status refresh.
      this.captureErrorStatus(error);
      this.showError(error);
      return this.getSemanticStatus();
    }
  }

  openSearch(): void {
    if (!this.ensureEnabled()) return;
    this.openSearchModal(this.plugin.app, this);
  }

  async prepareSearch(): Promise<SemanticRuntimeStats> {
    return this.barrier.withShared(async () => {
      if (!this.plugin.settings.semantic.enabled) {
        throw new SemanticNotReadyError(
          tr("Включите semantic-функции в настройках"),
        );
      }
      const snapshot = safeSettingsSnapshot(this.plugin.settings.semantic);
      const epoch = this.settingsEpoch;
      this.status = this.defaultStatus("initializing", snapshot);
      try {
        const runtime = await this.runtimeForSnapshot(
          snapshot,
          epoch,
          "search",
        );
        if (!runtime) {
          this.status = this.defaultStatus("not-initialized", snapshot);
          return this.emptyRuntimeStats();
        }
        await runtime.initialize();
        this.updateReadyStatus(runtime);
        return runtime.getStats();
      } catch (error) {
        this.captureErrorStatus(error);
        throw error;
      }
    });
  }

  async search(query: string): Promise<SemanticDocumentResult[]> {
    return this.barrier.withShared(async () => {
      if (!this.plugin.settings.semantic.enabled) {
        throw new SemanticNotReadyError(
          tr("Включите semantic-функции в настройках"),
        );
      }
      const runtime = await this.runtimeForSnapshot(
        safeSettingsSnapshot(this.plugin.settings.semantic),
        this.settingsEpoch,
        "search",
      );
      if (!runtime) {
        throw new SemanticNotReadyError(
          tr("Семантический индекс пуст. Сначала обновите индекс Vault."),
        );
      }
      if (!runtime.getStats().initialized) await runtime.initialize();
      if (runtime.getStats().vectorCount <= 0) {
        throw new SemanticNotReadyError(
          tr("Семантический индекс пуст. Сначала обновите индекс Vault."),
        );
      }
      return runtime.search(query, { limit: 10, matchesPerDocument: 3 });
    });
  }

  async indexVault(): Promise<void> {
    if (!this.ensureEnabled() || !this.acquireOperation()) return;
    try {
      const fileCount = this.plugin.app.vault.getMarkdownFiles().length;
      const snapshot = safeSettingsSnapshot(this.plugin.settings.semantic);
      const epoch = this.settingsEpoch;
      const provider =
        EMBEDDING_PROVIDER_PROFILES[snapshot.embeddingProvider].label;
      const confirmed = await this.confirm(this.plugin.app, {
        title: tr("Обновить семантический индекс Vault"),
        paragraphs: [
          tr("Markdown-файлов: {n}", { n: fileCount }),
          snapshot.embeddingProvider === "ollama"
            ? tr("Ollama обрабатывает фрагменты локально.")
            : tr("Содержимое фрагментов будет отправлено провайдеру {provider}.", {
                provider,
              }),
          tr("Операция может занять некоторое время."),
          tr("Индекс хранится локально внутри каталога плагина."),
        ],
        confirmText: tr("Обновить индекс"),
      });
      if (!confirmed) return;

      await this.barrier.withShared(async () => {
        const runtime = await this.runtimeForSnapshot(
          snapshot,
          epoch,
          "index",
        );
        if (!runtime) throw new SemanticNotReadyError();
        const progress = this.notice(
          tr("Обновляю семантический индекс..."),
          0,
        );
        try {
          const result = await runtime.indexVault();
          this.updateReadyStatus(runtime);
          this.notice(this.formatVaultResult(result), 10000);
        } finally {
          progress.hide();
        }
      });
    } catch (error) {
      this.captureErrorStatus(error);
      this.showError(error);
    } finally {
      this.releaseOperation();
    }
  }

  async indexCurrentNote(): Promise<void> {
    if (!this.ensureEnabled() || !this.acquireOperation()) return;
    try {
      const snapshot = safeSettingsSnapshot(this.plugin.settings.semantic);
      const epoch = this.settingsEpoch;
      const file = this.plugin.app.workspace.getActiveFile();
      if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") {
        this.notice(tr("Откройте Markdown-заметку для индексации."));
        return;
      }
      await this.barrier.withShared(async () => {
        let document: IndexDocumentInput;
        try {
          document = {
            path: file.path,
            content: await this.plugin.app.vault.cachedRead(file),
            cache: this.plugin.app.metadataCache.getFileCache(file),
          };
        } catch {
          this.notice(tr("Не удалось прочитать текущую заметку."));
          return;
        }
        const preflight = await this.probeRuntimeDescriptor(this.basePath());
        if (
          preflight.state === "absent" &&
          new MarkdownChunker().chunk(document).length === 0
        ) {
          this.status = this.defaultStatus("not-initialized", snapshot);
          this.notice(
            tr("Заметка уже актуальна в семантическом индексе."),
          );
          return;
        }
        const runtime = await this.runtimeForSnapshot(
          snapshot,
          epoch,
          "index",
        );
        if (!runtime) throw new SemanticNotReadyError();
        const result = await runtime.indexDocument(document);
        this.updateReadyStatus(runtime);
        if (
          result.documentsUnchanged === 1 &&
          result.chunksEmbedded === 0 &&
          result.chunksDeleted === 0
        ) {
          this.notice(
            tr("Заметка уже актуальна в семантическом индексе."),
          );
        } else {
          this.notice(
            tr(
              "Заметка обновлена: chunks {seen}, embedded {embedded}, deleted {deleted}, generation {generation}.",
              {
                seen: result.chunksSeen,
                embedded: result.chunksEmbedded,
                deleted: result.chunksDeleted,
                generation: result.generationAfter,
              },
            ),
            8000,
          );
        }
      });
    } catch (error) {
      this.captureErrorStatus(error);
      this.showError(error);
    } finally {
      this.releaseOperation();
    }
  }

  async clearIndex(): Promise<void> {
    if (!this.ensureEnabled() || !this.acquireOperation()) return;
    try {
      const snapshot = safeSettingsSnapshot(this.plugin.settings.semantic);
      const epoch = this.settingsEpoch;
      const confirmed = await this.confirm(this.plugin.app, {
        title: tr("Очистить семантический индекс"),
        paragraphs: [
          tr("Будет очищен только текущий совместимый semantic index."),
          tr("Markdown-файлы Vault не изменяются."),
        ],
        warning: tr("Для повторного поиска потребуется заново обновить индекс."),
        confirmText: tr("Очистить индекс"),
        danger: true,
      });
      if (!confirmed) return;
      await this.barrier.withExclusive(async () => {
        const runtime = await this.runtimeForSnapshot(
          snapshot,
          epoch,
          "clear",
        );
        if (!runtime) {
          this.status = this.defaultStatus("not-initialized", snapshot);
          this.notice(
            tr("Семантический индекс пуст. Сначала обновите индекс Vault."),
          );
          return;
        }
        await runtime.clear();
        this.updateReadyStatus(runtime);
        this.notice(tr("Семантический индекс очищен."));
      });
    } catch (error) {
      this.captureErrorStatus(error);
      this.showError(error);
    } finally {
      this.releaseOperation();
    }
  }

  async rebuildIndex(): Promise<void> {
    if (!this.ensureEnabled() || !this.acquireOperation()) return;
    try {
      const fileCount = this.plugin.app.vault.getMarkdownFiles().length;
      const snapshot = safeSettingsSnapshot(this.plugin.settings.semantic);
      const epoch = this.settingsEpoch;
      const confirmed = await this.confirm(this.plugin.app, {
        title: tr("Перестроить семантический индекс"),
        paragraphs: [
          tr("Существующий semantic index будет явно удалён."),
          tr("После очистки будут заново обработаны Markdown-файлы: {n}.", {
            n: fileCount,
          }),
          snapshot.embeddingProvider === "ollama"
            ? tr("Ollama обрабатывает фрагменты локально.")
            : tr("Содержимое фрагментов будет отправлено выбранному embedding-провайдеру."),
        ],
        warning: tr("Это необратимо для текущего локального semantic index."),
        confirmText: tr("Перестроить индекс"),
        danger: true,
      });
      if (!confirmed) return;

      await this.barrier.withExclusive(async () => {
        const basePath = this.basePath();
        this.runtimeSlot = null;
        try {
          await this.resetStorage(this.plugin.app.vault.adapter, basePath);
        } finally {
          this.storeRegistry.delete(basePath);
        }
        const runtime = await this.runtimeForSnapshot(
          snapshot,
          epoch,
          "rebuild",
        );
        if (!runtime) throw new SemanticNotReadyError();
        const progress = this.notice(
          tr("Перестраиваю семантический индекс..."),
          0,
        );
        try {
          const result = await runtime.indexVault();
          this.updateReadyStatus(runtime);
          this.notice(this.formatVaultResult(result), 10000);
        } finally {
          progress.hide();
        }
      });
    } catch (error) {
      this.captureErrorStatus(error);
      this.showError(error);
    } finally {
      this.releaseOperation();
    }
  }

  errorMessage(error: unknown): string {
    if (
      error instanceof SemanticCompatibilityError ||
      error instanceof IndexingCompatibilityError
    ) {
      return tr(
        "Семантический индекс создан другой embedding-моделью. Верните прежние настройки или перестройте индекс.",
      );
    }
    if (error instanceof SemanticNotReadyError) return error.message;
    if (error instanceof SemanticValidationError) {
      return tr("Проверьте параметры семантического поиска.");
    }
    if (
      error instanceof SemanticProviderError ||
      error instanceof IndexingProviderError
    ) {
      return tr(
        "Embedding-провайдер не выполнил запрос. Проверьте его настройки.",
      );
    }
    if (error instanceof IndexingSourceError) {
      return tr("Не удалось прочитать одну из Markdown-заметок.");
    }
    if (error instanceof SemanticStorageError) {
      return tr("Не удалось безопасно изменить файлы semantic index.");
    }
    return tr(
      "Не удалось выполнить semantic-операцию. Проверьте настройки и повторите.",
    );
  }

  private ensureEnabled(): boolean {
    if (this.plugin.settings.semantic.enabled) return true;
    this.status = this.defaultStatus("disabled");
    this.notice(tr("Включите semantic-функции в настройках"));
    return false;
  }

  private async runtimeForSnapshot(
    snapshot: EmbeddingSettings,
    epoch: number,
    intent: SemanticRuntimeIntent,
  ): Promise<SemanticRuntime | null> {
    const signature = settingsSignature(snapshot);
    if (
      this.runtimeSlot?.signature === signature &&
      this.runtimeSlot.epoch === epoch
    ) {
      return this.runtimeSlot.runtime;
    }

    const basePath = this.basePath();
    let existingDescriptor: SemanticIndexDescriptor | undefined;
    if (intent !== "rebuild") {
      const probe = await this.probeRuntimeDescriptor(basePath);
      if (probe.state === "present") {
        existingDescriptor = probe.descriptor;
        const expectedEmbeddingSpaceId = buildEmbeddingSpaceId({
          providerId: snapshot.embeddingProvider,
          model: snapshot.embeddingModel,
          baseUrl: snapshot.embeddingBaseUrl,
          dimensions: existingDescriptor.dimensions,
        });
        if (
          expectedEmbeddingSpaceId !== existingDescriptor.embeddingSpaceId
        ) {
          throw new SemanticCompatibilityError();
        }
      } else if (probe.state === "corrupt") {
        throw new SemanticStorageError(
          "Semantic index metadata is corrupt or unsupported.",
        );
      } else if (probe.state === "incomplete") {
        throw new SemanticStorageError(
          "Semantic index metadata is incomplete.",
        );
      } else if (intent !== "index") {
        return null;
      }
    }

    const runtime = this.runtimeFactory({
      app: this.plugin.app,
      settings: { ...snapshot },
      basePath,
      storeRegistry: this.storeRegistry,
      existingDescriptor,
    });
    if (
      epoch === this.settingsEpoch &&
      signature === settingsSignature(this.plugin.settings.semantic)
    ) {
      this.runtimeSlot = {
        signature,
        runtime,
        snapshot: { ...snapshot },
        epoch,
      };
      this.status = this.defaultStatus("not-initialized", snapshot);
    }
    return runtime;
  }

  private async probeRuntimeDescriptor(
    basePath: string,
  ): Promise<SemanticIndexProbeResult> {
    const registered = this.storeRegistry.peek(basePath);
    if (registered) {
      const stats = registered.store.getStats();
      return {
        state: "present",
        source: "main",
        descriptor: {
          dimensions: registered.dimensions,
          embeddingSpaceId: registered.embeddingSpaceId,
          generation: stats.generation,
          count: stats.count,
        },
      };
    }
    return this.probeIndex(this.plugin.app.vault.adapter, basePath);
  }

  private snapshotIsCurrent(
    snapshot: EmbeddingSettings,
    epoch: number,
  ): boolean {
    return (
      epoch === this.settingsEpoch &&
      settingsSignature(snapshot) ===
        settingsSignature(this.plugin.settings.semantic)
    );
  }

  private emptyRuntimeStats(): SemanticRuntimeStats {
    return {
      initialized: false,
      indexing: false,
      vectorCount: 0,
      vectorGeneration: 0,
      dimensions: 0,
      embeddingSpaceId: "",
    };
  }

  private basePath(): string {
    return semanticIndexBasePath(
      this.plugin.app.vault.configDir,
      this.plugin.manifest.id,
    );
  }

  private acquireOperation(): boolean {
    if (this.operationBusy) {
      this.notice(
        tr("Другая операция с семантическим индексом уже выполняется."),
      );
      return false;
    }
    this.operationBusy = true;
    this.status = this.defaultStatus("indexing");
    return true;
  }

  private releaseOperation(): void {
    this.operationBusy = false;
    if (this.status.kind === "error" || this.status.kind === "incompatible") {
      return;
    }
    this.reconcileCachedStatus();
  }

  private updateReadyStatus(runtime: SemanticRuntime): void {
    const stats = runtime.getStats();
    const snapshot =
      this.runtimeSlot?.runtime === runtime
        ? this.runtimeSlot.snapshot
        : this.plugin.settings.semantic;
    this.status = {
      kind: stats.indexing || this.operationBusy ? "indexing" : "ready",
      vectorCount: stats.vectorCount,
      vectorGeneration: stats.vectorGeneration,
      dimensions: stats.dimensions,
      providerLabel:
        EMBEDDING_PROVIDER_PROFILES[snapshot.embeddingProvider].label,
      model: snapshot.embeddingModel,
    };
  }

  private reconcileCachedStatus(): void {
    if (!this.plugin.settings.semantic.enabled) {
      this.status = this.defaultStatus("disabled");
      return;
    }
    if (
      !this.operationBusy &&
      (this.status.kind === "error" || this.status.kind === "incompatible")
    ) {
      return;
    }
    const currentSignature = settingsSignature(this.plugin.settings.semantic);
    if (
      !this.runtimeSlot ||
      this.runtimeSlot.signature !== currentSignature ||
      this.runtimeSlot.epoch !== this.settingsEpoch
    ) {
      this.status = this.defaultStatus("not-initialized");
      return;
    }
    const stats = this.runtimeSlot.runtime.getStats();
    if (stats.initialized) this.updateReadyStatus(this.runtimeSlot.runtime);
    if (this.operationBusy) this.status.kind = "indexing";
  }

  private captureErrorStatus(error: unknown): void {
    this.status = this.defaultStatus(
      error instanceof SemanticCompatibilityError ||
        error instanceof IndexingCompatibilityError
        ? "incompatible"
        : "error",
    );
  }

  private showError(error: unknown): void {
    this.notice(this.errorMessage(error), 8000);
  }

  private defaultStatus(
    kind: SemanticStatus["kind"],
    settings = this.plugin.settings.semantic,
  ): SemanticStatus {
    return {
      kind,
      vectorCount: 0,
      vectorGeneration: 0,
      dimensions: 0,
      providerLabel:
        EMBEDDING_PROVIDER_PROFILES[settings.embeddingProvider]?.label ?? "",
      model: settings.embeddingModel,
    };
  }

  private formatVaultResult(result: IndexingRunResult): string {
    return tr(
      "Semantic index обновлён: документов {seen}, изменено {changed}, удалено {documentsDeleted}; chunks embedded {embedded}, deleted {chunksDeleted}; generation {before} → {after}.",
      {
        seen: result.documentsSeen,
        changed: result.documentsChanged,
        documentsDeleted: result.documentsDeleted,
        embedded: result.chunksEmbedded,
        chunksDeleted: result.chunksDeleted,
        before: result.generationBefore,
        after: result.generationAfter,
      },
    );
  }
}

export { safeSettingsSnapshot, settingsSignature };
