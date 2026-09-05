import { createHash } from "node:crypto";
import { QdrantClient } from "@qdrant/js-client-rest";
import type { QdrantConfig } from "../config.js";
import type { McpStoredVector, SearchSnapshot } from "../storage/mcpReadStorage.js";
import { compareCandidates } from "./vectorBackend.js";
import type { VectorCandidate } from "./vectorBackend.js";
import { scoreVector } from "./vectorMath.js";

export const QDRANT_BATCH_SIZE = 128;
const MAX_CANDIDATES = 256;
export function identityHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function collectionName(prefix: string, vaultId: string, embeddingSpaceId: string): string {
  return `${prefix}_${identityHash(vaultId).slice(0, 32)}_${identityHash(embeddingSpaceId).slice(0, 32)}`;
}
export function pointId(vaultId: string, chunkId: string): string {
  const hash = identityHash(JSON.stringify([vaultId, chunkId])).slice(0, 32).split("");
  hash[12] = "8";
  hash[16] = ((Number.parseInt(hash[16]!, 16) & 3) | 8).toString(16);
  const hex = hash.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export class QdrantIndexError extends Error {
  constructor(readonly code: "QDRANT_UNAVAILABLE" | "QDRANT_INVALID_INDEX" = "QDRANT_INVALID_INDEX") {
    super(code);
    this.name = "QdrantIndexError";
  }
}
export interface IndexSpec {
  collection: string;
  owner: string;
  vaultId: string;
  embeddingSpaceId: string;
  dimensions: number;
  generation: number;
  revision: number;
  buildId: string;
  count: number;
}
export interface IndexPoint {
  id: string;
  vector: number[];
  payload: {
    chunkId: string; vaultId: string; embeddingSpaceId: string; generation: number;
    revision: number; buildId: string; noteKey: string;
  };
}
export function indexSpec(prefix: string, snapshot: SearchSnapshot, buildId: string): IndexSpec {
  const descriptor = snapshot.descriptor;
  if (!descriptor) throw new QdrantIndexError();
  return {
    collection: collectionName(prefix, snapshot.vaultId, descriptor.embeddingSpaceId),
    owner: identityHash(JSON.stringify(["vault-audit-ai:1", snapshot.vaultId, descriptor.embeddingSpaceId])),
    vaultId: snapshot.vaultId, embeddingSpaceId: descriptor.embeddingSpaceId, dimensions: descriptor.dimensions,
    generation: snapshot.generation, revision: snapshot.revision, buildId, count: snapshot.chunkCount,
  };
}
export function indexPoint(spec: IndexSpec, record: McpStoredVector): IndexPoint {
  if (record.vector.length !== spec.dimensions) throw new QdrantIndexError();
  scoreVector(record.vector, record.vector); // Validate finite, unit-length stored vectors without modifying them.
  return {
    id: pointId(spec.vaultId, record.chunkId), vector: Array.from(record.vector),
    payload: {
      chunkId: record.chunkId, vaultId: spec.vaultId, embeddingSpaceId: spec.embeddingSpaceId,
      generation: spec.generation, revision: spec.revision, buildId: spec.buildId,
      noteKey: identityHash(record.path),
    },
  };
}
export interface QdrantVectorIndex {
  ensureCollection(spec: IndexSpec): Promise<void>;
  clear(spec: IndexSpec): Promise<void>;
  upsert(spec: IndexSpec, points: IndexPoint[]): Promise<void>;
  deleteNotes(spec: IndexSpec, paths: readonly string[]): Promise<void>;
  stamp(spec: IndexSpec): Promise<void>;
  verify(spec: IndexSpec): Promise<void>;
  search(spec: IndexSpec, vector: Float32Array, limit: number): Promise<VectorCandidate[]>;
  close(): void;
}
function stampPayload(spec: IndexSpec): Pick<IndexPoint["payload"], "vaultId" | "embeddingSpaceId" | "generation" | "revision" | "buildId"> {
  return { vaultId: spec.vaultId, embeddingSpaceId: spec.embeddingSpaceId,
    generation: spec.generation, revision: spec.revision, buildId: spec.buildId };
}
function currentFilter(spec: IndexSpec): { must: Array<{ key: string; match: { value: string | number } }> } {
  return { must: Object.entries(stampPayload(spec)).map(([key, value]) => ({ key, match: { value } })) };
}
const REQUEST_OPTIONS = { redirect: "error" } as const;

/** Official generated SDK operations allow redirect refusal on every request. */
export class QdrantClientIndex implements QdrantVectorIndex {
  private readonly api: ReturnType<QdrantClient["api"]>;
  private closed = false;
  constructor(config: QdrantConfig) {
    try {
      const url = new URL(config.url);
      this.api = new QdrantClient({
      url: url.origin, prefix: url.pathname === "/" ? "" : url.pathname, port: null,
      timeout: config.timeoutMs, maxConnections: 4, checkCompatibility: false,
      headers: config.apiKey ? { "api-key": config.apiKey } : {},
      }).api();
    } catch { throw new QdrantIndexError("QDRANT_UNAVAILABLE"); }
  }
  private async request<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new QdrantIndexError("QDRANT_UNAVAILABLE");
    try { return await operation(); } catch (error) {
      if (error instanceof QdrantIndexError) throw error;
      // Never retain upstream messages, response bodies, URLs, headers or causes.
      throw new QdrantIndexError("QDRANT_UNAVAILABLE");
    }
  }
  async ensureCollection(spec: IndexSpec): Promise<void> {
    await this.request(async () => {
      const exists = await this.api.collectionExists({ collection_name: spec.collection }, REQUEST_OPTIONS);
      if (exists.data.result?.exists === false) {
        const created = await this.api.createCollection({
          collection_name: spec.collection, vectors: { size: spec.dimensions, distance: "Cosine" },
          metadata: { vaultAuditOwner: spec.owner },
        }, REQUEST_OPTIONS);
        if (created.data.result !== true) throw new QdrantIndexError();
      } else if (exists.data.result?.exists !== true) throw new QdrantIndexError();
      await this.checkCollection(spec);
    });
  }
  private async checkCollection(spec: IndexSpec): Promise<void> {
    const result = (await this.api.getCollection({ collection_name: spec.collection }, REQUEST_OPTIONS)).data.result;
    const vectors = result?.config.params.vectors;
    if (!result || result.status === "red" || result.config.metadata?.vaultAuditOwner !== spec.owner ||
        !vectors || vectors.size !== spec.dimensions || vectors.distance !== "Cosine") throw new QdrantIndexError();
  }
  private completed(value: unknown): void {
    if (!value || typeof value !== "object" || !("status" in value) || value.status !== "completed") {
      throw new QdrantIndexError();
    }
  }
  async clear(spec: IndexSpec): Promise<void> {
    await this.request(async () => {
      await this.checkCollection(spec); // Never clear a foreign or incompatible collection.
      this.completed((await this.api.deletePoints({ collection_name: spec.collection, wait: true, filter: {} }, REQUEST_OPTIONS)).data.result);
    });
  }
  async upsert(spec: IndexSpec, points: IndexPoint[]): Promise<void> {
    await this.request(async () => {
      if (points.length > QDRANT_BATCH_SIZE || points.some((point) => point.vector.length !== spec.dimensions)) throw new QdrantIndexError();
      this.completed((await this.api.upsertPoints({ collection_name: spec.collection, wait: true, points }, REQUEST_OPTIONS)).data.result);
    });
  }
  async deleteNotes(spec: IndexSpec, paths: readonly string[]): Promise<void> {
    await this.request(async () => {
      if (paths.length > QDRANT_BATCH_SIZE) throw new QdrantIndexError();
      this.completed((await this.api.deletePoints({ collection_name: spec.collection, wait: true,
        filter: { must: [{ key: "noteKey", match: { any: paths.map(identityHash) } }] },
      }, REQUEST_OPTIONS)).data.result);
    });
  }
  async stamp(spec: IndexSpec): Promise<void> {
    await this.request(async () => {
      this.completed((await this.api.setPayload({ collection_name: spec.collection, wait: true,
        filter: {}, payload: stampPayload(spec),
      }, REQUEST_OPTIONS)).data.result);
    });
  }
  async verify(spec: IndexSpec): Promise<void> {
    await this.request(async () => {
      await this.checkCollection(spec);
      const all = await this.api.countPoints({ collection_name: spec.collection, exact: true }, REQUEST_OPTIONS);
      const current = await this.api.countPoints({ collection_name: spec.collection, exact: true, filter: currentFilter(spec) }, REQUEST_OPTIONS);
      if (all.data.result?.count !== spec.count || current.data.result?.count !== spec.count) throw new QdrantIndexError();
    });
  }
  async search(spec: IndexSpec, vector: Float32Array, limit: number): Promise<VectorCandidate[]> {
    return this.request(async () => {
      await this.verify(spec); // Detect offline, missing, empty, restored or partially deleted indexes.
      if (vector.length !== spec.dimensions || !Array.from(vector).every(Number.isFinite)) throw new QdrantIndexError();
      const requested = Math.min(spec.count, Math.min(MAX_CANDIDATES, Math.max(64, limit * 4)) + 1);
      const response = await this.api.queryPoints({
        collection_name: spec.collection, query: Array.from(vector), filter: currentFilter(spec),
        limit: requested, with_payload: true, with_vector: false,
      }, REQUEST_OPTIONS);
      const points = response.data.result?.points;
      if (!Array.isArray(points) || points.length !== requested) throw new QdrantIndexError();
      const candidates = points.map((point) => {
        const payload = point.payload;
        if (!payload || typeof payload.chunkId !== "string" || point.id !== pointId(spec.vaultId, payload.chunkId) ||
            Object.entries(stampPayload(spec)).some(([key, value]) => payload[key] !== value) ||
            !Number.isFinite(point.score) || point.score < -1.000001 || point.score > 1.000001) throw new QdrantIndexError();
        return { chunkId: payload.chunkId, score: Math.max(-1, Math.min(1, point.score)) };
      }).sort(compareCandidates);
      if (new Set(candidates.map((point) => point.chunkId)).size !== candidates.length) throw new QdrantIndexError();
      // If the bounded candidate window cuts a tie, SQLite resolves the complete tie deterministically.
      if (requested < spec.count && Math.abs(candidates[limit - 1]!.score - candidates.at(-1)!.score) <= 1e-6) throw new QdrantIndexError();
      return candidates.slice(0, limit);
    });
  }
  close(): void { this.closed = true; }
}
