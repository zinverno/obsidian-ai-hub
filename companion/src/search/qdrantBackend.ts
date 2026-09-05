import { randomUUID } from "node:crypto";
import type { QdrantConfig } from "../config.js";
import { assertCompatibleDescriptor } from "../mcp/descriptor.js";
import type { CommitNotice } from "../storage/companionStorage.js";
import type { McpReadStorage, SearchSnapshot } from "../storage/mcpReadStorage.js";
import { indexPoint, indexSpec, QDRANT_BATCH_SIZE, QdrantIndexError } from "./qdrantIndex.js";
import type { IndexSpec, QdrantVectorIndex } from "./qdrantIndex.js";
import { sameSnapshot } from "./vectorBackend.js";
import type { DerivedVectorBackend, SearchContext, VectorCandidate } from "./vectorBackend.js";

export type QdrantState = "DISABLED" | "BUILDING" | "READY" | "STALE" | "ERROR";

export interface QdrantStatus {
  enabled: boolean; state: QdrantState; connected: boolean; collection: string | null; vaultId: string;
  embeddingSpaceId: string | null; indexedGeneration: number | null; currentGeneration: number;
  indexedRevision: number | null; currentRevision: number; lastErrorCode: string | null;
  lastSuccessfulSyncAt: string | null; lastSearchBackend: "sqlite" | "qdrant" | null;
}

/** One configured Vault, one worker and at most one pending incremental change. */
export class QdrantVectorBackend implements DerivedVectorBackend {
  private state: QdrantState;
  private ready: { snapshot: SearchSnapshot; spec: IndexSpec } | null = null;
  private connected = false;
  private lastErrorCode: string | null = null;
  private lastSuccessfulSyncAt: string | null = null;
  private lastSearchBackend: "sqlite" | "qdrant" | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private closed = false;
  private pending: CommitNotice | null = null;
  private epoch = 0;
  private failures = 0;

  constructor(private readonly storage: McpReadStorage, private readonly vaultId: string,
    private readonly config: QdrantConfig, private readonly index: QdrantVectorIndex) {
    this.state = config.enabled ? "STALE" : "DISABLED";
  }
  start(): void { if (this.config.enabled) this.schedule(0); }
  private schedule(delay: number): void {
    if (this.closed || !this.config.enabled || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.reconcile(); }, delay);
    this.timer.unref();
  }
  onCommit(notice: CommitNotice): void {
    if (!this.config.enabled || notice.vaultId !== this.vaultId || this.closed) return;
    this.pending = this.state === "READY" && !this.running && !notice.replaceVault &&
      notice.previousRevision === this.ready?.snapshot.revision ? notice : null;
    this.epoch++;
    this.state = "STALE";
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.schedule(0);
  }
  available(snapshot: SearchSnapshot): boolean {
    return this.config.enabled && !this.closed && this.state === "READY" && this.ready !== null &&
      sameSnapshot(this.ready.snapshot, snapshot);
  }
  invalidate(): void {
    if (!this.config.enabled || this.closed) return;
    this.epoch++;
    this.state = "ERROR";
    this.connected = false;
    this.lastErrorCode = "QDRANT_INVALID_INDEX";
    this.pending = null;
    this.schedule(1000);
  }
  recordBackend(backend: "sqlite" | "qdrant"): void { this.lastSearchBackend = backend; }
  async status(): Promise<QdrantStatus> {
    const current = await this.storage.getSearchSnapshot(this.vaultId);
    const state = this.state === "READY" && !this.available(current) ? "STALE" : this.state;
    return {
      enabled: this.config.enabled, state, connected: this.connected,
      collection: this.ready?.spec.collection ?? null, vaultId: this.vaultId,
      embeddingSpaceId: this.ready?.snapshot.descriptor?.embeddingSpaceId ?? null,
      indexedGeneration: this.ready?.snapshot.generation ?? null, currentGeneration: current.generation,
      indexedRevision: this.ready?.snapshot.revision ?? null, currentRevision: current.revision,
      lastErrorCode: this.lastErrorCode, lastSuccessfulSyncAt: this.lastSuccessfulSyncAt,
      lastSearchBackend: this.lastSearchBackend,
    };
  }
  async search(context: SearchContext, limit: number): Promise<VectorCandidate[]> {
    if (!this.available(context.snapshot) || !this.ready) throw new QdrantIndexError();
    const epoch = this.epoch;
    const results = await this.index.search(this.ready.spec, context.queryVector, limit);
    if (epoch !== this.epoch || !this.available(context.snapshot)) throw new QdrantIndexError();
    return results;
  }
  reconcile(): Promise<void> {
    if (this.running) return this.running;
    if (this.closed || !this.config.enabled) return Promise.resolve();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.running = this.run().finally(() => {
      this.running = null;
      // Bounded periodic reconciliation, no retained failure history or retry loop.
      this.schedule(this.state === "READY" ? 30_000 : Math.min(30_000, 1000 * 2 ** Math.min(this.failures, 5)));
    });
    return this.running;
  }
  private async assertCurrent(snapshot: SearchSnapshot, epoch: number): Promise<void> {
    if (this.closed || epoch !== this.epoch || !sameSnapshot(await this.storage.getSearchSnapshot(this.vaultId), snapshot)) {
      throw new QdrantIndexError();
    }
  }
  private async upload(spec: IndexSpec, snapshot: SearchSnapshot, epoch: number, paths?: readonly string[]): Promise<number> {
    let after = "";
    let uploaded = 0;
    for (;;) {
      await this.assertCurrent(snapshot, epoch);
      const page = this.storage.listVectorPage(this.vaultId, spec.dimensions, after, QDRANT_BATCH_SIZE, paths);
      if (page.length === 0) break;
      await this.index.upsert(spec, page.map((record) => indexPoint(spec, record)));
      uploaded += page.length;
      after = page.at(-1)!.chunkId;
    }
    return uploaded;
  }
  private async run(): Promise<void> {
    const epoch = this.epoch;
    const change = this.pending;
    this.pending = null;
    try {
      const snapshot = await this.storage.getSearchSnapshot(this.vaultId);
      if (!snapshot.descriptor) { this.state = "STALE"; return; }
      assertCompatibleDescriptor(snapshot.descriptor);
      if (this.available(snapshot) && this.ready) {
        await this.index.verify(this.ready.spec);
        await this.assertCurrent(snapshot, epoch);
        this.connected = true;
        return;
      }
      this.state = "BUILDING";
      const spec = indexSpec(this.config.collectionPrefix, snapshot, randomUUID());
      await this.index.ensureCollection(spec);
      await this.assertCurrent(snapshot, epoch);
      if (change && this.ready && change.revision === snapshot.revision &&
          this.ready.spec.collection === spec.collection && change.previousRevision === this.ready.snapshot.revision) {
        await this.index.verify(this.ready.spec);
        for (let offset = 0; offset < change.paths.length; offset += QDRANT_BATCH_SIZE) {
          await this.assertCurrent(snapshot, epoch);
          const paths = change.paths.slice(offset, offset + QDRANT_BATCH_SIZE);
          await this.index.deleteNotes(spec, paths);
          await this.upload(spec, snapshot, epoch, paths);
        }
        await this.index.stamp(spec);
      } else {
        await this.index.clear(spec);
        const uploaded = await this.upload(spec, snapshot, epoch);
        if (uploaded !== snapshot.chunkCount) throw new QdrantIndexError();
      }
      await this.index.verify(spec);
      await this.assertCurrent(snapshot, epoch);
      this.ready = { snapshot, spec };
      this.state = "READY";
      this.connected = true;
      this.lastErrorCode = null;
      this.lastSuccessfulSyncAt = new Date().toISOString();
      this.failures = 0;
    } catch (error) {
      this.state = epoch === this.epoch ? "ERROR" : "STALE";
      this.connected = false;
      this.lastErrorCode = error instanceof QdrantIndexError ? error.code : "QDRANT_INVALID_INDEX";
      this.failures = Math.min(this.failures + 1, 5);
      this.pending = null;
    }
  }
  close(): void {
    this.closed = true;
    this.epoch++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.index.close();
  }
}
