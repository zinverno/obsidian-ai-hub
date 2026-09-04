import { beforeEach, describe, expect, it, vi } from "vitest";

const obsidianMocks = vi.hoisted(() => {
  class TFile {
    path = "";
    extension = "md";
  }
  return { TFile };
});

vi.mock("obsidian", () => ({
  App: class {},
  Plugin: class {},
  TFile: obsidianMocks.TFile,
  Notice: class {
    hide(): void {}
  },
  Modal: class {
    constructor(_app: unknown) {}
    open() {}
    close() {}
  },
  ButtonComponent: class {},
  MarkdownView: class {},
  normalizePath: (value: string) => value,
  getLanguage: () => "ru",
  requestUrl: vi.fn(),
}));

import type { Command } from "obsidian";
import type { AIHubSettings } from "../settings";
import { buildEmbeddingSpaceId } from "../indexing";
import {
  RagSettingsError,
} from "../rag/errors";
import type {
  RagContext,
} from "../rag/types";
import { ObsidianSemanticController } from "../semantic/obsidianSemanticController";
import type { SemanticRuntime } from "../semantic/types";
import type { CompanionSyncPort } from "../companionSync";

const INDEX_RESULT = {
  mode: "reconcile" as const,
  documentsSeen: 1,
  documentsChanged: 1,
  documentsUnchanged: 0,
  documentsDeleted: 0,
  chunksSeen: 1,
  chunksEmbedded: 1,
  chunksDeleted: 0,
  generationBefore: 1,
  generationAfter: 2,
};

function settings(): AIHubSettings {
  return {
    provider: "openrouter",
    apiKey: "llm-key-old",
    model: "llm-model-old",
    baseUrl: "https://llm.example/v1",
    temperature: 0.2,
    topK: 12,
    defaultInsertion: "end",
    newNoteFolder: "",
    filenameTemplate: "AI",
    mocFolder: "MOCs/",
    atomsLocation: "same",
    atomsFolder: "Atoms/",
    showContextMenu: true,
    notifyOnCopy: true,
    language: "ru",
    deepAudit: {
      batchSize: 5,
      maxConcurrent: 3,
      delayMs: 1000,
    },
    semantic: {
      enabled: true,
      embeddingProvider: "openai-compatible",
      embeddingModel: "embed-model",
      embeddingBaseUrl: "https://embed.example/v1",
      openRouterApiKey: "",
      openAICompatibleApiKey: "embed-key",
    },
    semanticAutoSyncSuspended: false,
    companion: {
      enabled: false,
      endpoint: "http://127.0.0.1:27124",
      token: "",
      timeoutMs: 5000,
      vaultId: "11111111-1111-4111-8111-111111111111",
    },
  };
}

function ragContext(text = "old frozen source"): RagContext {
  return Object.freeze({
    usedCodePoints: Array.from(text).length,
    sources: Object.freeze([
      Object.freeze({
        id: "S1",
        path: "A.md",
        headingPath: Object.freeze(["A"]),
        chunkId: "a",
        contentHash: "hash-a",
        source: Object.freeze({
          startOffset: 0,
          endOffset: text.length,
          startLine: 0,
          endLine: 0,
        }),
        score: 1,
        text,
      }),
    ]),
  });
}

function manualGate() {
  let enter = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { enter, entered, release, wait };
}

function fakeRuntime(initialContext = ragContext()) {
  let count = 1;
  let generation = 1;
  let currentContext = initialContext;
  const runtime: SemanticRuntime = {
    initialize: vi.fn(async () => undefined),
    indexVault: vi.fn(async () => {
      count = 1;
      generation++;
      return { ...INDEX_RESULT, generationAfter: generation };
    }),
    indexDocument: vi.fn(async () => INDEX_RESULT),
    syncPaths: vi.fn(async () => {
      generation++;
      return {
        ...INDEX_RESULT,
        mode: "sync" as const,
        generationAfter: generation,
      };
    }),
    search: vi.fn(async () => []),
    buildRagContext: vi.fn(async () => currentContext),
    findSimilarNotes: vi.fn(async () => []),
    findPotentialDuplicates: vi.fn(async () => []),
    captureCompanionSnapshot: vi.fn(async () => ({
      generation,
      descriptor: {
        providerId: "openai-compatible",
        model: "embed-model",
        baseUrl: "https://embed.example/v1",
        dimensions: 3,
        embeddingSpaceId: "space",
        normalized: true as const,
      },
      notes: [],
    })),
    clear: vi.fn(async () => {
      count = 0;
      generation++;
    }),
    getStats: vi.fn(() => ({
      initialized: true,
      indexing: false,
      vectorCount: count,
      vectorGeneration: generation,
      dimensions: 3,
      embeddingSpaceId: "space",
    })),
  };
  return {
    runtime,
    setContext(value: RagContext) {
      currentContext = value;
    },
  };
}

function createHarness(companionService?: CompanionSyncPort) {
  const pluginSettings = settings();
  const commands: Command[] = [];
  const notices: string[] = [];
  const vaultListeners = new Map<
    string,
    Array<(...args: unknown[]) => void>
  >();
  const plugin = {
    app: {
      vault: {
        configDir: ".obsidian",
        adapter: {},
        getMarkdownFiles: vi.fn(() => []),
        on: vi.fn((name: string, callback: (...args: unknown[]) => void) => {
          const listeners = vaultListeners.get(name) ?? [];
          listeners.push(callback);
          vaultListeners.set(name, listeners);
          return { name, callback };
        }),
      },
      workspace: {
        getActiveFile: vi.fn(() => null),
        onLayoutReady: vi.fn(),
      },
      metadataCache: {
        getFileCache: vi.fn(() => null),
      },
    },
    manifest: { id: "ai-knowledge-hub" },
    settings: pluginSettings,
    addCommand: vi.fn((command: Command) => {
      commands.push(command);
      return command;
    }),
    registerEvent: vi.fn(),
    saveSettings: vi.fn(async () => undefined),
  };
  const first = fakeRuntime();
  const runtimes = [first, fakeRuntime()];
  const runtimeFactory = vi.fn(() => {
    const next = runtimes.shift();
    if (!next) throw new Error("No runtime available");
    return next.runtime;
  });
  const openAskVaultModal = vi.fn();
  const confirm = vi.fn(async () => true);
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
  const streamLanguageModel = vi.fn(async (
    _settings: AIHubSettings,
    _system: string,
    _user: string,
    onToken: (token: string) => void,
  ) => {
    onToken("answer [S1]");
  });
  const controller = new ObsidianSemanticController(plugin as never, {
    runtimeFactory,
    openAskVaultModal,
    streamLanguageModel,
    confirm,
    resetStorage,
    probeIndex,
    autoSyncDebounceMs: 0,
    companionService,
    notice: (message) => {
      notices.push(message);
      return { hide() {} };
    },
  });
  return {
    commands,
    confirm,
    controller,
    first,
    notices,
    openAskVaultModal,
    plugin,
    probeIndex,
    resetStorage,
    runtimeFactory,
    streamLanguageModel,
    vaultListeners,
  };
}

async function flushTask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

beforeEach(() => {
  vi.stubGlobal("window", {
    setTimeout,
    clearTimeout,
  });
});

describe("Ask your Vault controller integration", () => {
  it("registers a stable command and opens the modal without eager runtime work", () => {
    const harness = createHarness();
    harness.controller.registerCommands();
    const command = harness.commands.find(
      (candidate) => candidate.id === "ai-rag-ask-vault",
    );

    expect(command).toBeDefined();
    command?.callback?.();

    expect(harness.openAskVaultModal).toHaveBeenCalledWith(
      harness.plugin.app,
      harness.controller,
    );
    expect(harness.runtimeFactory).not.toHaveBeenCalled();
  });

  it("does not silently enable semantic features", () => {
    const harness = createHarness();
    harness.plugin.settings.semantic.enabled = false;
    harness.controller.openAskVault();

    expect(harness.openAskVaultModal).not.toHaveBeenCalled();
    expect(harness.notices).toContain("Включите semantic-функции в настройках");
  });

  it("captures one LLM configuration before context materialization", async () => {
    const harness = createHarness();
    const gate = manualGate();
    vi.mocked(harness.first.runtime.buildRagContext).mockImplementation(
      async () => {
        gate.enter();
        await gate.wait;
        return ragContext();
      },
    );
    const pending = harness.controller.askVault(
      "question",
      {},
      new AbortController().signal,
    );
    await gate.entered;

    harness.plugin.settings.apiKey = "llm-key-new";
    harness.plugin.settings.model = "llm-model-new";
    harness.plugin.settings.baseUrl = "https://new.example/v1";
    gate.release();
    await pending;

    const captured = harness.streamLanguageModel.mock.calls[0][0];
    expect(captured).toMatchObject({
      apiKey: "llm-key-old",
      model: "llm-model-old",
      baseUrl: "https://llm.example/v1",
    });
    expect(harness.first.runtime.buildRagContext).toHaveBeenCalledOnce();
  });

  it("fails invalid LLM settings before semantic retrieval", async () => {
    const harness = createHarness();
    harness.plugin.settings.apiKey = "";

    await expect(harness.controller.askVault(
      "question",
      {},
      new AbortController().signal,
    )).rejects.toBeInstanceOf(RagSettingsError);

    expect(harness.runtimeFactory).not.toHaveBeenCalled();
    expect(harness.streamLanguageModel).not.toHaveBeenCalled();
  });

  it("allows automatic semantic sync to commit during generation", async () => {
    const harness = createHarness();
    harness.controller.registerAutomaticSync();
    const streamGate = manualGate();
    harness.streamLanguageModel.mockImplementation(async (
      _settings,
      _system,
      _user,
      onToken,
    ) => {
      streamGate.enter();
      await streamGate.wait;
      onToken("old answer [S1]");
    });
    const pending = harness.controller.askVault(
      "question",
      {},
      new AbortController().signal,
    );
    await streamGate.entered;

    const file = new obsidianMocks.TFile();
    file.path = "A.md";
    harness.vaultListeners.get("modify")?.[0]?.(file);
    await flushTask();

    expect(harness.first.runtime.syncPaths).toHaveBeenCalledOnce();
    streamGate.release();
    const answer = await pending;
    expect(answer.context.sources[0].text).toBe("old frozen source");
  });

  it("allows Clear to finish after context freezes while generation continues", async () => {
    const harness = createHarness();
    const streamGate = manualGate();
    harness.streamLanguageModel.mockImplementation(async (
      _settings,
      _system,
      _user,
      onToken,
    ) => {
      streamGate.enter();
      await streamGate.wait;
      onToken("answer [S1]");
    });
    const pending = harness.controller.askVault(
      "question",
      {},
      new AbortController().signal,
    );
    await streamGate.entered;

    await harness.controller.clearIndex();

    expect(harness.first.runtime.clear).toHaveBeenCalledOnce();
    expect(harness.streamLanguageModel).not.toHaveResolved();
    streamGate.release();
    await pending;
  });

  it("allows Rebuild to finish after context freezes while the old answer continues", async () => {
    const harness = createHarness();
    const streamGate = manualGate();
    harness.streamLanguageModel.mockImplementation(async (
      _settings,
      _system,
      _user,
      onToken,
    ) => {
      streamGate.enter();
      await streamGate.wait;
      onToken("answer from old context [S1]");
    });
    const pending = harness.controller.askVault(
      "question",
      {},
      new AbortController().signal,
    );
    await streamGate.entered;

    await harness.controller.rebuildIndex();

    expect(harness.resetStorage).toHaveBeenCalledOnce();
    expect(harness.runtimeFactory).toHaveBeenCalledTimes(2);
    streamGate.release();
    const result = await pending;
    expect(result.answer).toContain("old context");
    expect(result.context.sources[0].text).toBe("old frozen source");
  });

  it("keeps a frozen prompt when future semantic state changes", async () => {
    const harness = createHarness();
    let sentUser = "";
    const streamGate = manualGate();
    harness.streamLanguageModel.mockImplementation(async (
      _settings,
      _system,
      user,
      onToken,
    ) => {
      sentUser = user;
      streamGate.enter();
      await streamGate.wait;
      onToken("answer [S1]");
    });
    const pending = harness.controller.askVault(
      "question",
      {},
      new AbortController().signal,
    );
    await streamGate.entered;

    harness.first.setContext(ragContext("future replacement source"));
    await harness.first.runtime.syncPaths({
      upsertPaths: ["A.md"],
      deletePaths: [],
    });
    streamGate.release();
    await pending;

    expect(sentUser).toContain("old frozen source");
    expect(sentUser).not.toContain("future replacement source");
  });

  it("keeps Ask your Vault usable while Companion is slow", async () => {
    const gate = manualGate();
    const companion: CompanionSyncPort = {
      getStatus: vi.fn(() => ({ kind: "syncing" as const })),
      invalidateConfiguration: vi.fn(),
      testConnection: vi.fn(async () => undefined),
      reconcile: vi.fn(async () => { await gate.wait; }),
      enqueueIncremental: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    const harness = createHarness(companion);
    harness.plugin.settings.companion.enabled = true;
    harness.plugin.settings.companion.token = "companion-secret";
    await harness.controller.indexVault();
    expect(companion.reconcile).toHaveBeenCalledOnce();

    const result = await harness.controller.askVault(
      "question",
      {},
      new AbortController().signal,
    );

    expect(result.answer).toBe("answer [S1]");
    expect(result.context.sources[0].text).toBe("old frozen source");
    gate.release();
  });
});
