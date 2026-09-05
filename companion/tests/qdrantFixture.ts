import type { IndexPoint, IndexSpec, QdrantVectorIndex } from "../src/search/qdrantIndex.js";
import { identityHash, QdrantIndexError } from "../src/search/qdrantIndex.js";
import { compareCandidates } from "../src/search/vectorBackend.js";
import type { VectorCandidate } from "../src/search/vectorBackend.js";

export class FakeQdrantIndex implements QdrantVectorIndex {
  readonly collections = new Map<string, { owner: string; dimensions: number; points: Map<string, IndexPoint> }>();
  readonly calls: Array<{ method: string; collection: string; size?: number }> = [];
  before: (method: string, spec: IndexSpec) => Promise<void> = () => Promise.resolve();
  fail: string | null = null;
  searchResult: VectorCandidate[] | null = null;
  private async operation(method: string, spec: IndexSpec, size?: number): Promise<void> {
    this.calls.push({ method, collection: spec.collection, ...(size === undefined ? {} : { size }) });
    await this.before(method, spec);
    if (this.fail === method || this.fail === "all") throw new Error("upstream api-key=super-secret-qdrant");
  }
  async ensureCollection(spec: IndexSpec): Promise<void> {
    await this.operation("ensure", spec);
    if (!this.collections.has(spec.collection)) this.collections.set(spec.collection, { owner: spec.owner, dimensions: spec.dimensions, points: new Map() });
    const collection = this.collections.get(spec.collection)!;
    if (collection.owner !== spec.owner || collection.dimensions !== spec.dimensions) throw new QdrantIndexError();
  }
  async clear(spec: IndexSpec): Promise<void> { await this.operation("clear", spec); this.collections.get(spec.collection)!.points.clear(); }
  async upsert(spec: IndexSpec, points: IndexPoint[]): Promise<void> {
    await this.operation("upsert", spec, points.length);
    for (const point of points) this.collections.get(spec.collection)!.points.set(point.id, structuredClone(point));
  }
  async deleteNotes(spec: IndexSpec, paths: readonly string[]): Promise<void> {
    await this.operation("delete", spec, paths.length);
    const hashes = paths.map(identityHash);
    for (const [id, point] of this.collections.get(spec.collection)!.points) {
      if (hashes.includes(point.payload.noteKey)) this.collections.get(spec.collection)!.points.delete(id);
    }
  }
  async stamp(spec: IndexSpec): Promise<void> {
    await this.operation("stamp", spec);
    for (const point of this.collections.get(spec.collection)!.points.values()) {
      Object.assign(point.payload, { generation: spec.generation, revision: spec.revision, buildId: spec.buildId });
    }
  }
  async verify(spec: IndexSpec): Promise<void> {
    await this.operation("verify", spec);
    const collection = this.collections.get(spec.collection);
    if (!collection || collection.owner !== spec.owner || collection.dimensions !== spec.dimensions || collection.points.size !== spec.count ||
        [...collection.points.values()].some(({ payload: p }) => p.vaultId !== spec.vaultId || p.embeddingSpaceId !== spec.embeddingSpaceId ||
          p.generation !== spec.generation || p.revision !== spec.revision || p.buildId !== spec.buildId)) throw new QdrantIndexError();
  }
  async search(spec: IndexSpec, vector: Float32Array, limit: number): Promise<VectorCandidate[]> {
    await this.operation("search", spec);
    if (this.searchResult) return this.searchResult;
    await this.verify(spec);
    return [...this.collections.get(spec.collection)!.points.values()].map((point) => ({
      chunkId: point.payload.chunkId,
      score: point.vector.reduce((total, value, i) => total + value * vector[i]!, 0),
    })).sort(compareCandidates).slice(0, limit);
  }
  close(): void { /* In-memory fixture owns no handles. */ }
}
