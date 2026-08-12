import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  App: class {},
  Plugin: class {},
  TFile: class {},
  Notice: class {
    hide(): void {}
  },
  Modal: class {
    app: unknown;
    titleEl = {};
    contentEl = {};
    constructor(app: unknown) {
      this.app = app;
    }
    open() {}
    close() {}
  },
  ButtonComponent: class {},
  MarkdownView: class {},
  normalizePath: (value: string) => value,
  getLanguage: () => "ru",
  requestUrl: vi.fn(),
}));

import type { EmbeddingSettings } from "../embeddings/types";
import { buildEmbeddingSpaceId } from "../indexing";
import { TFile } from "obsidian";
import { SemanticCompatibilityError } from "./errors";
import { AsyncReadWriteBarrier } from "./asyncReadWriteBarrier";
import {
  ObsidianSemanticController,
} from "./obsidianSemanticController";
import type {
  SemanticControllerDependencies,
} from "./obsidianSemanticController";
import type { SemanticRuntime } from "./types";

const RESULT = {
  mode: "reconcile" as const,
  documentsSeen: 1,
  documentsChanged: 1,
  documentsUnchanged: 0,
  documentsDeleted: 0,
  chunksSeen: 1,
  chunksEmbedded: 1,
  chunksDeleted: 0,
  generationBefore: 0,
  generationAfter: 1,
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function semantic(
  overrides: Partial<EmbeddingSettings> = {},
): EmbeddingSettings {
  return {
    enabled: true,
    embeddingProvider: "openai-compatible",
    embeddingModel: "model-a",
    embeddingBaseUrl: "https://example.test/v1",
    openRouterApiKey: "",
    openAICompatibleApiKey: "sk-private",
    ...overrides,
  };
}

function fakeRuntime(overrides: Partial<SemanticRuntime> = {}): SemanticRuntime {
  let initialized = false;
  let count = 0;
  let generation = 0;
  const runtime: SemanticRuntime = {
    initialize: vi.fn(async () => {
      initialized = true;
    }),
    indexVault: vi.fn(async () => {
      initialized = true;
      count = 1;
      generation++;
      return { ...RESULT, generationAfter: generation };
    }),
    indexDocument: vi.fn(async () => {
      initialized = true;
      count = 1;
      generation++;
      return {
        ...RESULT,
        mode: "partial" as const,
        generationAfter: generation,
      };
    }),
    syncPaths: vi.fn(async () => {
      initialized = true;
      count = 1;
      generation++;
      return {
        ...RESULT,
        mode: "sync" as const,
        generationAfter: generation,
      };
    }),
    search: vi.fn(async () => []),
    clear: vi.fn(async () => {
      initialized = true;
      count = 0;
      generation++;
    }),
    getStats: vi.fn(() => ({
      initialized,
      indexing: false,
      vectorCount: count,
      vectorGeneration: generation,
      dimensions: initialized ? 3 : 0,
      embeddingSpaceId: initialized ? "space" : "",
    })),
    ...overrides,
  };
  return runtime;
}

function createHarness(
  settings = semantic(),
  dependencyOverrides: SemanticControllerDependencies = {},
) {
  const commands: Array<{
    id: string;
    callback?: () => unknown;
  }> = [];
  const notices: string[] = [];
  const activeFile = Object.assign(Object.create(TFile.prototype), {
    path: "Alpha.md",
    extension: "md",
  }) as TFile;
  const files = [activeFile];
  const app = {
    vault: {
      configDir: ".config",
      adapter: {
        exists: vi.fn(async () => false),
        remove: vi.fn(async () => undefined),
      },
      getMarkdownFiles: vi.fn(() => files),
      cachedRead: vi.fn(async () => "alpha body"),
    },
    metadataCache: {
      getFileCache: vi.fn(() => null),
    },
    workspace: {
      getActiveFile: vi.fn(() => files[0]),
    },
  };
  const plugin = {
    app,
    manifest: { id: "ai-knowledge-hub" },
    settings: {
      semantic: settings,
      semanticAutoSyncSuspended: false,
    },
    addCommand: vi.fn((command) => {
      commands.push(command);
      return command;
    }),
    saveSettings: vi.fn(async () => undefined),
  };
  const runtimes: SemanticRuntime[] = [];
  const runtimeFactory = vi.fn((_input: any) => {
    const runtime = fakeRuntime();
    runtimes.push(runtime);
    return runtime;
  });
  const confirm = vi.fn(async () => true);
  const openSearchModal = vi.fn();
  const resetStorage = vi.fn(async () => undefined);
  const probeIndex = vi.fn(async () => ({
    state: "present" as const,
    source: "main" as const,
    descriptor: {
      dimensions: 3,
      embeddingSpaceId: buildEmbeddingSpaceId({
        providerId: plugin.settings.semantic.embeddingProvider,
        model: plugin.settings.semantic.embeddingModel,
        baseUrl: plugin.settings.semantic.embeddingBaseUrl,
        dimensions: 3,
      }),
      generation: 1,
      count: 1,
    },
  }));
  const controller = new ObsidianSemanticController(plugin as never, {
    runtimeFactory,
    confirm,
    openSearchModal,
    resetStorage,
    probeIndex,
    notice: (message) => {
      notices.push(message);
      return { hide() {} };
    },
    ...dependencyOverrides,
  });
  return {
    controller,
    plugin,
    app,
    commands,
    notices,
    runtimes,
    runtimeFactory,
    confirm,
    openSearchModal,
    resetStorage,
    probeIndex,
  };
}

describe("ObsidianSemanticController commands and lazy behavior", () => {
  beforeEach(() => vi.clearAllMocks());

  it("registers all semantic commands without runtime or Vault reads", () => {
    const harness = createHarness();
    harness.controller.registerCommands();
    expect(harness.commands.map((command) => command.id)).toEqual([
      "ai-semantic-search",
      "ai-semantic-index-vault",
      "ai-semantic-index-current-note",
      "ai-semantic-clear-index",
      "ai-semantic-rebuild-index",
    ]);
    expect(harness.runtimeFactory).not.toHaveBeenCalled();
    expect(harness.app.vault.getMarkdownFiles).not.toHaveBeenCalled();
    expect(harness.app.vault.cachedRead).not.toHaveBeenCalled();
  });

  it("keeps disabled commands visible but performs no semantic work", () => {
    const harness = createHarness(semantic({ enabled: false }));
    harness.controller.registerCommands();
    for (const command of harness.commands) command.callback?.();
    expect(harness.runtimeFactory).not.toHaveBeenCalled();
    expect(harness.openSearchModal).not.toHaveBeenCalled();
    expect(harness.app.vault.getMarkdownFiles).not.toHaveBeenCalled();
    expect(harness.notices).toContain(
      "Включите semantic-функции в настройках",
    );
  });

  it("opens search without constructing the runtime", () => {
    const harness = createHarness();
    harness.controller.openSearch();
    expect(harness.openSearchModal).toHaveBeenCalledOnce();
    expect(harness.runtimeFactory).not.toHaveBeenCalled();
  });

  it("does nothing when full-index confirmation is declined", async () => {
    const harness = createHarness();
    harness.confirm.mockResolvedValue(false);
    await harness.controller.indexVault();
    expect(harness.confirm).toHaveBeenCalledOnce();
    expect(harness.runtimeFactory).not.toHaveBeenCalled();
    expect(harness.app.vault.cachedRead).not.toHaveBeenCalled();
  });

  it("runs a confirmed full index with an immutable settings snapshot", async () => {
    const harness = createHarness();
    await harness.controller.indexVault();
    expect(harness.runtimeFactory).toHaveBeenCalledOnce();
    const input = harness.runtimeFactory.mock.calls[0][0];
    expect(input.settings).toEqual(harness.plugin.settings.semantic);
    expect(input.settings).not.toBe(harness.plugin.settings.semantic);
    expect(harness.runtimes[0].indexVault).toHaveBeenCalledOnce();
  });

  it("reads and indexes only the active Markdown note", async () => {
    const harness = createHarness();
    await harness.controller.indexCurrentNote();
    expect(harness.app.vault.cachedRead).toHaveBeenCalledOnce();
    expect(harness.app.vault.getMarkdownFiles).not.toHaveBeenCalled();
    expect(harness.runtimes[0].indexDocument).toHaveBeenCalledWith({
      path: "Alpha.md",
      content: "alpha body",
      cache: null,
    });
    expect(harness.runtimes[0].indexVault).not.toHaveBeenCalled();
  });

  it("requires confirmations for clear and rebuild", async () => {
    const clearHarness = createHarness();
    await clearHarness.controller.clearIndex();
    expect(clearHarness.confirm).toHaveBeenCalledOnce();
    expect(clearHarness.runtimes[0].clear).toHaveBeenCalledOnce();

    const rebuildHarness = createHarness();
    await rebuildHarness.controller.rebuildIndex();
    expect(rebuildHarness.confirm).toHaveBeenCalledOnce();
    expect(rebuildHarness.resetStorage).toHaveBeenCalledOnce();
    expect(rebuildHarness.runtimes[0].indexVault).toHaveBeenCalledOnce();
  });

  it("blocks overlapping mutating operations", async () => {
    const harness = createHarness();
    let resolveConfirmation: (value: boolean) => void = () => {};
    harness.confirm.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirmation = resolve;
        }),
    );
    const first = harness.controller.indexVault();
    await Promise.resolve();
    const second = harness.controller.clearIndex();
    await second;
    expect(harness.confirm).toHaveBeenCalledOnce();
    expect(harness.notices).toContain(
      "Другая операция с семантическим индексом уже выполняется.",
    );
    resolveConfirmation(false);
    await first;
  });

  it("releases busy state after failure", async () => {
    const harness = createHarness();
    const runtime = fakeRuntime({
      indexVault: vi
        .fn()
        .mockRejectedValueOnce(new Error("failure"))
        .mockResolvedValueOnce(RESULT),
    });
    harness.runtimeFactory.mockReturnValue(runtime);
    await harness.controller.indexVault();
    await harness.controller.indexVault();
    expect(runtime.indexVault).toHaveBeenCalledTimes(2);
    expect(harness.confirm).toHaveBeenCalledTimes(2);
  });

  it("replaces the runtime when provider settings change", async () => {
    const harness = createHarness();
    await harness.controller.refreshSemanticStatus();
    harness.plugin.settings.semantic.embeddingModel = "model-b";
    await harness.controller.refreshSemanticStatus();
    expect(harness.runtimeFactory).toHaveBeenCalledTimes(2);
    expect(
      harness.runtimeFactory.mock.calls.map(
        (call) => call[0].settings.embeddingModel,
      ),
    ).toEqual(["model-a", "model-b"]);
  });

  it("does not reactivate a delayed runtime from an old settings epoch", async () => {
    const oldProbe = deferred<{
      state: "present";
      source: "main";
      descriptor: {
        dimensions: number;
        embeddingSpaceId: string;
        generation: number;
        count: number;
      };
    }>();
    const probeIndex = vi
      .fn()
      .mockImplementationOnce(() => oldProbe.promise)
      .mockImplementation(async () => ({
        state: "present" as const,
        source: "main" as const,
        descriptor: {
          dimensions: 3,
          embeddingSpaceId: buildEmbeddingSpaceId({
            providerId: "openai-compatible",
            model: "model-b",
            baseUrl: "https://example.test/v1",
            dimensions: 3,
          }),
          generation: 1,
          count: 1,
        },
      }));
    const created: Array<{
      model: string;
      runtime: SemanticRuntime;
    }> = [];
    const runtimeFactory = vi.fn((input: { settings: EmbeddingSettings }) => {
      const runtime = fakeRuntime();
      created.push({ model: input.settings.embeddingModel, runtime });
      return runtime;
    });
    const harness = createHarness(semantic(), {
      probeIndex,
      runtimeFactory: runtimeFactory as never,
    });

    const staleRefresh = harness.controller.refreshSemanticStatus();
    await vi.waitFor(() => expect(probeIndex).toHaveBeenCalledOnce());
    harness.plugin.settings.semantic.embeddingModel = "model-b";
    harness.controller.notifySettingsChanged();
    oldProbe.resolve({
      state: "present",
      source: "main",
      descriptor: {
        dimensions: 3,
        embeddingSpaceId: buildEmbeddingSpaceId({
          providerId: "openai-compatible",
          model: "model-a",
          baseUrl: "https://example.test/v1",
          dimensions: 3,
        }),
        generation: 1,
        count: 1,
      },
    });
    await staleRefresh;

    const afterStale = (
      harness.controller as unknown as {
        runtimeSlot: { runtime: SemanticRuntime } | null;
      }
    ).runtimeSlot;
    expect(afterStale).toBeNull();

    await harness.controller.refreshSemanticStatus();
    const current = (
      harness.controller as unknown as {
        runtimeSlot: { runtime: SemanticRuntime } | null;
      }
    ).runtimeSlot;
    expect(created.map((entry) => entry.model)).toEqual([
      "model-a",
      "model-b",
    ]);
    expect(current?.runtime).toBe(created[1].runtime);
    expect(current?.runtime).not.toBe(created[0].runtime);
  });

  it("uses the selected key in the in-memory runtime signature", async () => {
    const harness = createHarness();
    await harness.controller.refreshSemanticStatus();
    harness.plugin.settings.semantic.openAICompatibleApiKey = "sk-new";
    await harness.controller.refreshSemanticStatus();
    expect(harness.runtimeFactory).toHaveBeenCalledTimes(2);
    expect(harness.notices.join(" ")).not.toContain("sk-new");
  });

  it("shows the safe compatibility message without resetting storage", async () => {
    const harness = createHarness();
    const runtime = fakeRuntime({
      initialize: vi.fn(async () => {
        throw new SemanticCompatibilityError(
          new Error("https://user:secret@example.test"),
        );
      }),
    });
    harness.runtimeFactory.mockReturnValue(runtime);
    await harness.controller.refreshSemanticStatus();
    expect(harness.controller.getSemanticStatus().kind).toBe(
      "incompatible",
    );
    expect(harness.resetStorage).not.toHaveBeenCalled();
    expect(harness.notices.join(" ")).toContain(
      "Семантический индекс создан другой embedding-моделью",
    );
    expect(harness.notices.join(" ")).not.toContain("secret");
  });

  it("refreshes a missing index without constructing a runtime", async () => {
    const probeIndex = vi.fn(async () => ({ state: "absent" as const }));
    const harness = createHarness(semantic(), { probeIndex });
    await expect(harness.controller.refreshSemanticStatus()).resolves.toMatchObject({
      kind: "not-initialized",
      vectorCount: 0,
      dimensions: 0,
    });
    expect(probeIndex).toHaveBeenCalledOnce();
    expect(harness.runtimeFactory).not.toHaveBeenCalled();
    expect(harness.app.vault.cachedRead).not.toHaveBeenCalled();
  });

  it("re-checks enabled after waiting for a shared lease", async () => {
    const barrier = new AsyncReadWriteBarrier();
    const exclusive = await barrier.acquireExclusive();
    const harness = createHarness(semantic(), { barrier });
    const pending = harness.controller.refreshSemanticStatus();
    await Promise.resolve();

    harness.plugin.settings.semantic.enabled = false;
    harness.controller.notifySettingsChanged();
    exclusive.release();

    await expect(pending).resolves.toMatchObject({ kind: "disabled" });
    expect(harness.probeIndex).not.toHaveBeenCalled();
    expect(harness.runtimeFactory).not.toHaveBeenCalled();
  });
});
