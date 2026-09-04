import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

import { CompanionClientError } from "./client";
import { CompanionSyncService } from "./service";
import type { CompanionClientPort } from "./service";
import type {
  CompanionReconciliationPlan,
  CompanionSettings,
  CompanionSnapshot,
  CompanionSyncBatchResult,
} from "./types";

const settings: CompanionSettings = {
  enabled: true,
  endpoint: "https://vault.example.com",
  token: "secret",
  timeoutMs: 1000,
  vaultId: "11111111-1111-4111-8111-111111111111",
};

function snapshot(generation = 2): CompanionSnapshot {
  const makeNote = (path: string) => ({
    path,
    content: `# ${path}`,
    contentHash: `note-${path}`,
    metadata: {},
    chunks: [{
      chunkId: `chunk-${path}`,
      notePath: path,
      ordinal: 0,
      headingPath: [path],
      text: path,
      contentHash: `hash-${path}`,
      source: { startOffset: 0, endOffset: path.length, startLine: 0, endLine: 0 },
      embedding: [1, 0, 0],
    }],
  });
  return {
    generation,
    descriptor: {
      providerId: "openai-compatible",
      model: "embed",
      baseUrl: "https://embed.example/v1",
      dimensions: 3,
      embeddingSpaceId: "space",
      normalized: true,
    },
    notes: [makeNote("A.md"), makeNote("B.md")],
  };
}

function plan(overrides: Partial<CompanionReconciliationPlan> = {}): CompanionReconciliationPlan {
  return {
    protocolVersion: 1,
    generation: 2,
    serverGeneration: 1,
    replaceVault: false,
    uploadPaths: [],
    deletePaths: [],
    unchangedPaths: ["A.md", "B.md"],
    ...overrides,
  };
}

function batchResult(): CompanionSyncBatchResult {
  return { protocolVersion: 1, generation: 2, applied: true, stale: false, operationsApplied: 1 };
}

function fakeClient(): CompanionClientPort {
  return {
    status: vi.fn(async () => ({ status: "ok" as const, protocolVersion: 1 as const, vaultCount: 0 })),
    plan: vi.fn(async () => plan()),
    applyBatch: vi.fn(async () => batchResult()),
  };
}

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

beforeEach(() => vi.stubGlobal("window", { setTimeout, clearTimeout }));

describe("CompanionSyncService", () => {
  it("uploads only paths requested by reconciliation and deletes stale paths", async () => {
    const client = fakeClient();
    vi.mocked(client.plan).mockResolvedValue(plan({ uploadPaths: ["B.md"], deletePaths: ["Stale.md"], unchangedPaths: ["A.md"] }));
    const service = new CompanionSyncService({ clientFactory: () => client });
    await service.reconcile(settings, snapshot());
    const sent = vi.mocked(client.applyBatch).mock.calls[0];
    expect(sent?.[0]).toBe(settings.vaultId);
    expect(sent?.[1].operations[0]).toEqual({ type: "DELETE", path: "Stale.md" });
    expect(sent?.[1].operations[1]?.type).toBe("UPSERT");
    expect(sent?.[1].operations[1]?.type === "UPSERT" ? sent[1].operations[1].note.path : "").toBe("B.md");
  });

  it("makes a converged reconciliation a no-op", async () => {
    const client = fakeClient();
    const service = new CompanionSyncService({ clientFactory: () => client });
    await service.reconcile(settings, snapshot());
    expect(client.applyBatch).not.toHaveBeenCalled();
  });

  it("sends an explicit atomic RENAME with the new frozen note", async () => {
    const client = fakeClient();
    const service = new CompanionSyncService({ clientFactory: () => client });
    const state = snapshot();
    state.notes = state.notes.filter((item) => item.path === "B.md");
    service.enqueueIncremental(settings, {
      snapshot: state,
      deletePaths: ["A.md"],
      renames: [{ oldPath: "A.md", newPath: "B.md" }],
    });
    await service.drain();
    const sent = vi.mocked(client.applyBatch).mock.calls[0]?.[1].operations[0];
    expect(sent?.type).toBe("RENAME");
    expect(sent?.type === "RENAME" ? { oldPath: sent.oldPath, newPath: sent.note.path } : null).toEqual({
      oldPath: "A.md",
      newPath: "B.md",
    });
  });

  it("maps create, modify, and delete changes to deterministic incremental operations", async () => {
    const client = fakeClient();
    const service = new CompanionSyncService({ clientFactory: () => client });
    service.enqueueIncremental(settings, {
      snapshot: snapshot(3),
      deletePaths: ["Removed.md"],
    });
    await service.drain();
    expect(vi.mocked(client.applyBatch).mock.calls[0]?.[1].operations.map((operation) => {
      if (operation.type === "UPSERT") return `${operation.type}:${operation.note.path}`;
      if (operation.type === "DELETE") return `${operation.type}:${operation.path}`;
      return `${operation.type}:${operation.oldPath}->${operation.note.path}`;
    })).toEqual(["DELETE:Removed.md", "UPSERT:A.md", "UPSERT:B.md"]);
  });

  it("splits large incremental changes into bounded batches", async () => {
    const client = fakeClient();
    const state = snapshot(4);
    state.notes = Array.from({ length: 101 }, (_value, index) => ({
      ...state.notes[0],
      path: `Note-${String(index).padStart(3, "0")}.md`,
      chunks: [],
    }));
    const service = new CompanionSyncService({ clientFactory: () => client });
    service.enqueueIncremental(settings, { snapshot: state, deletePaths: [] });
    await service.drain();
    expect(vi.mocked(client.applyBatch).mock.calls.map((call) => call[1].operations.length)).toEqual([50, 50, 1]);
  });

  it("drops queued incremental work after configuration invalidation", async () => {
    const client = fakeClient();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<CompanionSyncBatchResult>();
    vi.mocked(client.applyBatch)
      .mockImplementationOnce(() => {
        firstStarted.resolve();
        return releaseFirst.promise;
      })
      .mockResolvedValue(batchResult());
    const clientFactory = vi.fn(() => client);
    const service = new CompanionSyncService({ clientFactory });
    service.enqueueIncremental(settings, { snapshot: snapshot(1), deletePaths: [] });
    await firstStarted.promise;
    service.enqueueIncremental(settings, { snapshot: snapshot(2), deletePaths: [] });

    service.invalidateConfiguration();
    releaseFirst.resolve(batchResult());
    await service.drain();

    expect(client.applyBatch).toHaveBeenCalledOnce();
    expect(clientFactory).toHaveBeenCalledOnce();
    expect(service.getStatus(true)).toEqual({ kind: "idle" });
  });

  it("does not apply a reconciliation plan resolved after invalidation", async () => {
    const client = fakeClient();
    const planStarted = deferred<void>();
    const releasePlan = deferred<CompanionReconciliationPlan>();
    vi.mocked(client.plan).mockImplementation(() => {
      planStarted.resolve();
      return releasePlan.promise;
    });
    const service = new CompanionSyncService({ clientFactory: () => client });
    const pending = service.reconcile(settings, snapshot());
    await planStarted.promise;

    service.invalidateConfiguration();
    releasePlan.resolve(plan({ uploadPaths: ["A.md"], unchangedPaths: ["B.md"] }));
    await pending;

    expect(client.applyBatch).not.toHaveBeenCalled();
    expect(service.getStatus(true)).toEqual({ kind: "idle" });
  });

  it("does not send another batch after configuration invalidation", async () => {
    const client = fakeClient();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<CompanionSyncBatchResult>();
    vi.mocked(client.applyBatch)
      .mockImplementationOnce(() => {
        firstStarted.resolve();
        return releaseFirst.promise;
      })
      .mockResolvedValue(batchResult());
    const state = snapshot(5);
    state.notes = Array.from({ length: 101 }, (_value, index) => ({
      ...state.notes[0],
      path: `Batch-${String(index).padStart(3, "0")}.md`,
      chunks: [],
    }));
    const service = new CompanionSyncService({ clientFactory: () => client });
    service.enqueueIncremental(settings, { snapshot: state, deletePaths: [] });
    await firstStarted.promise;

    service.invalidateConfiguration();
    releaseFirst.resolve(batchResult());
    await service.drain();

    expect(client.applyBatch).toHaveBeenCalledOnce();
  });

  it("does not retry after configuration is invalidated during backoff", async () => {
    const client = fakeClient();
    vi.mocked(client.applyBatch).mockRejectedValue(new CompanionClientError("UNREACHABLE"));
    const delayStarted = deferred<void>();
    const releaseDelay = deferred<void>();
    const service = new CompanionSyncService({
      clientFactory: () => client,
      delay: async () => {
        delayStarted.resolve();
        await releaseDelay.promise;
      },
    });
    service.enqueueIncremental(settings, { snapshot: snapshot(), deletePaths: [] });
    await delayStarted.promise;

    service.invalidateConfiguration();
    releaseDelay.resolve();
    await service.drain();

    expect(client.applyBatch).toHaveBeenCalledOnce();
    expect(service.getStatus(true)).toEqual({ kind: "idle" });
  });

  it("uses new connection settings for work requested after invalidation", async () => {
    const client = fakeClient();
    const clientFactory = vi.fn(() => client);
    const service = new CompanionSyncService({ clientFactory });
    const newSettings: CompanionSettings = {
      ...settings,
      endpoint: "https://new-vault.example.com",
      token: "new-secret",
      timeoutMs: 2500,
    };

    service.invalidateConfiguration();
    await service.reconcile(newSettings, snapshot(6));

    expect(clientFactory).toHaveBeenCalledOnce();
    expect(clientFactory).toHaveBeenCalledWith(newSettings);
    expect(service.getStatus(true).kind).toBe("ready");
  });

  it("reports disabled without a server error when in-flight work becomes obsolete", async () => {
    const client = fakeClient();
    const requestStarted = deferred<void>();
    const releaseRequest = deferred<void>();
    vi.mocked(client.applyBatch).mockImplementation(async () => {
      requestStarted.resolve();
      await releaseRequest.promise;
      throw new CompanionClientError("UNREACHABLE");
    });
    const service = new CompanionSyncService({ clientFactory: () => client });
    service.enqueueIncremental(settings, { snapshot: snapshot(), deletePaths: [] });
    await requestStarted.promise;

    service.invalidateConfiguration();
    const disabledSettings = { ...settings, enabled: false };
    service.enqueueIncremental(disabledSettings, { snapshot: snapshot(3), deletePaths: [] });
    expect(service.getStatus(false)).toEqual({ kind: "disabled" });
    releaseRequest.resolve();
    await service.drain();

    expect(client.applyBatch).toHaveBeenCalledOnce();
    expect(service.getStatus(false)).toEqual({ kind: "disabled" });
    expect(service.getStatus(true)).toEqual({ kind: "idle" });
  });

  it("uses bounded retry and then reports an offline error", async () => {
    const client = fakeClient();
    vi.mocked(client.applyBatch).mockRejectedValue(new CompanionClientError("UNREACHABLE"));
    const delay = vi.fn(async () => undefined);
    const service = new CompanionSyncService({ clientFactory: () => client, delay });
    service.enqueueIncremental(settings, { snapshot: snapshot(), deletePaths: [] });
    await service.drain();
    expect(client.applyBatch).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledOnce();
    expect(service.getStatus(true)).toMatchObject({ kind: "error", code: "UNREACHABLE" });
  });

  it("repairs a lost offline incremental change during later reconciliation", async () => {
    const client = fakeClient();
    vi.mocked(client.applyBatch).mockRejectedValue(new CompanionClientError("UNREACHABLE"));
    const service = new CompanionSyncService({
      clientFactory: () => client,
      delay: async () => undefined,
    });
    service.enqueueIncremental(settings, { snapshot: snapshot(2), deletePaths: [] });
    await service.drain();
    vi.mocked(client.applyBatch).mockReset();
    vi.mocked(client.applyBatch).mockResolvedValue(batchResult());
    vi.mocked(client.plan).mockResolvedValue(plan({
      generation: 3,
      uploadPaths: ["B.md"],
      deletePaths: ["Stale.md"],
      unchangedPaths: ["A.md"],
    }));

    await service.reconcile(settings, snapshot(3));

    expect(vi.mocked(client.applyBatch).mock.calls[0]?.[1].operations).toMatchObject([
      { type: "DELETE", path: "Stale.md" },
      { type: "UPSERT", note: { path: "B.md" } },
    ]);
    expect(service.getStatus(true).kind).toBe("ready");
  });

  it("serializes a newer generation after a slow frozen generation", async () => {
    const client = fakeClient();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(client.applyBatch)
      .mockImplementationOnce(async () => { await gate; return batchResult(); })
      .mockResolvedValue(batchResult());
    const service = new CompanionSyncService({ clientFactory: () => client });
    service.enqueueIncremental(settings, { snapshot: snapshot(1), deletePaths: [] });
    service.enqueueIncremental(settings, { snapshot: snapshot(2), deletePaths: [] });
    await Promise.resolve();
    expect(client.applyBatch).toHaveBeenCalledTimes(1);
    release();
    await service.drain();
    expect(vi.mocked(client.applyBatch).mock.calls.map((call) => call[1].generation)).toEqual([1, 2]);
  });
});
