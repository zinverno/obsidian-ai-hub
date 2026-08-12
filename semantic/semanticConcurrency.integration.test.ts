import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const obsidianMocks = vi.hoisted(() => ({
  requestUrl: vi.fn(),
}));

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
  normalizePath: (value: string) => value.replace(/\/{2,}/g, "/"),
  getLanguage: () => "ru",
  requestUrl: obsidianMocks.requestUrl,
}));

import { TFile } from "obsidian";
import type { EmbeddingSettings } from "../embeddings/types";
import { BaseEmbeddingProvider } from "../embeddings/shared";
import {
  decodeVectorBinary,
  LocalVectorStore,
  VECTOR_BINARY_FILE,
  VECTOR_MANIFEST_FILE,
} from "../vectorStore";
import type { VectorStoreManifest } from "../vectorStore";
import {
  SemanticCompatibilityError,
  SemanticNotReadyError,
} from "./errors";
import { ObsidianSemanticController } from "./obsidianSemanticController";
import {
  resetSemanticStorage,
  semanticIndexBasePath,
} from "./semanticStorageMaintenance";
import { SemanticStoreRegistry } from "./semanticStoreRegistry";
import type { SemanticRuntime } from "./types";

const BASE_PATH = semanticIndexBasePath(".obsidian", "ai-knowledge-hub");

type StoredValue =
  | { kind: "text"; value: string }
  | { kind: "binary"; value: ArrayBuffer };

class MemoryDataAdapter {
  readonly files = new Map<string, StoredValue>();
  readonly directories = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async read(path: string): Promise<string> {
    const stored = this.files.get(path);
    if (stored?.kind !== "text") throw new Error(`Missing text: ${path}`);
    return stored.value;
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const stored = this.files.get(path);
    if (stored?.kind !== "binary") throw new Error(`Missing binary: ${path}`);
    return stored.value.slice(0);
  }

  async write(path: string, value: string): Promise<void> {
    this.files.set(path, { kind: "text", value });
  }

  async writeBinary(path: string, value: ArrayBuffer): Promise<void> {
    this.files.set(path, { kind: "binary", value: value.slice(0) });
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(path);
  }

  async remove(path: string): Promise<void> {
    if (!this.files.delete(path) && !this.directories.delete(path)) {
      throw new Error(`Missing path: ${path}`);
    }
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    const stored = this.files.get(fromPath);
    if (!stored) throw new Error(`Missing path: ${fromPath}`);
    this.files.set(toPath, stored);
    this.files.delete(fromPath);
  }
}

interface ManualGate {
  entered: Promise<void>;
  wait: Promise<void>;
  markEntered(): void;
  release(): void;
}

function manualGate(): ManualGate {
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, wait, markEntered, release };
}

interface EmbeddingCall {
  url: string;
  authorization: string;
  texts: string[];
}

interface RequestBlocker {
  matches(call: EmbeddingCall): boolean;
  gate: ManualGate;
  used: boolean;
}

let embeddingCalls: EmbeddingCall[] = [];
let requestBlockers: RequestBlocker[] = [];

function vectorFor(text: string): number[] {
  const normalized = text.toLowerCase();
  if (normalized.includes("beta")) return [0, 1, 0];
  if (normalized.includes("gamma")) return [0, 0, 1];
  return [1, 0, 0];
}

function blockNext(
  matches: (call: EmbeddingCall) => boolean,
): ManualGate {
  const gate = manualGate();
  requestBlockers.push({ matches, gate, used: false });
  return gate;
}

function hasRequestText(text: string): boolean {
  return embeddingCalls.some((call) => call.texts.includes(text));
}

function installEmbeddingEndpoint(): void {
  obsidianMocks.requestUrl.mockImplementation(async (request: any) => {
    const payload = JSON.parse(request.body) as { input: string[] };
    const call: EmbeddingCall = {
      url: request.url,
      authorization: request.headers?.Authorization ?? "",
      texts: [...payload.input],
    };
    embeddingCalls.push(call);
    const blocker = requestBlockers.find(
      (candidate) => !candidate.used && candidate.matches(call),
    );
    if (blocker) {
      blocker.used = true;
      blocker.gate.markEntered();
      await blocker.gate.wait;
    }
    return {
      status: 200,
      text: JSON.stringify({
        data: call.texts.map((text, index) => ({
          index,
          embedding: vectorFor(text),
        })),
      }),
    };
  });
}

function semantic(
  overrides: Partial<EmbeddingSettings> = {},
): EmbeddingSettings {
  return {
    enabled: true,
    embeddingProvider: "openai-compatible",
    embeddingModel: "model-a",
    embeddingBaseUrl: "https://example.test/v1",
    openRouterApiKey: "router-key",
    openAICompatibleApiKey: "key-a",
    ...overrides,
  };
}

interface ControllerSlot {
  runtime: SemanticRuntime;
  signature: string;
  epoch: number;
}

function activeSlot(controller: ObsidianSemanticController): ControllerSlot {
  const slot = (
    controller as unknown as { runtimeSlot: ControllerSlot | null }
  ).runtimeSlot;
  if (!slot) throw new Error("Expected an active runtime slot.");
  return slot;
}

function runtimeStore(runtime: SemanticRuntime): LocalVectorStore {
  const components = (
    runtime as unknown as {
      components: { vectorStore: LocalVectorStore } | null;
    }
  ).components;
  if (!components) throw new Error("Expected initialized runtime components.");
  return components.vectorStore;
}

function previewText(value: unknown): string {
  return JSON.stringify(value);
}

function durableSnapshot(adapter: MemoryDataAdapter): {
  manifest: VectorStoreManifest;
  binary: ReturnType<typeof decodeVectorBinary>;
} {
  const manifestValue = adapter.files.get(
    `${BASE_PATH}/${VECTOR_MANIFEST_FILE}`,
  );
  const binaryValue = adapter.files.get(`${BASE_PATH}/${VECTOR_BINARY_FILE}`);
  if (manifestValue?.kind !== "text" || binaryValue?.kind !== "binary") {
    throw new Error("Expected a complete durable semantic snapshot.");
  }
  return {
    manifest: JSON.parse(manifestValue.value) as VectorStoreManifest,
    binary: decodeVectorBinary(binaryValue.value.slice(0)),
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createHarness(
  initialSettings = semantic(),
  adapter = new MemoryDataAdapter(),
  autoSyncSuspended = false,
) {
  const registry = new SemanticStoreRegistry();
  const notices: string[] = [];
  const resetEvents: string[] = [];
  let content = "# Alpha\n\nalpha old committed";
  const file = Object.assign(Object.create(TFile.prototype), {
    path: "Alpha.md",
    extension: "md",
  }) as TFile;
  const files = new Map<string, TFile>([[file.path, file]]);
  const contents = new Map<string, string>([[file.path, content]]);
  const vaultListeners = new Map<string, Array<(...args: any[]) => void>>();
  const layoutReadyCallbacks: Array<() => void> = [];
  let durableAutoSyncSuspended = autoSyncSuspended;
  const app = {
    vault: {
      configDir: ".obsidian",
      adapter,
      getMarkdownFiles: vi.fn(() => [...files.values()]),
      getAbstractFileByPath: vi.fn((path: string) => files.get(path) ?? null),
      cachedRead: vi.fn(async (target: TFile) => {
        const value = contents.get(target.path);
        if (value === undefined) throw new Error("missing file");
        return value;
      }),
      on: vi.fn((name: string, callback: (...args: any[]) => void) => {
        const callbacks = vaultListeners.get(name) ?? [];
        callbacks.push(callback);
        vaultListeners.set(name, callbacks);
        return { name, callback };
      }),
    },
    metadataCache: {
      getFileCache: vi.fn(() => null),
    },
    workspace: {
      getActiveFile: vi.fn(() => file),
      onLayoutReady: vi.fn((callback: () => void) => {
        layoutReadyCallbacks.push(callback);
      }),
    },
  };
  const pluginSettings = {
    semantic: initialSettings,
    semanticAutoSyncSuspended: autoSyncSuspended,
  };
  const plugin = {
    app,
    manifest: { id: "ai-knowledge-hub" },
    settings: pluginSettings,
    addCommand: vi.fn(),
    registerEvent: vi.fn(),
    saveSettings: vi.fn(async () => {
      durableAutoSyncSuspended =
        pluginSettings.semanticAutoSyncSuspended === true;
    }),
  };
  const resetStorage = vi.fn(async (targetAdapter, basePath) => {
    resetEvents.push("reset-start");
    await resetSemanticStorage(targetAdapter, basePath);
    resetEvents.push("reset-end");
  });
  const controller = new ObsidianSemanticController(plugin as never, {
    confirm: vi.fn(async () => true),
    notice: (message) => {
      notices.push(message);
      return { hide() {} };
    },
    resetStorage,
    storeRegistry: registry,
    autoSyncDebounceMs: 10,
  });
  return {
    adapter,
    registry,
    notices,
    resetEvents,
    resetStorage,
    controller,
    plugin,
    durableAutoSyncSuspended() {
      return durableAutoSyncSuspended;
    },
    setContent(value: string) {
      content = value;
      contents.set(file.path, value);
    },
    registerAutomaticSync() {
      controller.registerAutomaticSync();
    },
    fireLayoutReady() {
      for (const callback of layoutReadyCallbacks) callback();
    },
    emit(name: string, ...args: any[]) {
      for (const callback of vaultListeners.get(name) ?? []) callback(...args);
    },
    createFile(path: string, value: string): TFile {
      const created = Object.assign(Object.create(TFile.prototype), {
        path,
        extension: path.split(".").at(-1) ?? "",
      }) as TFile;
      files.set(path, created);
      contents.set(path, value);
      for (const callback of vaultListeners.get("create") ?? []) {
        callback(created);
      }
      return created;
    },
    modifyFile(path: string, value: string): void {
      const target = files.get(path);
      if (!target) throw new Error("missing file");
      contents.set(path, value);
      if (target === file) content = value;
      for (const callback of vaultListeners.get("modify") ?? []) {
        callback(target);
      }
    },
    deleteFile(path: string): void {
      const target = files.get(path);
      if (!target) throw new Error("missing file");
      files.delete(path);
      contents.delete(path);
      for (const callback of vaultListeners.get("delete") ?? []) {
        callback(target);
      }
    },
    renameFile(oldPath: string, newPath: string): TFile {
      const target = files.get(oldPath);
      const value = contents.get(oldPath);
      if (!target || value === undefined) throw new Error("missing file");
      files.delete(oldPath);
      contents.delete(oldPath);
      target.path = newPath;
      target.extension = newPath.split(".").at(-1) ?? "";
      files.set(newPath, target);
      contents.set(newPath, value);
      for (const callback of vaultListeners.get("rename") ?? []) {
        callback(target, oldPath);
      }
      return target;
    },
  };
}

beforeAll(() => {
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  embeddingCalls = [];
  requestBlockers = [];
  obsidianMocks.requestUrl.mockReset();
  installEmbeddingEndpoint();
});

describe("semantic read/write barrier with real services and store", () => {
  it("lets ordinary indexing overlap search while exposing only committed generations", async () => {
    const harness = createHarness();
    await harness.controller.indexVault();
    const store = harness.registry.peek(BASE_PATH)?.store;
    expect(store).toBeInstanceOf(LocalVectorStore);
    expect(store?.getStats().generation).toBe(1);

    harness.setContent("# Alpha\n\nbeta pending generation two");
    const pendingEmbedding = blockNext((call) =>
      call.texts.some((text) => text.includes("beta pending generation two")),
    );
    const pendingIndex = harness.controller.indexVault();
    await pendingEmbedding.entered;

    const during = await harness.controller.search("alpha committed query");
    expect(previewText(during)).toContain("alpha old committed");
    expect(previewText(during)).not.toContain("beta pending generation two");
    expect(store?.getStats().generation).toBe(1);
    expect(durableSnapshot(harness.adapter).manifest.generation).toBe(1);

    pendingEmbedding.release();
    await pendingIndex;
    const after = await harness.controller.search("beta committed query");
    expect(previewText(after)).toContain("beta pending generation two");
    expect(store?.getStats().generation).toBe(2);
    const durable = durableSnapshot(harness.adapter);
    expect(durable.manifest.generation).toBe(2);
    expect(durable.binary.generation).toBe(2);
  });

  it("waits for an old search, gives clear priority, and makes queued search observe empty", async () => {
    const harness = createHarness();
    await harness.controller.indexVault();
    const store = harness.registry.peek(BASE_PATH)?.store as LocalVectorStore;
    const clearSpy = vi.spyOn(store, "clear");
    const oldSearchGate = blockNext((call) =>
      call.texts.includes("clear-old-search"),
    );

    const oldSearch = harness.controller.search("clear-old-search");
    await oldSearchGate.entered;
    const clear = harness.controller.clearIndex();
    await flushMicrotasks();
    expect(clearSpy).not.toHaveBeenCalled();

    const queuedSearch = harness.controller.search("clear-queued-search");
    await flushMicrotasks();
    expect(hasRequestText("clear-queued-search")).toBe(false);

    oldSearchGate.release();
    expect(previewText(await oldSearch)).toContain("alpha old committed");
    await clear;
    await expect(queuedSearch).rejects.toBeInstanceOf(SemanticNotReadyError);
    expect(clearSpy).toHaveBeenCalledOnce();
    expect(store.getStats()).toMatchObject({ count: 0, generation: 2 });
    expect(durableSnapshot(harness.adapter).manifest).toMatchObject({
      count: 0,
      generation: 2,
    });
    expect(harness.resetStorage).not.toHaveBeenCalled();

    await harness.controller.clearIndex();
    expect(store.getStats()).toMatchObject({ count: 0, generation: 3 });
    expect(harness.registry.peek(BASE_PATH)?.store).toBe(store);
  });

  it("waits for two searches, holds rebuild through reset and reconcile, then admits a third search", async () => {
    const harness = createHarness();
    await harness.controller.indexVault();
    const oldStore = harness.registry.peek(BASE_PATH)?.store;
    const firstGate = blockNext((call) =>
      call.texts.includes("rebuild-old-search-one"),
    );
    const secondGate = blockNext((call) =>
      call.texts.includes("rebuild-old-search-two"),
    );
    const firstSearch = harness.controller.search("rebuild-old-search-one");
    const secondSearch = harness.controller.search("rebuild-old-search-two");
    await Promise.all([firstGate.entered, secondGate.entered]);

    harness.setContent("# Alpha\n\nbeta rebuilt content");
    const rebuild = harness.controller.rebuildIndex();
    await flushMicrotasks();
    expect(harness.resetStorage).not.toHaveBeenCalled();

    const thirdSearch = harness.controller.search("beta-search-after-rebuild");
    await flushMicrotasks();
    expect(hasRequestText("beta-search-after-rebuild")).toBe(false);

    firstGate.release();
    expect(previewText(await firstSearch)).toContain("alpha old committed");
    await flushMicrotasks();
    expect(harness.resetStorage).not.toHaveBeenCalled();

    secondGate.release();
    expect(previewText(await secondSearch)).toContain("alpha old committed");
    await rebuild;
    const rebuiltResults = await thirdSearch;
    expect(previewText(rebuiltResults)).toContain("beta rebuilt content");
    expect(harness.resetEvents).toEqual(["reset-start", "reset-end"]);
    const newStore = harness.registry.peek(BASE_PATH)?.store;
    expect(newStore).toBeInstanceOf(LocalVectorStore);
    expect(newStore).not.toBe(oldStore);
    expect(newStore?.getStats()).toMatchObject({ count: 1, generation: 1 });
    expect(durableSnapshot(harness.adapter).manifest.generation).toBe(1);
  });

  it("evicts the stale registry entry and releases exclusive after a failed rebuild reset", async () => {
    const harness = createHarness();
    await harness.controller.indexVault();
    const oldStore = harness.registry.peek(BASE_PATH)?.store;
    harness.resetStorage.mockRejectedValueOnce(new Error("reset failed"));

    await harness.controller.rebuildIndex();
    expect(harness.controller.getSemanticStatus().kind).toBe("error");
    expect(harness.registry.size).toBe(0);

    const recovered = await harness.controller.search("after failed rebuild");
    expect(previewText(recovered)).toContain("alpha old committed");
    const recoveredStore = harness.registry.peek(BASE_PATH)?.store;
    expect(recoveredStore).toBeInstanceOf(LocalVectorStore);
    expect(recoveredStore).not.toBe(oldStore);
    expect(recoveredStore?.getStats()).toMatchObject({
      count: 1,
      generation: 1,
    });
  });

  it("releases exclusive and busy state after failed clear so the next mutation succeeds", async () => {
    const harness = createHarness();
    await harness.controller.indexVault();
    const store = harness.registry.peek(BASE_PATH)?.store as LocalVectorStore;
    const originalClear = store.clear.bind(store);
    vi.spyOn(store, "clear").mockRejectedValueOnce(new Error("clear failed"));

    await harness.controller.clearIndex();
    expect(harness.controller.getSemanticStatus().kind).toBe("error");
    expect(previewText(await harness.controller.search("after-failed-clear")))
      .toContain("alpha old committed");

    harness.setContent("# Alpha\n\nbeta mutation after failed clear");
    await harness.controller.indexCurrentNote();
    expect(store.getStats()).toMatchObject({ count: 1, generation: 2 });
    expect(harness.controller.getSemanticStatus().kind).toBe("ready");
    await originalClear();
  });
});

describe("one LocalVectorStore per basePath across settings epochs", () => {
  it("rotates only the API key while sharing one store through generations 0, 1, and 2", async () => {
    const harness = createHarness();
    const pendingEmbedding = blockNext(
      (call) =>
        call.authorization === "Bearer key-a" &&
        call.texts.some((text) => text.includes("alpha old committed")),
    );
    const oldIndex = harness.controller.indexVault();
    await pendingEmbedding.entered;
    const runtimeA = activeSlot(harness.controller).runtime;
    const storeA = runtimeStore(runtimeA);
    expect(storeA.getStats()).toMatchObject({ count: 0, generation: 0 });
    expect(harness.adapter.files.has(`${BASE_PATH}/${VECTOR_MANIFEST_FILE}`))
      .toBe(false);

    harness.plugin.settings.semantic.openAICompatibleApiKey = "key-b";
    harness.controller.notifySettingsChanged();
    await harness.controller.prepareSearch();
    const runtimeB = activeSlot(harness.controller).runtime;
    const storeB = runtimeStore(runtimeB);
    expect(runtimeB).not.toBe(runtimeA);
    expect(storeB).toBe(storeA);
    expect(harness.registry.size).toBe(1);
    expect(storeB.getStats().generation).toBe(0);

    pendingEmbedding.release();
    await oldIndex;
    expect(activeSlot(harness.controller).runtime).toBe(runtimeB);
    expect(storeB.getStats()).toMatchObject({ count: 1, generation: 1 });
    expect(previewText(await harness.controller.search("alpha through key b")))
      .toContain("alpha old committed");

    harness.setContent("# Alpha\n\nbeta written through key b");
    await harness.controller.indexCurrentNote();
    expect(storeB.getStats()).toMatchObject({ count: 1, generation: 2 });
    const durable = durableSnapshot(harness.adapter);
    expect(durable.manifest.generation).toBe(2);
    expect(durable.binary.generation).toBe(2);
    expect(harness.registry.size).toBe(1);
    expect(
      embeddingCalls.some(
        (call) =>
          call.authorization === "Bearer key-b" &&
          call.texts.some((text) => text.includes("beta written through key b")),
      ),
    ).toBe(true);
    expect(JSON.stringify(harness.notices)).not.toContain("key-a");
    expect(JSON.stringify(harness.notices)).not.toContain("key-b");
  });

  it.each([
    {
      name: "model",
      change(settings: EmbeddingSettings) {
        settings.embeddingModel = "model-b";
      },
    },
    {
      name: "base URL",
      change(settings: EmbeddingSettings) {
        settings.embeddingBaseUrl = "https://other.example.test/v1";
      },
    },
    {
      name: "provider",
      change(settings: EmbeddingSettings) {
        settings.embeddingProvider = "openrouter";
      },
    },
  ])("rejects a $name mismatch without constructing a second store", async ({ change }) => {
    const harness = createHarness();
    const pendingEmbedding = blockNext((call) =>
      call.texts.some((text) => text.includes("alpha old committed")),
    );
    const oldIndex = harness.controller.indexVault();
    await pendingEmbedding.entered;
    const oldStore = harness.registry.peek(BASE_PATH)?.store;
    const originalSettings = { ...harness.plugin.settings.semantic };

    change(harness.plugin.settings.semantic);
    harness.controller.notifySettingsChanged();
    await expect(harness.controller.prepareSearch()).rejects.toBeInstanceOf(
      SemanticCompatibilityError,
    );
    expect(harness.registry.size).toBe(1);
    expect(harness.registry.peek(BASE_PATH)?.store).toBe(oldStore);
    expect(oldStore?.getStats().generation).toBe(0);
    expect(harness.adapter.files.has(`${BASE_PATH}/${VECTOR_MANIFEST_FILE}`))
      .toBe(false);

    pendingEmbedding.release();
    await oldIndex;
    expect(oldStore?.getStats()).toMatchObject({ count: 1, generation: 1 });
    expect(durableSnapshot(harness.adapter).manifest.generation).toBe(1);

    harness.plugin.settings.semantic = originalSettings;
    harness.controller.notifySettingsChanged();
    await harness.controller.prepareSearch();
    expect(harness.registry.peek(BASE_PATH)?.store).toBe(oldStore);
    expect(previewText(await harness.controller.search("alpha restored")))
      .toContain("alpha old committed");
  });

  it("does no runtime I/O while disabled and reuses the compatible store after re-enable", async () => {
    const harness = createHarness();
    const pendingEmbedding = blockNext((call) =>
      call.texts.some((text) => text.includes("alpha old committed")),
    );
    const oldIndex = harness.controller.indexVault();
    await pendingEmbedding.entered;
    const oldRuntime = activeSlot(harness.controller).runtime;
    const oldStore = runtimeStore(oldRuntime);

    harness.plugin.settings.semantic.enabled = false;
    harness.controller.notifySettingsChanged();
    const callsBeforeDisabledOperation = embeddingCalls.length;
    await expect(harness.controller.prepareSearch()).rejects.toBeInstanceOf(
      SemanticNotReadyError,
    );
    expect(embeddingCalls).toHaveLength(callsBeforeDisabledOperation);
    expect(harness.registry.peek(BASE_PATH)?.store).toBe(oldStore);

    harness.plugin.settings.semantic.enabled = true;
    harness.controller.notifySettingsChanged();
    await harness.controller.prepareSearch();
    const currentRuntime = activeSlot(harness.controller).runtime;
    expect(currentRuntime).not.toBe(oldRuntime);
    expect(runtimeStore(currentRuntime)).toBe(oldStore);

    pendingEmbedding.release();
    await oldIndex;
    expect(activeSlot(harness.controller).runtime).toBe(currentRuntime);
    expect(oldStore.getStats()).toMatchObject({ count: 1, generation: 1 });
    expect(previewText(await harness.controller.search("alpha re-enabled")))
      .toContain("alpha old committed");
  });
});

describe("provider-free cold open and metadata status", () => {
  it("keeps missing-index search preparation and refresh provider-free", async () => {
    const dimensions = vi.spyOn(BaseEmbeddingProvider.prototype, "dimensions");
    const embed = vi.spyOn(BaseEmbeddingProvider.prototype, "embed");
    try {
      const harness = createHarness();
      const searchStats = await harness.controller.prepareSearch();
      expect(searchStats).toMatchObject({ initialized: false, vectorCount: 0 });
      expect(harness.controller.getSemanticStatus().kind).toBe(
        "not-initialized",
      );
      expect(dimensions).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();
      expect(harness.registry.size).toBe(0);
      expect(harness.plugin.app.vault.cachedRead).not.toHaveBeenCalled();

      const status = await harness.controller.refreshSemanticStatus();
      expect(status.kind).toBe("not-initialized");
      expect(dimensions).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();
    } finally {
      dimensions.mockRestore();
      embed.mockRestore();
    }
  });

  it("uses dimensions once for first explicit index and never for cold status", async () => {
    const dimensions = vi.spyOn(BaseEmbeddingProvider.prototype, "dimensions");
    const embed = vi.spyOn(BaseEmbeddingProvider.prototype, "embed");
    try {
      const first = createHarness();
      await first.controller.indexVault();
      expect(dimensions).toHaveBeenCalledOnce();
      expect(embed).toHaveBeenCalledTimes(2);
      expect(durableSnapshot(first.adapter).manifest).toMatchObject({
        count: 1,
        generation: 1,
      });

      dimensions.mockClear();
      embed.mockClear();
      const restarted = createHarness(semantic(), first.adapter);
      const status = await restarted.controller.refreshSemanticStatus();
      expect(status).toMatchObject({
        kind: "ready",
        vectorCount: 1,
        vectorGeneration: 1,
        dimensions: 3,
      });
      expect(dimensions).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();
    } finally {
      dimensions.mockRestore();
      embed.mockRestore();
    }
  });

  it("cold-opens an unchanged current note without provider or mutation", async () => {
    const first = createHarness();
    await first.controller.indexVault();
    const dimensions = vi.spyOn(BaseEmbeddingProvider.prototype, "dimensions");
    const embed = vi.spyOn(BaseEmbeddingProvider.prototype, "embed");
    const applyChanges = vi.spyOn(LocalVectorStore.prototype, "applyChanges");
    try {
      const restarted = createHarness(semantic(), first.adapter);
      await restarted.controller.indexCurrentNote();
      expect(dimensions).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();
      expect(applyChanges).not.toHaveBeenCalled();
      expect(restarted.registry.peek(BASE_PATH)?.store.getStats()).toMatchObject({
        count: 1,
        generation: 1,
      });
      expect(restarted.notices).toContain(
        "Заметка уже актуальна в семантическом индексе.",
      );
    } finally {
      dimensions.mockRestore();
      embed.mockRestore();
      applyChanges.mockRestore();
    }
  });

  it("does not create a new index for a current note with no chunks", async () => {
    const dimensions = vi.spyOn(BaseEmbeddingProvider.prototype, "dimensions");
    const embed = vi.spyOn(BaseEmbeddingProvider.prototype, "embed");
    try {
      const harness = createHarness();
      harness.setContent("   \n\n");
      await harness.controller.indexCurrentNote();
      expect(dimensions).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();
      expect(harness.registry.size).toBe(0);
      expect(harness.plugin.app.vault.cachedRead).toHaveBeenCalledOnce();
      expect(harness.controller.getSemanticStatus().kind).toBe(
        "not-initialized",
      );
    } finally {
      dimensions.mockRestore();
      embed.mockRestore();
    }
  });

  it("does not create a missing initial index from the current-note command", async () => {
    const dimensions = vi.spyOn(BaseEmbeddingProvider.prototype, "dimensions");
    const embed = vi.spyOn(BaseEmbeddingProvider.prototype, "embed");
    try {
      const harness = createHarness();
      await harness.controller.indexCurrentNote();
      expect(dimensions).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();
      expect(harness.registry.size).toBe(0);
      expect(harness.adapter.files.size).toBe(0);
      expect(harness.notices).toContain(
        "Семантический индекс пуст. Сначала обновите индекс Vault.",
      );
    } finally {
      dimensions.mockRestore();
      embed.mockRestore();
    }
  });

  it("cold-opens a valid empty index without provider calls", async () => {
    const first = createHarness();
    await first.controller.indexVault();
    const dimensions = vi.spyOn(BaseEmbeddingProvider.prototype, "dimensions");
    const embed = vi.spyOn(BaseEmbeddingProvider.prototype, "embed");
    try {
      const clearing = createHarness(semantic(), first.adapter);
      await clearing.controller.clearIndex();
      expect(clearing.registry.peek(BASE_PATH)?.store.getStats()).toMatchObject({
        count: 0,
        generation: 2,
      });
      expect(dimensions).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();

      const restarted = createHarness(semantic(), first.adapter);
      const stats = await restarted.controller.prepareSearch();
      expect(stats).toMatchObject({
        initialized: true,
        vectorCount: 0,
        vectorGeneration: 2,
        dimensions: 3,
      });
      expect(dimensions).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();
    } finally {
      dimensions.mockRestore();
      embed.mockRestore();
    }
  });

  it("detects incompatible cold settings without provider or storage reset", async () => {
    const first = createHarness();
    await first.controller.indexVault();
    const originalFiles = new Map(first.adapter.files);
    const dimensions = vi.spyOn(BaseEmbeddingProvider.prototype, "dimensions");
    const embed = vi.spyOn(BaseEmbeddingProvider.prototype, "embed");
    try {
      const incompatible = createHarness(
        semantic({ embeddingModel: "model-b" }),
        first.adapter,
      );
      const status = await incompatible.controller.refreshSemanticStatus();
      expect(status.kind).toBe("incompatible");
      expect(dimensions).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();
      expect(incompatible.resetStorage).not.toHaveBeenCalled();
      expect(incompatible.adapter.files).toEqual(originalFiles);

      incompatible.plugin.settings.semantic = semantic();
      incompatible.controller.notifySettingsChanged();
      const restored = await incompatible.controller.refreshSemanticStatus();
      expect(restored).toMatchObject({ kind: "ready", vectorCount: 1 });
      expect(dimensions).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();
    } finally {
      dimensions.mockRestore();
      embed.mockRestore();
    }
  });

  it("keeps full LocalVectorStore validation authoritative after the descriptor probe", async () => {
    const first = createHarness();
    await first.controller.indexVault();
    first.adapter.files.set(`${BASE_PATH}/${VECTOR_BINARY_FILE}`, {
      kind: "binary",
      value: new Uint8Array([1, 2, 3]).buffer,
    });
    const dimensions = vi.spyOn(BaseEmbeddingProvider.prototype, "dimensions");
    const embed = vi.spyOn(BaseEmbeddingProvider.prototype, "embed");
    try {
      const restarted = createHarness(semantic(), first.adapter);
      const status = await restarted.controller.refreshSemanticStatus();
      expect(status.kind).toBe("error");
      expect(dimensions).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();
      expect(restarted.registry.size).toBe(0);
      expect(restarted.notices.join(" ")).toContain(
        "Не удалось безопасно изменить файлы semantic index.",
      );
    } finally {
      dimensions.mockRestore();
      embed.mockRestore();
    }
  });

  it("rotates the API key and opens the persisted store without dimensions", async () => {
    const first = createHarness();
    await first.controller.indexVault();
    const dimensions = vi.spyOn(BaseEmbeddingProvider.prototype, "dimensions");
    const embed = vi.spyOn(BaseEmbeddingProvider.prototype, "embed");
    try {
      const restarted = createHarness(
        semantic({ openAICompatibleApiKey: "key-b" }),
        first.adapter,
      );
      await restarted.controller.refreshSemanticStatus();
      expect(dimensions).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();

      await restarted.controller.search("alpha with rotated key");
      expect(dimensions).not.toHaveBeenCalled();
      expect(embed).toHaveBeenCalledOnce();
      expect(embeddingCalls.at(-1)?.authorization).toBe("Bearer key-b");
    } finally {
      dimensions.mockRestore();
      embed.mockRestore();
    }
  });
});

async function drainAutomaticSync(): Promise<void> {
  await vi.advanceTimersByTimeAsync(10);
  for (let index = 0; index < 40; index++) await Promise.resolve();
}

describe("automatic semantic index synchronization", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does no provider or storage work while semantic features are disabled", async () => {
    const harness = createHarness(semantic({ enabled: false }));
    harness.registerAutomaticSync();
    harness.createFile("Disabled.md", "disabled private body");
    harness.modifyFile("Alpha.md", "disabled modification");
    harness.fireLayoutReady();
    await drainAutomaticSync();
    expect(embeddingCalls).toEqual([]);
    expect(harness.adapter.files.size).toBe(0);
    expect(harness.registry.size).toBe(0);
  });

  it("does not create an initial index from Vault events", async () => {
    const harness = createHarness();
    harness.registerAutomaticSync();
    harness.createFile("Created.md", "created before initial index");
    await drainAutomaticSync();
    expect(embeddingCalls).toEqual([]);
    expect(harness.adapter.files.size).toBe(0);
    expect(harness.registry.size).toBe(0);
  });

  it("does not create an initial index during startup reconciliation", async () => {
    const harness = createHarness();
    harness.registerAutomaticSync();
    harness.fireLayoutReady();
    await drainAutomaticSync();
    expect(embeddingCalls).toEqual([]);
    expect(harness.adapter.files.size).toBe(0);
    expect(harness.controller.getSemanticStatus().kind).toBe(
      "not-initialized",
    );
  });

  it("startup reconciliation of an unchanged index is a provider-free no-op", async () => {
    const first = createHarness();
    await first.controller.indexVault();
    const generation = durableSnapshot(first.adapter).manifest.generation;
    embeddingCalls = [];

    const restarted = createHarness(semantic(), first.adapter);
    restarted.registerAutomaticSync();
    restarted.fireLayoutReady();
    await drainAutomaticSync();
    expect(embeddingCalls).toEqual([]);
    expect(durableSnapshot(first.adapter).manifest.generation).toBe(generation);
    expect(restarted.controller.getSemanticStatus()).toMatchObject({
      kind: "ready",
      vectorCount: 1,
      vectorGeneration: generation,
    });
  });

  it("startup reconciliation catches changes made while the plugin was closed", async () => {
    const first = createHarness();
    await first.controller.indexVault();
    embeddingCalls = [];
    const restarted = createHarness(semantic(), first.adapter);
    restarted.setContent("# Alpha\n\nbeta changed while closed");
    restarted.registerAutomaticSync();
    restarted.fireLayoutReady();
    await drainAutomaticSync();
    expect(
      embeddingCalls.some((call) =>
        call.texts.some((text) => text.includes("beta changed while closed")),
      ),
    ).toBe(true);
    expect(
      previewText(await restarted.controller.search("beta startup query")),
    ).toContain("beta changed while closed");
  });

  it("automatically indexes a created Markdown note", async () => {
    const harness = createHarness();
    harness.registerAutomaticSync();
    await harness.controller.indexVault();
    embeddingCalls = [];
    const generation = durableSnapshot(harness.adapter).manifest.generation;
    harness.createFile("Created.md", "# Created\n\nbeta created body");
    await drainAutomaticSync();
    const store = harness.registry.peek(BASE_PATH)?.store;
    expect(store?.listMetadata().map((value) => value.path)).toEqual([
      "Alpha.md",
      "Created.md",
    ]);
    expect(store?.getStats().generation).toBe(generation + 1);
    expect(embeddingCalls).toHaveLength(1);
  });

  it("embeds only changed chunks and makes unchanged modify a no-op", async () => {
    const harness = createHarness();
    harness.registerAutomaticSync();
    await harness.controller.indexVault();
    const store = harness.registry.peek(BASE_PATH)?.store;
    const generation = store?.getStats().generation ?? 0;
    embeddingCalls = [];

    harness.modifyFile("Alpha.md", "# Alpha\n\nbeta changed chunk");
    await drainAutomaticSync();
    expect(embeddingCalls).toHaveLength(1);
    expect(store?.getStats().generation).toBe(generation + 1);

    embeddingCalls = [];
    harness.modifyFile("Alpha.md", "# Alpha\n\nbeta changed chunk");
    await drainAutomaticSync();
    expect(embeddingCalls).toEqual([]);
    expect(store?.getStats().generation).toBe(generation + 1);
  });

  it("deletes every chunk for a removed path without provider work", async () => {
    const harness = createHarness();
    harness.registerAutomaticSync();
    await harness.controller.indexVault();
    embeddingCalls = [];
    harness.deleteFile("Alpha.md");
    await drainAutomaticSync();
    expect(embeddingCalls).toEqual([]);
    expect(harness.registry.peek(BASE_PATH)?.store.listMetadata()).toEqual([]);
  });

  it("renames atomically with one generation and no stale old path", async () => {
    const harness = createHarness();
    harness.registerAutomaticSync();
    await harness.controller.indexVault();
    const store = harness.registry.peek(BASE_PATH)?.store;
    const generation = store?.getStats().generation ?? 0;
    embeddingCalls = [];
    harness.renameFile("Alpha.md", "Renamed.md");
    await drainAutomaticSync();
    expect(store?.listMetadata().map((value) => value.path)).toEqual([
      "Renamed.md",
    ]);
    expect(store?.getStats().generation).toBe(generation + 1);
    expect(embeddingCalls).toHaveLength(1);
  });

  it("search during pending auto indexing sees the last committed snapshot", async () => {
    const harness = createHarness();
    harness.registerAutomaticSync();
    await harness.controller.indexVault();
    const pendingEmbedding = blockNext((call) =>
      call.texts.some((text) => text.includes("beta pending automatic")),
    );
    harness.modifyFile(
      "Alpha.md",
      "# Alpha\n\nbeta pending automatic",
    );
    const timer = vi.advanceTimersByTimeAsync(10);
    await pendingEmbedding.entered;
    const during = await harness.controller.search("alpha committed auto");
    expect(previewText(during)).toContain("alpha old committed");
    expect(previewText(during)).not.toContain("beta pending automatic");
    pendingEmbedding.release();
    await timer;
    await drainAutomaticSync();
    expect(
      previewText(await harness.controller.search("beta committed auto")),
    ).toContain("beta pending automatic");
  });

  it("serializes manual and automatic indexing without duplicate embeddings", async () => {
    const harness = createHarness();
    harness.registerAutomaticSync();
    await harness.controller.indexVault();
    embeddingCalls = [];
    const pendingEmbedding = blockNext((call) =>
      call.texts.some((text) => text.includes("beta shared manual auto")),
    );
    harness.modifyFile("Alpha.md", "# Alpha\n\nbeta shared manual auto");
    const timer = vi.advanceTimersByTimeAsync(10);
    await pendingEmbedding.entered;
    const manual = harness.controller.indexVault();
    await flushMicrotasks();
    expect(
      embeddingCalls.filter((call) =>
        call.texts.some((text) => text.includes("beta shared manual auto")),
      ),
    ).toHaveLength(1);
    pendingEmbedding.release();
    await Promise.all([timer, manual]);
    expect(
      embeddingCalls.filter((call) =>
        call.texts.some((text) => text.includes("beta shared manual auto")),
      ),
    ).toHaveLength(1);
  });

  it("a pending modify cannot resurrect an index after clear", async () => {
    const harness = createHarness();
    harness.registerAutomaticSync();
    await harness.controller.indexVault();
    harness.modifyFile("Alpha.md", "# Alpha\n\nbeta queued before clear");
    await harness.controller.clearIndex();
    await drainAutomaticSync();
    const store = harness.registry.peek(BASE_PATH)?.store;
    expect(store?.getStats().count).toBe(0);
    harness.modifyFile("Alpha.md", "# Alpha\n\ngamma after clear");
    await drainAutomaticSync();
    expect(store?.getStats().count).toBe(0);
  });

  it("does not begin Clear when durable suppression cannot be saved", async () => {
    const harness = createHarness();
    harness.registerAutomaticSync();
    await harness.controller.indexVault();
    const store = harness.registry.peek(BASE_PATH)!.store;
    const generation = store.getStats().generation;
    const clear = vi.spyOn(store, "clear");
    harness.plugin.saveSettings.mockRejectedValueOnce(
      new Error("Authorization: secret settings persistence body"),
    );

    await harness.controller.clearIndex();

    expect(clear).not.toHaveBeenCalled();
    expect(store.getStats()).toMatchObject({
      count: 1,
      generation,
    });
    expect(harness.plugin.settings.semanticAutoSyncSuspended).toBe(false);
    expect(harness.durableAutoSyncSuspended()).toBe(false);
    expect(harness.notices.join(" ")).not.toContain("Authorization");
    expect(harness.notices.join(" ")).not.toContain("secret");
  });

  it("keeps durable suppression after Clear persistence rollback", async () => {
    const harness = createHarness();
    harness.registerAutomaticSync();
    await harness.controller.indexVault();
    const store = harness.registry.peek(BASE_PATH)!.store;
    const generation = store.getStats().generation;
    vi.spyOn(harness.adapter, "writeBinary").mockRejectedValueOnce(
      new Error("controlled clear persistence failure"),
    );

    await harness.controller.clearIndex();

    expect(harness.plugin.settings.semanticAutoSyncSuspended).toBe(true);
    expect(harness.durableAutoSyncSuspended()).toBe(true);
    expect(store.getStats()).toMatchObject({
      count: 1,
      generation,
    });
    const restarted = createHarness(
      semantic(),
      harness.adapter,
      harness.durableAutoSyncSuspended(),
    );
    restarted.registerAutomaticSync();
    restarted.fireLayoutReady();
    embeddingCalls = [];
    restarted.modifyFile("Alpha.md", "# Alpha\n\nbeta after failed clear");
    await drainAutomaticSync();
    expect(embeddingCalls).toEqual([]);
    expect(durableSnapshot(restarted.adapter).manifest.generation).toBe(
      generation,
    );
  });

  it("treats durable suppression plus an old non-empty index as crash-safe", async () => {
    const first = createHarness();
    await first.controller.indexVault();
    const generation = durableSnapshot(first.adapter).manifest.generation;

    const restarted = createHarness(semantic(), first.adapter, true);
    restarted.registerAutomaticSync();
    restarted.fireLayoutReady();
    embeddingCalls = [];
    await drainAutomaticSync();

    expect(embeddingCalls).toEqual([]);
    expect(restarted.registry.size).toBe(0);
    expect(durableSnapshot(restarted.adapter).manifest).toMatchObject({
      generation,
      count: 1,
    });
  });

  it("persists Clear suppression across restart until explicit indexing", async () => {
    const first = createHarness();
    first.registerAutomaticSync();
    await first.controller.indexVault();
    await first.controller.clearIndex();
    expect(first.plugin.settings.semanticAutoSyncSuspended).toBe(true);

    const restarted = createHarness(semantic(), first.adapter, true);
    restarted.registerAutomaticSync();
    restarted.fireLayoutReady();
    restarted.modifyFile("Alpha.md", "# Alpha\n\nbeta after cleared restart");
    await drainAutomaticSync();
    expect(embeddingCalls.at(-1)?.texts.join(" ")).not.toContain(
      "beta after cleared restart",
    );
    expect(
      restarted.registry.peek(BASE_PATH)?.store.getStats().count ?? 0,
    ).toBe(0);

    await restarted.controller.indexVault();
    expect(restarted.plugin.settings.semanticAutoSyncSuspended).toBe(false);
    expect(restarted.plugin.saveSettings).toHaveBeenCalled();
    expect(
      previewText(await restarted.controller.search("beta explicitly resumed")),
    ).toContain("beta after cleared restart");
    expect(restarted.durableAutoSyncSuspended()).toBe(false);
  });

  it("keeps manual-index resume suppressed when marker persistence fails", async () => {
    const harness = createHarness();
    harness.registerAutomaticSync();
    await harness.controller.indexVault();
    await harness.controller.clearIndex();
    harness.modifyFile("Alpha.md", "# Alpha\n\nbeta explicit index");
    harness.plugin.saveSettings.mockRejectedValueOnce(
      new Error("Authorization: secret resume persistence body"),
    );

    await harness.controller.indexVault();

    expect(harness.plugin.settings.semanticAutoSyncSuspended).toBe(true);
    expect(harness.durableAutoSyncSuspended()).toBe(true);
    embeddingCalls = [];
    harness.modifyFile("Alpha.md", "# Alpha\n\ngamma must remain queued");
    await drainAutomaticSync();
    expect(embeddingCalls).toEqual([]);
    expect(harness.notices.join(" ")).not.toContain("Authorization");
    expect(harness.notices.join(" ")).not.toContain("secret");

    const restarted = createHarness(semantic(), harness.adapter, true);
    restarted.registerAutomaticSync();
    restarted.fireLayoutReady();
    restarted.modifyFile("Alpha.md", "# Alpha\n\ngamma after restart");
    await drainAutomaticSync();
    expect(embeddingCalls).toEqual([]);
  });

  it("keeps rebuild resume suppressed when marker persistence fails", async () => {
    const harness = createHarness();
    harness.registerAutomaticSync();
    await harness.controller.indexVault();
    await harness.controller.clearIndex();
    harness.plugin.saveSettings.mockRejectedValueOnce(
      new Error("controlled rebuild resume persistence failure"),
    );

    await harness.controller.rebuildIndex();

    expect(harness.plugin.settings.semanticAutoSyncSuspended).toBe(true);
    expect(harness.durableAutoSyncSuspended()).toBe(true);
    embeddingCalls = [];
    harness.modifyFile("Alpha.md", "# Alpha\n\nbeta after failed rebuild resume");
    await drainAutomaticSync();
    expect(embeddingCalls).toEqual([]);
  });

  it("activates only after a later resume marker save succeeds", async () => {
    const harness = createHarness();
    harness.registerAutomaticSync();
    await harness.controller.indexVault();
    await harness.controller.clearIndex();
    harness.plugin.saveSettings.mockRejectedValueOnce(
      new Error("controlled first resume failure"),
    );
    await harness.controller.indexVault();
    expect(harness.plugin.settings.semanticAutoSyncSuspended).toBe(true);

    await harness.controller.indexVault();

    expect(harness.plugin.settings.semanticAutoSyncSuspended).toBe(false);
    expect(harness.durableAutoSyncSuspended()).toBe(false);
    embeddingCalls = [];
    harness.modifyFile("Alpha.md", "# Alpha\n\nbeta automatic after resume");
    await drainAutomaticSync();
    expect(embeddingCalls).toHaveLength(1);
    expect(
      harness.registry.peek(BASE_PATH)!.store.listMetadata()[0].preview,
    ).toContain("beta automatic after resume");
  });

  it("events during rebuild are applied after the exclusive rebuild snapshot", async () => {
    const harness = createHarness();
    harness.registerAutomaticSync();
    await harness.controller.indexVault();
    harness.setContent("# Alpha\n\nbeta content read by rebuild");
    const rebuildEmbedding = blockNext((call) =>
      call.texts.some((text) => text.includes("beta content read by rebuild")),
    );
    const rebuild = harness.controller.rebuildIndex();
    await rebuildEmbedding.entered;
    harness.modifyFile("Alpha.md", "# Alpha\n\ngamma latest during rebuild");
    const timer = vi.advanceTimersByTimeAsync(10);
    rebuildEmbedding.release();
    await rebuild;
    await timer;
    await drainAutomaticSync();
    expect(
      previewText(await harness.controller.search("gamma after rebuild")),
    ).toContain("gamma latest during rebuild");
  });

  it("a pending API-key epoch uses the new provider runtime and one store", async () => {
    const harness = createHarness();
    harness.registerAutomaticSync();
    await harness.controller.indexVault();
    const store = harness.registry.peek(BASE_PATH)?.store;
    embeddingCalls = [];
    harness.modifyFile("Alpha.md", "# Alpha\n\nbeta after key rotation");
    harness.plugin.settings.semantic.openAICompatibleApiKey = "key-b";
    harness.controller.notifySettingsChanged();
    await drainAutomaticSync();
    expect(harness.registry.size).toBe(1);
    expect(harness.registry.peek(BASE_PATH)?.store).toBe(store);
    expect(
      embeddingCalls.some(
        (call) =>
          call.authorization === "Bearer key-b" &&
          call.texts.some((text) => text.includes("beta after key rotation")),
      ),
    ).toBe(true);
    expect(
      embeddingCalls.some((call) => call.authorization === "Bearer key-a"),
    ).toBe(false);
  });

  it("an active API-key epoch is commit-guarded and replayed with the new key", async () => {
    const harness = createHarness();
    harness.registerAutomaticSync();
    await harness.controller.indexVault();
    const store = harness.registry.peek(BASE_PATH)?.store;
    const generation = store?.getStats().generation ?? 0;
    embeddingCalls = [];
    const oldProvider = blockNext(
      (call) =>
        call.authorization === "Bearer key-a" &&
        call.texts.some((text) => text.includes("beta active key rotation")),
    );
    harness.modifyFile("Alpha.md", "# Alpha\n\nbeta active key rotation");
    const firstTimer = vi.advanceTimersByTimeAsync(10);
    await oldProvider.entered;
    harness.plugin.settings.semantic.openAICompatibleApiKey = "key-b";
    harness.controller.notifySettingsChanged();
    const replacementTimer = vi.advanceTimersByTimeAsync(10);
    oldProvider.release();
    await Promise.all([firstTimer, replacementTimer]);
    await drainAutomaticSync();
    expect(store?.getStats().generation).toBe(generation + 1);
    expect(harness.registry.peek(BASE_PATH)?.store).toBe(store);
    expect(
      embeddingCalls.some(
        (call) =>
          call.authorization === "Bearer key-b" &&
          call.texts.some((text) => text.includes("beta active key rotation")),
      ),
    ).toBe(true);
    expect(store?.listMetadata()[0].preview).toContain(
      "beta active key rotation",
    );
  });

  it("a pending incompatible model change performs no mutation or rebuild", async () => {
    const harness = createHarness();
    harness.registerAutomaticSync();
    await harness.controller.indexVault();
    const store = harness.registry.peek(BASE_PATH)?.store;
    const generation = store?.getStats().generation;
    embeddingCalls = [];
    harness.modifyFile("Alpha.md", "# Alpha\n\nbeta incompatible pending");
    harness.plugin.settings.semantic.embeddingModel = "model-b";
    harness.controller.notifySettingsChanged();
    await drainAutomaticSync();
    expect(embeddingCalls).toEqual([]);
    expect(store?.getStats().generation).toBe(generation);
    expect(harness.registry.peek(BASE_PATH)?.store).toBe(store);
    expect(harness.resetStorage).not.toHaveBeenCalled();
    expect(harness.controller.getSemanticStatus().kind).toBe("incompatible");
  });

  it("recovers a failed batch on the next event without notice spam", async () => {
    const harness = createHarness();
    harness.registerAutomaticSync();
    await harness.controller.indexVault();
    obsidianMocks.requestUrl.mockRejectedValueOnce(
      new Error("Authorization secret response body"),
    );
    harness.modifyFile("Alpha.md", "# Alpha\n\nbeta provider failure");
    await drainAutomaticSync();
    expect(
      harness.registry.peek(BASE_PATH)?.store.listMetadata()[0].preview,
    ).toContain("alpha old committed");
    const noticesAfterFailure = harness.notices.length;

    harness.modifyFile("Alpha.md", "# Alpha\n\ngamma recovered event");
    await drainAutomaticSync();
    expect(
      harness.registry.peek(BASE_PATH)?.store.listMetadata()[0].preview,
    ).toContain("gamma recovered event");
    expect(harness.notices.length).toBe(noticesAfterFailure);
  });

  it("dispose invalidates an in-flight provider result before mutation", async () => {
    const harness = createHarness();
    harness.registerAutomaticSync();
    await harness.controller.indexVault();
    const store = harness.registry.peek(BASE_PATH)?.store;
    const generation = store?.getStats().generation;
    const pendingEmbedding = blockNext((call) =>
      call.texts.some((text) => text.includes("beta disposed pending")),
    );
    harness.modifyFile("Alpha.md", "# Alpha\n\nbeta disposed pending");
    const timer = vi.advanceTimersByTimeAsync(10);
    await pendingEmbedding.entered;
    harness.controller.dispose();
    pendingEmbedding.release();
    await timer;
    for (let index = 0; index < 40; index++) await Promise.resolve();
    expect(store?.getStats().generation).toBe(generation);
    expect(store?.listMetadata()[0].preview).toContain("alpha old committed");
  });

  it("drains an old writer before a new lifecycle can acquire the same path", async () => {
    const first = createHarness();
    first.registerAutomaticSync();
    await first.controller.indexVault();
    const persistenceGate = manualGate();
    const originalWriteBinary = first.adapter.writeBinary.bind(first.adapter);
    let blockNextTempWrite = true;
    let activeWrites = 0;
    let maxConcurrentWrites = 0;
    vi.spyOn(first.adapter, "writeBinary").mockImplementation(
      async (path, value) => {
        activeWrites++;
        maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
        try {
          if (blockNextTempWrite && path.endsWith(".tmp")) {
            blockNextTempWrite = false;
            persistenceGate.markEntered();
            await persistenceGate.wait;
          }
          await originalWriteBinary(path, value);
        } finally {
          activeWrites--;
        }
      },
    );
    first.modifyFile("Alpha.md", "# Alpha\n\nbeta old lifecycle");
    const oldTimer = vi.advanceTimersByTimeAsync(10);
    await persistenceGate.entered;

    let drainCompleted = false;
    const drain = first.controller.dispose().then(() => {
      drainCompleted = true;
    });
    const next = createHarness(semantic(), first.adapter);
    next.setContent("# Alpha\n\ngamma new lifecycle");
    const nextIndex = next.controller.indexVault();
    await flushMicrotasks();
    expect(drainCompleted).toBe(false);
    expect(
      embeddingCalls.some((call) =>
        call.texts.some((text) => text.includes("gamma new lifecycle")),
      ),
    ).toBe(false);

    persistenceGate.release();
    await Promise.all([oldTimer, drain, nextIndex]);

    expect(drainCompleted).toBe(true);
    expect(maxConcurrentWrites).toBe(1);
    expect(
      next.registry.peek(BASE_PATH)!.store.listMetadata()[0].preview,
    ).toContain("gamma new lifecycle");
    expect(durableSnapshot(first.adapter).manifest.generation).toBe(3);
  });

  it("ignores non-Markdown TFile events", async () => {
    const harness = createHarness();
    harness.registerAutomaticSync();
    await harness.controller.indexVault();
    const generation = harness.registry.peek(BASE_PATH)?.store.getStats()
      .generation;
    embeddingCalls = [];
    harness.createFile("image.png", "binary-like attachment");
    await drainAutomaticSync();
    expect(embeddingCalls).toEqual([]);
    expect(harness.registry.peek(BASE_PATH)?.store.getStats().generation).toBe(
      generation,
    );
  });
});
