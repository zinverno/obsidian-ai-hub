export interface SemanticAutoSyncBatch {
  readonly epoch: number;
  readonly reconcileAll: boolean;
  readonly upsertPaths: readonly string[];
  readonly deletePaths: readonly string[];
}

export interface SemanticAutoSyncOptions {
  flush(batch: SemanticAutoSyncBatch): Promise<void>;
  onError?(error: unknown): void;
  debounceMs?: number;
  setTimer?(callback: () => void, delayMs: number): number;
  clearTimer?(timer: number): void;
}

interface PendingChanges {
  reconcileAll: boolean;
  upsertPaths: Set<string>;
  deletePaths: Set<string>;
}

const DEFAULT_DEBOUNCE_MS = 1500;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function emptyChanges(): PendingChanges {
  return {
    reconcileAll: false,
    upsertPaths: new Set(),
    deletePaths: new Set(),
  };
}

function hasChanges(changes: PendingChanges): boolean {
  return (
    changes.reconcileAll ||
    changes.upsertPaths.size > 0 ||
    changes.deletePaths.size > 0
  );
}

function addUpsert(changes: PendingChanges, path: string): void {
  if (changes.reconcileAll) return;
  changes.deletePaths.delete(path);
  changes.upsertPaths.add(path);
}

function addDelete(changes: PendingChanges, path: string): void {
  if (changes.reconcileAll) return;
  changes.upsertPaths.delete(path);
  changes.deletePaths.add(path);
}

function applyBatch(
  changes: PendingChanges,
  batch: SemanticAutoSyncBatch,
): void {
  if (batch.reconcileAll) {
    changes.reconcileAll = true;
    changes.upsertPaths.clear();
    changes.deletePaths.clear();
    return;
  }
  for (const path of batch.deletePaths) addDelete(changes, path);
  for (const path of batch.upsertPaths) addUpsert(changes, path);
}

/**
 * Platform-neutral debounce/coalescing state machine for semantic Vault sync.
 * It owns no Obsidian objects and performs no file or provider I/O itself.
 */
export class SemanticAutoSync {
  private readonly flushBatch: SemanticAutoSyncOptions["flush"];
  private readonly onError: NonNullable<SemanticAutoSyncOptions["onError"]>;
  private readonly debounceMs: number;
  private readonly setTimer: NonNullable<SemanticAutoSyncOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<
    SemanticAutoSyncOptions["clearTimer"]
  >;
  private pending = emptyChanges();
  private activeBatch: SemanticAutoSyncBatch | null = null;
  private timer: number | null = null;
  private flushRequested = false;
  private epoch = 0;
  private paused = false;
  private disposed = false;

  constructor(options: SemanticAutoSyncOptions) {
    if (!options || typeof options.flush !== "function") {
      throw new TypeError("Semantic auto-sync flush callback is required.");
    }
    const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    if (!Number.isFinite(debounceMs) || debounceMs < 0) {
      throw new TypeError("Semantic auto-sync debounce must be non-negative.");
    }
    this.flushBatch = options.flush;
    this.onError = options.onError ?? (() => undefined);
    this.debounceMs = debounceMs;
    this.setTimer =
      options.setTimer ??
      ((callback, delayMs) =>
        globalThis.setTimeout(callback, delayMs) as unknown as number);
    this.clearTimer =
      options.clearTimer ??
      ((timer) => globalThis.clearTimeout(timer));
  }

  upsert(path: string): void {
    if (this.disposed) return;
    addUpsert(this.pending, path);
    this.scheduleAfterActivity();
  }

  delete(path: string): void {
    if (this.disposed) return;
    addDelete(this.pending, path);
    this.scheduleAfterActivity();
  }

  rename(oldPath: string, newPath: string): void {
    if (this.disposed) return;
    addDelete(this.pending, oldPath);
    addUpsert(this.pending, newPath);
    this.scheduleAfterActivity();
  }

  reconcile(): void {
    if (this.disposed) return;
    this.pending.reconcileAll = true;
    this.pending.upsertPaths.clear();
    this.pending.deletePaths.clear();
    this.scheduleAfterActivity();
  }

  /**
   * Starts a new epoch. In-flight work is re-expressed as pending work before
   * newer events, so a commit guard can reject the stale active epoch safely.
   */
  reconfigure(options: {
    paused: boolean;
    preservePending?: boolean;
    reconcile?: boolean;
  }): void {
    if (this.disposed) return;
    const preservePending = options.preservePending !== false;
    const previousPending = this.pending;
    const nextPending = emptyChanges();
    if (preservePending && this.activeBatch) {
      applyBatch(nextPending, this.activeBatch);
    }
    if (preservePending) {
      const pendingBatch = this.toBatch(previousPending, this.epoch);
      if (pendingBatch) applyBatch(nextPending, pendingBatch);
    }
    this.pending = nextPending;
    this.epoch++;
    this.paused = options.paused;
    this.flushRequested = false;
    this.cancelTimer();
    if (options.reconcile) {
      this.pending.reconcileAll = true;
      this.pending.upsertPaths.clear();
      this.pending.deletePaths.clear();
    }
    if (!this.paused && hasChanges(this.pending)) this.armTimer();
  }

  clearAndPause(): void {
    this.reconfigure({ paused: true, preservePending: false });
  }

  isCurrentEpoch(epoch: number): boolean {
    return !this.disposed && epoch === this.epoch;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.paused = true;
    this.epoch++;
    this.pending = emptyChanges();
    this.flushRequested = false;
    this.cancelTimer();
  }

  private scheduleAfterActivity(): void {
    if (this.paused || !hasChanges(this.pending)) return;
    this.cancelTimer();
    this.armTimer();
  }

  private armTimer(): void {
    if (this.disposed || this.paused || this.timer !== null) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.activeBatch) {
        this.flushRequested = true;
        return;
      }
      void this.runFlush();
    }, this.debounceMs);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private async runFlush(): Promise<void> {
    if (
      this.disposed ||
      this.paused ||
      this.activeBatch ||
      !hasChanges(this.pending)
    ) {
      return;
    }
    const batch = this.toBatch(this.pending, this.epoch);
    if (!batch) return;
    this.pending = emptyChanges();
    this.activeBatch = batch;
    let failed = false;
    let failure: unknown;
    try {
      await this.flushBatch(batch);
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      this.activeBatch = null;
    }

    if (this.disposed) return;
    if (batch.epoch !== this.epoch) {
      if (!this.paused && hasChanges(this.pending)) {
        if (this.flushRequested) {
          this.flushRequested = false;
          void this.runFlush();
        } else if (this.timer === null) {
          this.armTimer();
        }
      }
      return;
    }

    if (failed) {
      const hadNewerWork = hasChanges(this.pending);
      const retry = emptyChanges();
      applyBatch(retry, batch);
      const newer = this.toBatch(this.pending, this.epoch);
      if (newer) applyBatch(retry, newer);
      this.pending = retry;
      try {
        this.onError(failure);
      } catch {
        // Error reporting must never break the scheduler state machine.
      }
      if (!this.paused && hadNewerWork) this.armTimer();
      return;
    }

    if (this.paused || !hasChanges(this.pending)) return;
    if (this.flushRequested) {
      this.flushRequested = false;
      void this.runFlush();
    } else if (this.timer === null) {
      this.armTimer();
    }
  }

  private toBatch(
    changes: PendingChanges,
    epoch: number,
  ): SemanticAutoSyncBatch | null {
    if (!hasChanges(changes)) return null;
    return {
      epoch,
      reconcileAll: changes.reconcileAll,
      upsertPaths: [...changes.upsertPaths].sort(compareStrings),
      deletePaths: [...changes.deletePaths].sort(compareStrings),
    };
  }
}
