import {
  afterAll,
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
) {
  const registry = new SemanticStoreRegistry();
  const notices: string[] = [];
  const resetEvents: string[] = [];
  let content = "# Alpha\n\nalpha old committed";
  const file = Object.assign(Object.create(TFile.prototype), {
    path: "Alpha.md",
    extension: "md",
  }) as TFile;
  const app = {
    vault: {
      configDir: ".obsidian",
      adapter,
      getMarkdownFiles: vi.fn(() => [file]),
      cachedRead: vi.fn(async () => content),
    },
    metadataCache: {
      getFileCache: vi.fn(() => null),
    },
    workspace: {
      getActiveFile: vi.fn(() => file),
    },
  };
  const plugin = {
    app,
    manifest: { id: "ai-knowledge-hub" },
    settings: { semantic: initialSettings },
    addCommand: vi.fn(),
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
  });
  return {
    adapter,
    registry,
    notices,
    resetEvents,
    resetStorage,
    controller,
    plugin,
    setContent(value: string) {
      content = value;
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
