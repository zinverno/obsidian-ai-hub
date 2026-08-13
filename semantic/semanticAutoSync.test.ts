import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SemanticAutoSync,
} from "./semanticAutoSync";
import type { SemanticAutoSyncBatch } from "./semanticAutoSync";

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(
  flush?: (batch: SemanticAutoSyncBatch) => Promise<void>,
) {
  const batches: SemanticAutoSyncBatch[] = [];
  const errors: unknown[] = [];
  const scheduler = new SemanticAutoSync({
    debounceMs: 1500,
    flush: async (batch) => {
      batches.push(batch);
      await flush?.(batch);
    },
    onError: (error) => errors.push(error),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs) as unknown as number,
    clearTimer: (timer) => clearTimeout(timer),
  });
  return { scheduler, batches, errors };
}

async function elapse(milliseconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds);
}

describe("SemanticAutoSync coalescing state machine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces a modify-style upsert", async () => {
    const harness = createHarness();
    harness.scheduler.upsert("A.md");
    await elapse(1499);
    expect(harness.batches).toEqual([]);
    await elapse(1);
    expect(harness.batches).toMatchObject([
      { upsertPaths: ["A.md"], deletePaths: [], reconcileAll: false },
    ]);
  });

  it("coalesces repeated modify events and resets debounce", async () => {
    const harness = createHarness();
    harness.scheduler.upsert("A.md");
    await elapse(1000);
    harness.scheduler.upsert("A.md");
    await elapse(1499);
    expect(harness.batches).toHaveLength(0);
    await elapse(1);
    expect(harness.batches[0].upsertPaths).toEqual(["A.md"]);
  });

  it("coalesces create followed by modify as one upsert", async () => {
    const harness = createHarness();
    harness.scheduler.upsert("A.md");
    harness.scheduler.upsert("A.md");
    await elapse(1500);
    expect(harness.batches[0]).toMatchObject({
      upsertPaths: ["A.md"],
      deletePaths: [],
    });
  });

  it("represents delete without an upsert", async () => {
    const harness = createHarness();
    harness.scheduler.delete("A.md");
    await elapse(1500);
    expect(harness.batches[0]).toMatchObject({
      upsertPaths: [],
      deletePaths: ["A.md"],
    });
  });

  it("represents rename as one delete plus one upsert", async () => {
    const harness = createHarness();
    harness.scheduler.rename("A.md", "B.md");
    await elapse(1500);
    expect(harness.batches[0]).toMatchObject({
      upsertPaths: ["B.md"],
      deletePaths: ["A.md"],
    });
  });

  it("coalesces rename plus modify of the destination", async () => {
    const harness = createHarness();
    harness.scheduler.rename("A.md", "B.md");
    harness.scheduler.upsert("B.md");
    await elapse(1500);
    expect(harness.batches[0]).toMatchObject({
      upsertPaths: ["B.md"],
      deletePaths: ["A.md"],
    });
  });

  it("coalesces a rename chain without retaining intermediate upserts", async () => {
    const harness = createHarness();
    harness.scheduler.rename("A.md", "B.md");
    harness.scheduler.rename("B.md", "C.md");
    await elapse(1500);
    expect(harness.batches[0]).toMatchObject({
      upsertPaths: ["C.md"],
      deletePaths: ["A.md", "B.md"],
    });
  });

  it("makes delete followed by recreate resolve to the real file upsert", async () => {
    const harness = createHarness();
    harness.scheduler.delete("A.md");
    harness.scheduler.upsert("A.md");
    harness.scheduler.upsert("A.md");
    await elapse(1500);
    expect(harness.batches[0]).toMatchObject({
      upsertPaths: ["A.md"],
      deletePaths: [],
    });
  });

  it("processes a new batch that arrives during an active flush", async () => {
    const firstFlush = deferred();
    const harness = createHarness(async () => {
      if (harness.batches.length === 1) await firstFlush.promise;
    });
    harness.scheduler.upsert("A.md");
    await elapse(1500);
    expect(harness.batches).toHaveLength(1);

    harness.scheduler.upsert("B.md");
    await elapse(1500);
    expect(harness.batches).toHaveLength(1);
    firstFlush.resolve();
    await vi.runAllTimersAsync();
    expect(harness.batches).toHaveLength(2);
    expect(harness.batches[1].upsertPaths).toEqual(["B.md"]);
  });

  it("dispose cancels timers and prevents future flushes", async () => {
    const harness = createHarness();
    harness.scheduler.upsert("A.md");
    harness.scheduler.dispose();
    harness.scheduler.upsert("B.md");
    await vi.runAllTimersAsync();
    expect(harness.batches).toEqual([]);
  });

  it("physically clears the armed debounce timer during dispose", async () => {
    const harness = createHarness();
    harness.scheduler.upsert("A.md");
    expect(vi.getTimerCount()).toBe(1);

    harness.scheduler.dispose();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1500);
    expect(harness.batches).toEqual([]);
  });

  it("keeps a failed batch dirty and retries on later activity", async () => {
    let fail = true;
    const harness = createHarness(async () => {
      if (fail) throw new Error("provider failed");
    });
    harness.scheduler.upsert("A.md");
    await elapse(1500);
    expect(harness.batches).toHaveLength(1);
    expect(harness.errors).toHaveLength(1);
    await elapse(10_000);
    expect(harness.batches).toHaveLength(1);

    fail = false;
    harness.scheduler.upsert("B.md");
    await elapse(1500);
    expect(harness.batches).toHaveLength(2);
    expect(harness.batches[1].upsertPaths).toEqual(["A.md", "B.md"]);
  });

  it("invalidates an active epoch and preserves it before newer work", async () => {
    const firstFlush = deferred();
    const harness = createHarness(async () => {
      if (harness.batches.length === 1) await firstFlush.promise;
    });
    harness.scheduler.rename("A.md", "B.md");
    await elapse(1500);
    const oldEpoch = harness.batches[0].epoch;
    harness.scheduler.reconfigure({ paused: true, preservePending: true });
    expect(harness.scheduler.isCurrentEpoch(oldEpoch)).toBe(false);
    harness.scheduler.upsert("B.md");
    firstFlush.resolve();
    await Promise.resolve();
    harness.scheduler.reconfigure({ paused: false, preservePending: true });
    await elapse(1500);
    expect(harness.batches[1]).toMatchObject({
      deletePaths: ["A.md"],
      upsertPaths: ["B.md"],
    });
  });

  it("a full reconciliation supersedes queued path operations", async () => {
    const harness = createHarness();
    harness.scheduler.rename("A.md", "B.md");
    harness.scheduler.reconcile();
    harness.scheduler.upsert("C.md");
    await elapse(1500);
    expect(harness.batches[0]).toMatchObject({
      reconcileAll: true,
      deletePaths: [],
      upsertPaths: [],
    });
  });

  it("hands pending work to a new epoch after its timer fires during stale active work", async () => {
    const firstFlush = deferred();
    const harness = createHarness(async () => {
      if (harness.batches.length === 1) await firstFlush.promise;
    });
    harness.scheduler.upsert("A.md");
    await elapse(1500);
    harness.scheduler.reconfigure({
      paused: false,
      preservePending: true,
      reconcile: true,
    });
    await elapse(1500);
    expect(harness.batches).toHaveLength(1);
    firstFlush.resolve();
    await vi.runAllTimersAsync();
    expect(harness.batches).toHaveLength(2);
    expect(harness.batches[1].reconcileAll).toBe(true);
  });
});
