import { describe, expect, it, vi } from "vitest";
import { AsyncReadWriteBarrier } from "./asyncReadWriteBarrier";

function manualGate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

describe("AsyncReadWriteBarrier", () => {
  it("allows two shared leases concurrently", async () => {
    const barrier = new AsyncReadWriteBarrier();
    const first = await barrier.acquireShared();
    const second = await barrier.acquireShared();
    first.release();
    second.release();
  });

  it("waits for every active shared lease before granting exclusive", async () => {
    const barrier = new AsyncReadWriteBarrier();
    const first = await barrier.acquireShared();
    const second = await barrier.acquireShared();
    let acquired = false;
    const exclusive = barrier.acquireExclusive().then((lease) => {
      acquired = true;
      return lease;
    });

    await Promise.resolve();
    expect(acquired).toBe(false);
    first.release();
    await Promise.resolve();
    expect(acquired).toBe(false);
    second.release();
    (await exclusive).release();
    expect(acquired).toBe(true);
  });

  it("does not let new shared work overtake a queued exclusive", async () => {
    const barrier = new AsyncReadWriteBarrier();
    const order: string[] = [];
    const active = await barrier.acquireShared();
    const exclusive = barrier.acquireExclusive().then((lease) => {
      order.push("exclusive");
      return lease;
    });
    const shared = barrier.acquireShared().then((lease) => {
      order.push("shared");
      return lease;
    });

    active.release();
    const exclusiveLease = await exclusive;
    expect(order).toEqual(["exclusive"]);
    exclusiveLease.release();
    (await shared).release();
    expect(order).toEqual(["exclusive", "shared"]);
  });

  it("continues shared work after exclusive release", async () => {
    const barrier = new AsyncReadWriteBarrier();
    const exclusive = await barrier.acquireExclusive();
    let acquired = false;
    const shared = barrier.acquireShared().then((lease) => {
      acquired = true;
      return lease;
    });
    await Promise.resolve();
    expect(acquired).toBe(false);
    exclusive.release();
    (await shared).release();
    expect(acquired).toBe(true);
  });

  it("releases a shared lease after rejection", async () => {
    const barrier = new AsyncReadWriteBarrier();
    await expect(
      barrier.withShared(async () => {
        throw new Error("shared");
      }),
    ).rejects.toThrow("shared");

    const exclusive = await barrier.acquireExclusive();
    exclusive.release();
  });

  it("releases an exclusive lease after rejection", async () => {
    const barrier = new AsyncReadWriteBarrier();
    await expect(
      barrier.withExclusive(async () => {
        throw new Error("exclusive");
      }),
    ).rejects.toThrow("exclusive");

    const shared = await barrier.acquireShared();
    shared.release();
  });

  it("runs two exclusive operations sequentially without timers", async () => {
    const barrier = new AsyncReadWriteBarrier();
    const firstGate = manualGate();
    const order: string[] = [];
    const first = barrier.withExclusive(async () => {
      order.push("first-start");
      await firstGate.wait;
      order.push("first-end");
    });
    await Promise.resolve();
    const second = barrier.withExclusive(async () => {
      order.push("second");
    });
    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    firstGate.release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("does not produce an unhandled rejection for queued helper work", async () => {
    const barrier = new AsyncReadWriteBarrier();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const active = await barrier.acquireShared();
      const pending = barrier.withExclusive(async () => {
        throw new Error("expected");
      });
      active.release();
      await expect(pending).rejects.toThrow("expected");
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
