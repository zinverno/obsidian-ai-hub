export interface ReadWriteLease {
  release(): void;
}

type WaiterKind = "shared" | "exclusive";

interface Waiter {
  kind: WaiterKind;
  resolve: (lease: ReadWriteLease) => void;
}

/**
 * Writer-preferred async read/write barrier.
 *
 * Shared work may overlap, but once an exclusive waiter is queued, later shared
 * callers queue behind it. Leases are idempotent so cleanup paths can safely
 * release them from `finally`.
 */
export class AsyncReadWriteBarrier {
  private activeShared = 0;
  private activeExclusive = false;
  private readonly queue: Waiter[] = [];

  acquireShared(): Promise<ReadWriteLease> {
    if (!this.activeExclusive && this.queue.length === 0) {
      this.activeShared++;
      return Promise.resolve(this.createLease("shared"));
    }
    return new Promise((resolve) => {
      this.queue.push({ kind: "shared", resolve });
      this.drain();
    });
  }

  acquireExclusive(): Promise<ReadWriteLease> {
    if (
      !this.activeExclusive &&
      this.activeShared === 0 &&
      this.queue.length === 0
    ) {
      this.activeExclusive = true;
      return Promise.resolve(this.createLease("exclusive"));
    }
    return new Promise((resolve) => {
      this.queue.push({ kind: "exclusive", resolve });
      this.drain();
    });
  }

  async withShared<T>(operation: () => Promise<T>): Promise<T> {
    const lease = await this.acquireShared();
    try {
      return await operation();
    } finally {
      lease.release();
    }
  }

  async withExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const lease = await this.acquireExclusive();
    try {
      return await operation();
    } finally {
      lease.release();
    }
  }

  private createLease(kind: WaiterKind): ReadWriteLease {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (kind === "shared") {
          this.activeShared--;
        } else {
          this.activeExclusive = false;
        }
        this.drain();
      },
    };
  }

  private drain(): void {
    if (this.activeExclusive || this.activeShared > 0 || this.queue.length === 0) {
      return;
    }

    if (this.queue[0].kind === "exclusive") {
      const waiter = this.queue.shift();
      if (!waiter) return;
      this.activeExclusive = true;
      waiter.resolve(this.createLease("exclusive"));
      return;
    }

    while (this.queue[0]?.kind === "shared") {
      const waiter = this.queue.shift();
      if (!waiter) break;
      this.activeShared++;
      waiter.resolve(this.createLease("shared"));
    }
  }
}
