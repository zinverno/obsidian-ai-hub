import type { SemanticDescriptor } from "../protocol/types.js";
import type { McpReadStorage, McpStoredVector } from "../storage/mcpReadStorage.js";
import { assertCompatibleDescriptor } from "./descriptor.js";
import { boundedHeadings } from "./bounds.js";
import { semanticSearchUnavailable } from "./errors.js";
import type { QueryEmbeddingProvider } from "./queryEmbedding.js";

const MIN_VECTOR_NORM = 1e-12;
const STORED_UNIT_NORM_TOLERANCE = 1e-4;
export const MAX_SEARCH_TEXT_CODE_POINTS = 4000;

export interface McpSearchResult {
  path: string;
  chunkId: string;
  ordinal: number;
  headingPath: string[];
  headingPathTruncated: boolean;
  totalHeadings: number;
  source: {
    startOffset: number;
    endOffset: number;
    startLine: number;
    endLine: number;
  };
  score: number;
  text: string;
  totalTextChars: number;
  textTruncated: boolean;
}

interface RankedVector {
  record: McpStoredVector;
  score: number;
}

function compareRank(left: RankedVector, right: RankedVector): number {
  if (right.score !== left.score) return right.score - left.score;
  return left.record.chunkId < right.record.chunkId ? -1 : left.record.chunkId > right.record.chunkId ? 1 : 0;
}

function vectorNorm(vector: Float32Array): number {
  let squared = 0;
  for (let index = 0; index < vector.length; index++) {
    const value = vector[index] ?? Number.NaN;
    if (!Number.isFinite(value)) throw semanticSearchUnavailable();
    squared += value * value;
  }
  const norm = Math.sqrt(squared);
  if (!Number.isFinite(norm) || norm <= MIN_VECTOR_NORM) throw semanticSearchUnavailable();
  return norm;
}

function normalizeQuery(vector: Float32Array, dimensions: number): Float32Array {
  if (vector.length !== dimensions) throw semanticSearchUnavailable();
  const norm = vectorNorm(vector);
  const result = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index++) result[index] = (vector[index] ?? 0) / norm;
  return result;
}

function scoreVector(stored: Float32Array, query: Float32Array): number {
  if (stored.length !== query.length) throw semanticSearchUnavailable();
  const norm = vectorNorm(stored);
  if (Math.abs(norm - 1) > STORED_UNIT_NORM_TOLERANCE) throw semanticSearchUnavailable();
  let score = 0;
  for (let index = 0; index < stored.length; index++) score += (stored[index] ?? 0) * (query[index] ?? 0);
  if (!Number.isFinite(score)) throw semanticSearchUnavailable();
  return Math.max(-1, Math.min(1, score));
}

function boundedText(text: string): { text: string; totalTextChars: number; textTruncated: boolean } {
  const codePoints = Array.from(text);
  return {
    text: codePoints.slice(0, MAX_SEARCH_TEXT_CODE_POINTS).join(""),
    totalTextChars: codePoints.length,
    textTruncated: codePoints.length > MAX_SEARCH_TEXT_CODE_POINTS,
  };
}

export class SqliteSemanticSearch {
  constructor(
    private readonly storage: McpReadStorage,
    private readonly provider: QueryEmbeddingProvider,
  ) {}

  async search(vaultId: string, query: string, limit: number): Promise<McpSearchResult[]> {
    const status = await this.storage.getMcpVaultStatus(vaultId);
    if (!status.exists || status.chunkCount === 0) return [];
    const descriptor: SemanticDescriptor | null = status.descriptor;
    if (!descriptor) throw semanticSearchUnavailable();
    assertCompatibleDescriptor(descriptor);

    let queryVector: Float32Array;
    try {
      queryVector = normalizeQuery(await this.provider.embedQuery(descriptor, query), descriptor.dimensions);
    } catch {
      throw semanticSearchUnavailable();
    }

    // A sync may commit while the provider request is in flight. Never use its
    // query vector with a replacement space, or return a mixed generation.
    const afterEmbedding = await this.storage.getMcpVaultStatus(vaultId);
    if (JSON.stringify(afterEmbedding) !== JSON.stringify(status)) throw semanticSearchUnavailable();

    const ranked: RankedVector[] = [];
    try {
      for (const record of this.storage.iterateMcpVectors(vaultId, descriptor.dimensions)) {
        ranked.push({ record, score: scoreVector(record.vector, queryVector) });
        ranked.sort(compareRank);
        if (ranked.length > limit) ranked.length = limit;
      }
    } catch {
      throw semanticSearchUnavailable();
    }
    const texts = await this.storage.getMcpChunkTexts(vaultId, ranked.map((item) => item.record.chunkId));
    if (JSON.stringify(await this.storage.getMcpVaultStatus(vaultId)) !== JSON.stringify(status)) {
      throw semanticSearchUnavailable();
    }
    return ranked.map(({ record, score }) => ({
      path: record.path,
      chunkId: record.chunkId,
      ordinal: record.ordinal,
      ...boundedHeadings(record.headingPath),
      source: { ...record.source },
      score,
      ...boundedText(texts.get(record.chunkId) ?? ""),
    }));
  }
}
