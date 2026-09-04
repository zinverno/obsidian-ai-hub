import { CompanionClient, CompanionClientError } from "./client";
import type {
  CompanionConnectionStatus,
  CompanionIncrementalChange,
  CompanionSettings,
  CompanionSnapshot,
  CompanionSyncBatch,
  CompanionSyncOperation,
} from "./types";
import { COMPANION_PROTOCOL_VERSION } from "./types";

const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 2;
const CONFIGURATION_INVALIDATED = Symbol("configuration-invalidated");

export interface CompanionSyncServiceOptions {
  clientFactory?: (settings: CompanionSettings) => CompanionClientPort;
  delay?: (milliseconds: number) => Promise<void>;
}

export interface CompanionClientPort {
  status: (signal?: AbortSignal) => ReturnType<CompanionClient["status"]>;
  plan: (vaultId: string, snapshot: CompanionSnapshot, signal?: AbortSignal) => ReturnType<CompanionClient["plan"]>;
  applyBatch: (vaultId: string, batch: CompanionSyncBatch, signal?: AbortSignal) => ReturnType<CompanionClient["applyBatch"]>;
}

export interface CompanionSyncPort {
  getStatus: (enabled: boolean) => CompanionConnectionStatus;
  invalidateConfiguration: () => void;
  testConnection: (settings: CompanionSettings, signal?: AbortSignal) => Promise<void>;
  reconcile: (settings: CompanionSettings, snapshot: CompanionSnapshot, signal?: AbortSignal) => Promise<void>;
  enqueueIncremental: (settings: CompanionSettings, change: CompanionIncrementalChange) => void;
  dispose: () => Promise<void>;
}

export class CompanionSyncService implements CompanionSyncPort {
  private readonly clientFactory: (settings: CompanionSettings) => CompanionClientPort;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private tail: Promise<void> = Promise.resolve();
  private status: CompanionConnectionStatus = { kind: "idle" };
  private configurationEpoch = 0;
  private disposed = false;

  constructor(options: CompanionSyncServiceOptions = {}) {
    this.clientFactory = options.clientFactory ?? ((settings) => new CompanionClient(settings));
    this.delay = options.delay ?? ((milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)));
  }

  getStatus(enabled: boolean): CompanionConnectionStatus {
    return enabled ? { ...this.status } : { kind: "disabled" };
  }

  invalidateConfiguration(): void {
    this.configurationEpoch++;
    this.status = { kind: "idle" };
  }

  async testConnection(settings: CompanionSettings, signal?: AbortSignal): Promise<void> {
    const epoch = this.configurationEpoch;
    this.status = { kind: "syncing" };
    try {
      await this.clientFactory(settings).status(signal);
      if (!this.isCurrent(epoch)) return;
      this.status = { kind: "ready", lastSuccessAt: Date.now() };
    } catch (error) {
      if (!this.isCurrent(epoch)) return;
      this.recordError(error);
      throw error;
    }
  }

  async reconcile(settings: CompanionSettings, snapshot: CompanionSnapshot, signal?: AbortSignal): Promise<void> {
    if (this.disposed || !settings.enabled) return;
    const epoch = this.configurationEpoch;
    const frozenSettings = { ...settings };
    const pending = this.tail.then(async () => {
      if (!this.isCurrent(epoch)) return;
      this.status = { kind: "syncing" };
      try {
        const client = this.clientFactory(frozenSettings);
        const plan = await this.withRetry(epoch, () => client.plan(frozenSettings.vaultId, snapshot, signal));
        if (plan === CONFIGURATION_INVALIDATED || !this.isCurrent(epoch)) return;
        const notes = new Map(snapshot.notes.map((note) => [note.path, note]));
        const operations: CompanionSyncOperation[] = [];
        if (!plan.replaceVault) {
          for (const path of plan.deletePaths) operations.push({ type: "DELETE", path });
        }
        for (const path of plan.uploadPaths) {
          const note = notes.get(path);
          if (note) operations.push({ type: "UPSERT", note });
        }
        const applied = await this.applyOperations(
          epoch,
          client,
          frozenSettings,
          snapshot,
          operations,
          plan.replaceVault,
          signal,
        );
        if (!applied || !this.isCurrent(epoch)) return;
        this.status = { kind: "ready", lastSuccessAt: Date.now() };
      } catch (error) {
        if (!this.isCurrent(epoch)) return;
        this.recordError(error);
        throw error;
      }
    });
    this.tail = pending.catch(() => undefined);
    return pending;
  }

  enqueueIncremental(settings: CompanionSettings, change: CompanionIncrementalChange): void {
    if (this.disposed || !settings.enabled) return;
    const epoch = this.configurationEpoch;
    const frozenSettings = { ...settings };
    this.tail = this.tail.then(async () => {
      if (!this.isCurrent(epoch)) return;
      this.status = { kind: "syncing" };
      try {
        const client = this.clientFactory(frozenSettings);
        const notes = new Map(change.snapshot.notes.map((note) => [note.path, note]));
        const consumedDeletes = new Set<string>();
        const consumedUpserts = new Set<string>();
        const operations: CompanionSyncOperation[] = [];
        for (const rename of change.renames ?? []) {
          const renamed = notes.get(rename.newPath);
          if (!renamed || !change.deletePaths.includes(rename.oldPath)) continue;
          operations.push({ type: "RENAME", oldPath: rename.oldPath, note: renamed });
          consumedDeletes.add(rename.oldPath);
          consumedUpserts.add(rename.newPath);
        }
        for (const path of [...change.deletePaths].sort()) {
          if (!consumedDeletes.has(path)) operations.push({ type: "DELETE", path });
        }
        for (const note of [...change.snapshot.notes].sort((left, right) => left.path.localeCompare(right.path))) {
          if (!consumedUpserts.has(note.path)) operations.push({ type: "UPSERT", note });
        }
        const applied = await this.applyOperations(
          epoch,
          client,
          frozenSettings,
          change.snapshot,
          operations,
          false,
        );
        if (!applied || !this.isCurrent(epoch)) return;
        this.status = { kind: "ready", lastSuccessAt: Date.now() };
      } catch (error) {
        if (!this.isCurrent(epoch)) return;
        this.recordError(error);
      }
    });
  }

  async drain(): Promise<void> {
    await this.tail;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.configurationEpoch++;
    await this.tail;
  }

  private async applyOperations(
    epoch: number,
    client: CompanionClientPort,
    settings: CompanionSettings,
    snapshot: CompanionSnapshot,
    operations: readonly CompanionSyncOperation[],
    replaceVault: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!this.isCurrent(epoch)) return false;
    if (operations.length === 0 && !replaceVault) return true;
    const batches = operations.length === 0 ? [[]] : Array.from(
      { length: Math.ceil(operations.length / BATCH_SIZE) },
      (_value, index) => operations.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE),
    );
    for (let index = 0; index < batches.length; index++) {
      if (!this.isCurrent(epoch)) return false;
      const batch: CompanionSyncBatch = {
        protocolVersion: COMPANION_PROTOCOL_VERSION,
        generation: snapshot.generation,
        descriptor: snapshot.descriptor,
        operations: [...(batches[index] ?? [])],
      };
      if (replaceVault && index === 0) batch.replaceVault = true;
      const result = await this.withRetry(
        epoch,
        () => client.applyBatch(settings.vaultId, batch, signal),
      );
      if (result === CONFIGURATION_INVALIDATED) return false;
    }
    return this.isCurrent(epoch);
  }

  private async withRetry<T>(
    epoch: number,
    operation: () => Promise<T>,
  ): Promise<T | typeof CONFIGURATION_INVALIDATED> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (!this.isCurrent(epoch)) return CONFIGURATION_INVALIDATED;
      try {
        const result = await operation();
        return this.isCurrent(epoch) ? result : CONFIGURATION_INVALIDATED;
      } catch (error) {
        if (!this.isCurrent(epoch)) return CONFIGURATION_INVALIDATED;
        lastError = error;
        const retryable = error instanceof CompanionClientError &&
          (error.code === "TIMEOUT" || error.code === "UNREACHABLE" || error.code === "SERVER_ERROR");
        if (!retryable || attempt + 1 >= MAX_ATTEMPTS) throw error;
        await this.delay(250 * (attempt + 1));
        if (!this.isCurrent(epoch)) return CONFIGURATION_INVALIDATED;
      }
    }
    throw lastError;
  }

  private isCurrent(epoch: number): boolean {
    return !this.disposed && epoch === this.configurationEpoch;
  }

  private recordError(error: unknown): void {
    this.status = {
      kind: "error",
      code: error instanceof CompanionClientError ? error.code : "SERVER_ERROR",
    };
  }
}
