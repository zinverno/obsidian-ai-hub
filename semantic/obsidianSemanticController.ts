import { App, Notice, Plugin, TFile } from "obsidian";
import type { TAbstractFile } from "obsidian";
import { t as tr } from "../i18n";
import {
  EMBEDDING_PROVIDER_PROFILES,
} from "../embeddings/types";
import type { EmbeddingSettings } from "../embeddings/types";
import {
  buildEmbeddingSpaceId,
  IndexingCompatibilityError,
  IndexingProviderError,
  IndexingSourceError,
  isMarkdownPath,
  isMarkdownTFile,
} from "../indexing";
import type {
  IndexDocumentInput,
  IndexingRunResult,
} from "../indexing";
import {
  SemanticCompatibilityError,
  SemanticNotReadyError,
  SemanticProviderError,
  SemanticSourceNotIndexedError,
  SemanticStorageError,
  SemanticValidationError,
} from "./errors";
import { AsyncReadWriteBarrier } from "./asyncReadWriteBarrier";
import {
  SemanticAutoSync,
} from "./semanticAutoSync";
import type { SemanticAutoSyncBatch } from "./semanticAutoSync";
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
  SemanticDuplicatesModal,
  SemanticSimilarNotesModal,
} from "./semanticDiscoveryModal";
import {
  resetSemanticStorage,
  semanticIndexBasePath,
} from "./semanticStorageMaintenance";
import { SemanticStoreRegistry } from "./semanticStoreRegistry";
import type {
  SemanticDocumentResult,
  SemanticDocumentSimilarity,
  SemanticDuplicatePair,
  SemanticRuntime,
  SemanticRuntimeStats,
  SemanticStatus,
} from "./types";
import { normalizeVectorStoreBasePath } from "../vectorStore";

interface SemanticPluginHost {
  app: App;
  manifest: { id: string };
  settings: {
    semantic: EmbeddingSettings;
    semanticAutoSyncSuspended?: boolean;
  };
  addCommand(command: Parameters<Plugin["addCommand"]>[0]): unknown;
  registerEvent(eventRef: Parameters<Plugin["registerEvent"]>[0]): void;
  saveSettings(): Promise<void>;
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
  openSimilarNotesModal?: (
    app: App,
    controller: ObsidianSemanticController,
    sourcePath: string,
  ) => void;
  openDuplicatesModal?: (
    app: App,
    controller: ObsidianSemanticController,
  ) => void;
  resetStorage?: typeof resetSemanticStorage;
  probeIndex?: typeof probeSemanticIndex;
  barrier?: AsyncReadWriteBarrier;
  storeRegistry?: SemanticStoreRegistry;
  autoSyncDebounceMs?: number;
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
  | "auto"
  | "clear"
  | "rebuild";

type AutomaticSyncPolicy =
  | "active"
  | "disabled"
  | "cleared"
  | "cleared-disabled"
  | "clearing"
  | "disposed";

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

interface SharedSemanticMutationState {
  queues: Map<string, Promise<void>>;
}

const SHARED_SEMANTIC_MUTATION_STATE: unique symbol = Symbol.for(
  "vault-audit-ai.semantic-mutation-state.v1",
) as never;

type GlobalWithSemanticMutationState = typeof globalThis & {
  [SHARED_SEMANTIC_MUTATION_STATE]?: SharedSemanticMutationState;
};

function sharedSemanticMutationState(): SharedSemanticMutationState {
  const root = globalThis as GlobalWithSemanticMutationState;
  const existing = root[SHARED_SEMANTIC_MUTATION_STATE];
  if (existing) return existing;
  const created: SharedSemanticMutationState = { queues: new Map() };
  root[SHARED_SEMANTIC_MUTATION_STATE] = created;
  return created;
}

function enqueueSharedSemanticMutation<T>(
  basePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const state = sharedSemanticMutationState();
  const key = normalizeVectorStoreBasePath(basePath);
  const previous = state.queues.get(key);
  const pending = previous ? previous.then(operation) : operation();
  const tail = pending.then(
    () => undefined,
    () => undefined,
  );
  state.queues.set(key, tail);
  void tail.then(() => {
    if (state.queues.get(key) === tail) state.queues.delete(key);
  });
  return pending;
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
  private readonly openSimilarNotesModal: NonNullable<
    SemanticControllerDependencies["openSimilarNotesModal"]
  >;
  private readonly openDuplicatesModal: NonNullable<
    SemanticControllerDependencies["openDuplicatesModal"]
  >;
  private readonly resetStorage: NonNullable<
    SemanticControllerDependencies["resetStorage"]
  >;
  private readonly probeIndex: NonNullable<
    SemanticControllerDependencies["probeIndex"]
  >;
  private readonly barrier: AsyncReadWriteBarrier;
  private readonly storeRegistry: SemanticStoreRegistry;
  private readonly autoSync: SemanticAutoSync;
  private runtimeSlot: RuntimeSlot | null = null;
  private operationBusy = false;
  private settingsEpoch = 0;
  private indexingQueue: Promise<void> = Promise.resolve();
  private autoSyncRegistered = false;
  private autoSyncFailureNoticed = false;
  private autoSyncPolicy: AutomaticSyncPolicy;
  private disposePromise: Promise<void> | null = null;
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
    this.openSimilarNotesModal =
      dependencies.openSimilarNotesModal ??
      ((app, controller, sourcePath) => {
        new SemanticSimilarNotesModal(app, controller, sourcePath).open();
      });
    this.openDuplicatesModal =
      dependencies.openDuplicatesModal ??
      ((app, controller) => {
        new SemanticDuplicatesModal(app, controller).open();
      });
    this.resetStorage = dependencies.resetStorage ?? resetSemanticStorage;
    this.probeIndex = dependencies.probeIndex ?? probeSemanticIndex;
    const automaticSyncSuspended =
      this.plugin.settings.semanticAutoSyncSuspended === true;
    this.autoSyncPolicy = this.plugin.settings.semantic.enabled
      ? automaticSyncSuspended
        ? "cleared"
        : "active"
      : automaticSyncSuspended
        ? "cleared-disabled"
        : "disabled";
    this.autoSync = new SemanticAutoSync({
      debounceMs: dependencies.autoSyncDebounceMs,
      flush: (batch) => this.flushAutomaticSync(batch),
      onError: (error) => this.handleAutomaticSyncError(error),
    });
    // The state machine remains dormant until Vault listeners are registered.
    this.autoSync.reconfigure({ paused: true, preservePending: false });
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
      id: "ai-semantic-find-similar-notes",
      name: tr("Найти похожие заметки"),
      callback: () => this.openSimilarNotes(),
    });
    this.plugin.addCommand({
      id: "ai-semantic-find-potential-duplicates",
      name: tr("Найти потенциальные semantic-дубликаты"),
      callback: () => this.openPotentialDuplicates(),
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

  registerAutomaticSync(): void {
    if (this.autoSyncRegistered || this.autoSyncPolicy === "disposed") return;
    this.autoSyncRegistered = true;
    this.plugin.registerEvent(
      this.plugin.app.vault.on("create", (file) => {
        if (isMarkdownTFile(file)) this.autoSync.upsert(file.path);
      }),
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on("modify", (file) => {
        if (isMarkdownTFile(file)) this.autoSync.upsert(file.path);
      }),
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on("delete", (file) => {
        if (isMarkdownTFile(file)) this.autoSync.delete(file.path);
      }),
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on("rename", (file, oldPath) => {
        this.handleAutomaticRename(file, oldPath);
      }),
    );
    this.autoSync.reconfigure({
      paused: this.autoSyncPolicy !== "active",
      preservePending: true,
    });
    this.plugin.app.workspace.onLayoutReady(() => {
      if (
        this.autoSyncPolicy === "active" &&
        this.plugin.settings.semantic.enabled
      ) {
        this.autoSync.reconcile();
      }
    });
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    if (this.autoSyncPolicy !== "disposed") {
      this.autoSyncPolicy = "disposed";
      this.autoSync.dispose();
      this.runtimeSlot = null;
    }
    this.disposePromise = this.indexingQueue.then(
      () => undefined,
      () => undefined,
    );
    return this.disposePromise;
  }

  getSemanticStatus(): SemanticStatus {
    this.reconcileCachedStatus();
    return { ...this.status };
  }

  notifySettingsChanged(): void {
    this.settingsEpoch++;
    this.runtimeSlot = null;
    if (this.autoSyncPolicy !== "disposed") {
      const suppressedByClear =
        this.autoSyncPolicy === "cleared" ||
        this.autoSyncPolicy === "cleared-disabled";
      if (!this.plugin.settings.semantic.enabled) {
        this.autoSyncPolicy = suppressedByClear
          ? "cleared-disabled"
          : "disabled";
        this.autoSync.reconfigure({ paused: true, preservePending: true });
      } else if (suppressedByClear) {
        this.autoSyncPolicy = "cleared";
        this.autoSync.reconfigure({ paused: true, preservePending: true });
      } else {
        this.autoSyncPolicy = "active";
        this.autoSync.reconfigure({
          paused: !this.autoSyncRegistered,
          preservePending: true,
          reconcile: this.autoSyncRegistered,
        });
      }
    }
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

  openSimilarNotes(): void {
    if (!this.ensureEnabled()) return;
    const file = this.plugin.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") {
      this.notice(tr("Откройте Markdown-заметку для поиска похожих заметок."));
      return;
    }
    this.openSimilarNotesModal(this.plugin.app, this, file.path);
  }

  openPotentialDuplicates(): void {
    if (!this.ensureEnabled()) return;
    this.openDuplicatesModal(this.plugin.app, this);
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

  async findSimilarNotes(
    sourcePath: string,
  ): Promise<SemanticDocumentSimilarity[]> {
    return this.barrier.withShared(async () => {
      const runtime = await this.runtimeForDiscovery();
      return runtime.findSimilarNotes(sourcePath, {
        limit: 10,
        matchesPerDocument: 3,
      });
    });
  }

  async findPotentialDuplicates(): Promise<SemanticDuplicatePair[]> {
    return this.barrier.withShared(async () => {
      const runtime = await this.runtimeForDiscovery();
      return runtime.findPotentialDuplicates({
        limit: 100,
        matchesPerDocument: 3,
      });
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

      await this.enqueueIndexMutation(() =>
        this.barrier.withShared(async () => {
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
            await this.activateAutomaticSync();
            this.autoSyncFailureNoticed = false;
            this.notice(this.formatVaultResult(result), 10000);
          } finally {
            progress.hide();
          }
        }),
      );
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
      await this.enqueueIndexMutation(() =>
        this.barrier.withShared(async () => {
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
          if (preflight.state === "absent") {
            this.status = this.defaultStatus("not-initialized", snapshot);
            this.notice(
              tr("Семантический индекс пуст. Сначала обновите индекс Vault."),
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
          await this.activateAutomaticSync();
          this.autoSyncFailureNoticed = false;
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
        }),
      );
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

      await this.enqueueIndexMutation(async () => {
        await this.persistAutomaticSyncSuspended(true);
        if (this.autoSyncPolicy === "disposed") return;

        this.autoSyncPolicy = "clearing";
        this.autoSync.clearAndPause();
        try {
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
        } finally {
          if (!this.isDisposed()) {
            this.autoSyncPolicy = this.plugin.settings.semantic.enabled
              ? "cleared"
              : "cleared-disabled";
          }
        }
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

      await this.enqueueIndexMutation(() =>
        this.barrier.withExclusive(async () => {
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
            await this.activateAutomaticSync();
            this.autoSyncFailureNoticed = false;
            this.notice(this.formatVaultResult(result), 10000);
          } finally {
            progress.hide();
          }
        }),
      );
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
    if (error instanceof SemanticSourceNotIndexedError) {
      return tr("Текущая заметка отсутствует в семантическом индексе.");
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

  private handleAutomaticRename(
    file: TAbstractFile,
    oldPath: string,
  ): void {
    const oldWasMarkdown = isMarkdownPath(oldPath);
    const newIsMarkdown = isMarkdownTFile(file);
    if (oldWasMarkdown && newIsMarkdown) {
      this.autoSync.rename(oldPath, file.path);
    } else if (oldWasMarkdown) {
      this.autoSync.delete(oldPath);
    } else if (newIsMarkdown) {
      this.autoSync.upsert(file.path);
    }
  }

  private async runtimeForDiscovery(): Promise<SemanticRuntime> {
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
    this.updateReadyStatus(runtime);
    return runtime;
  }

  private async flushAutomaticSync(
    batch: SemanticAutoSyncBatch,
  ): Promise<void> {
    await this.enqueueIndexMutation(() =>
      this.barrier.withShared(async () => {
        if (
          this.autoSyncPolicy !== "active" ||
          !this.plugin.settings.semantic.enabled ||
          !this.autoSync.isCurrentEpoch(batch.epoch)
        ) {
          return;
        }
        const snapshot = safeSettingsSnapshot(this.plugin.settings.semantic);
        const settingsEpoch = this.settingsEpoch;
        const runtime = await this.runtimeForSnapshot(
          snapshot,
          settingsEpoch,
          "auto",
        );
        if (!runtime) {
          this.status = this.defaultStatus("not-initialized", snapshot);
          return;
        }
        const shouldCommit = () =>
          this.autoSyncPolicy === "active" &&
          this.plugin.settings.semantic.enabled &&
          this.autoSync.isCurrentEpoch(batch.epoch) &&
          this.snapshotIsCurrent(snapshot, settingsEpoch);
        this.status = this.defaultStatus("indexing", snapshot);
        if (batch.reconcileAll) {
          await runtime.indexVault({ shouldCommit });
        } else {
          await runtime.syncPaths(
            {
              upsertPaths: batch.upsertPaths,
              deletePaths: batch.deletePaths,
            },
            { shouldCommit },
          );
        }
        if (!shouldCommit()) return;
        this.updateReadyStatus(runtime);
        this.autoSyncFailureNoticed = false;
      }),
    );
  }

  private handleAutomaticSyncError(error: unknown): void {
    if (
      this.autoSyncPolicy !== "active" ||
      !this.plugin.settings.semantic.enabled
    ) {
      return;
    }
    this.captureErrorStatus(error);
    if (this.autoSyncFailureNoticed) return;
    this.autoSyncFailureNoticed = true;
    this.showError(error);
  }

  private async activateAutomaticSync(): Promise<void> {
    if (
      this.autoSyncPolicy === "disposed" ||
      (this.autoSyncPolicy === "active" &&
        this.plugin.settings.semanticAutoSyncSuspended !== true)
    ) {
      return;
    }
    await this.persistAutomaticSyncSuspended(false);
    if (this.isDisposed()) return;
    if (!this.plugin.settings.semantic.enabled) {
      this.autoSyncPolicy = "disabled";
      this.autoSync.reconfigure({ paused: true, preservePending: true });
      return;
    }
    this.autoSyncPolicy = "active";
    this.autoSync.reconfigure({
      paused: !this.autoSyncRegistered,
      preservePending: true,
    });
  }

  private async persistAutomaticSyncSuspended(
    suspended: boolean,
  ): Promise<void> {
    const previous =
      this.plugin.settings.semanticAutoSyncSuspended === true;
    if (previous === suspended) return;
    this.plugin.settings.semanticAutoSyncSuspended = suspended;
    try {
      await this.plugin.saveSettings();
    } catch {
      this.plugin.settings.semanticAutoSyncSuspended = previous;
      throw new SemanticStorageError(
        "Semantic automatic-sync state could not be persisted safely.",
      );
    }
  }

  private enqueueIndexMutation(operation: () => Promise<void>): Promise<void> {
    const pending = this.indexingQueue.then(() => {
      if (this.isDisposed()) return;
      return enqueueSharedSemanticMutation(this.basePath(), async () => {
        if (this.isDisposed()) return;
        await operation();
      });
    });
    this.indexingQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private isDisposed(): boolean {
    return this.autoSyncPolicy === "disposed";
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
