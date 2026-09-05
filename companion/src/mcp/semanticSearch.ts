import type { McpReadStorage, SearchSnapshot } from "../storage/mcpReadStorage.js";
import { assertCompatibleDescriptor } from "./descriptor.js";
import { boundedHeadings } from "./bounds.js";
import { semanticSearchUnavailable } from "./errors.js";
import type { QueryEmbeddingProvider } from "./queryEmbedding.js";
import { normalizeQuery } from "../search/vectorMath.js";
import { SQLiteVectorBackend } from "../search/sqliteVectorBackend.js";
import { compareCandidates, sameSnapshot, sameSpace } from "../search/vectorBackend.js";
import type { DerivedVectorBackend, SearchContext, VectorCandidate } from "../search/vectorBackend.js";

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

function boundedText(text: string): { text: string; totalTextChars: number; textTruncated: boolean } {
  const codePoints = Array.from(text);
  return {
    text: codePoints.slice(0, MAX_SEARCH_TEXT_CODE_POINTS).join(""),
    totalTextChars: codePoints.length,
    textTruncated: codePoints.length > MAX_SEARCH_TEXT_CODE_POINTS,
  };
}

export class SemanticSearchService {
  private readonly sqlite: SQLiteVectorBackend;

  constructor(
    private readonly storage: McpReadStorage,
    private readonly provider: QueryEmbeddingProvider,
    private readonly accelerator?: DerivedVectorBackend,
  ) {
    this.sqlite = new SQLiteVectorBackend(storage);
  }

  async search(vaultId: string, query: string, limit: number): Promise<McpSearchResult[]> {
    const status = await this.storage.getSearchSnapshot(vaultId);
    if (!status.exists || status.chunkCount === 0) return [];
    const descriptor = status.descriptor;
    if (!descriptor) throw semanticSearchUnavailable();
    assertCompatibleDescriptor(descriptor);
    let queryVector: Float32Array;
    try {
      queryVector = normalizeQuery(await this.provider.embedQuery(descriptor, query), descriptor.dimensions);
    } catch {
      throw semanticSearchUnavailable();
    }
    const afterEmbedding = await this.storage.getSearchSnapshot(vaultId);
    if (!sameSnapshot(afterEmbedding, status)) throw semanticSearchUnavailable();
    const context: SearchContext = { snapshot: status, queryVector };
    if (this.accelerator?.available(status)) {
      try {
        const candidates = await this.accelerator.search(context, limit);
        const results = await this.hydrate(status, candidates, limit);
        if (!this.accelerator.available(status)) throw semanticSearchUnavailable();
        this.accelerator.recordBackend("qdrant");
        return results;
      } catch {
        this.accelerator.invalidate();
        // Fallback always reuses the already normalized query vector.
      }
    }
    try {
      const current = await this.storage.getSearchSnapshot(vaultId);
      if (!sameSpace(current.descriptor, descriptor)) throw semanticSearchUnavailable();
      const candidates = await this.sqlite.search({ snapshot: current, queryVector }, limit);
      const results = await this.hydrate(current, candidates, limit);
      this.accelerator?.recordBackend("sqlite");
      return results;
    } catch {
      throw semanticSearchUnavailable();
    }
  }

  private async hydrate(snapshot: SearchSnapshot, candidates: VectorCandidate[], limit: number): Promise<McpSearchResult[]> {
    if (new Set(candidates.map((item) => item.chunkId)).size !== candidates.length || candidates.length !== Math.min(limit, snapshot.chunkCount)) {
      throw semanticSearchUnavailable();
    }
    const chunks = await this.storage.getSearchChunks(snapshot.vaultId, candidates.map((item) => item.chunkId));
    if (!sameSnapshot(await this.storage.getSearchSnapshot(snapshot.vaultId), snapshot)) throw semanticSearchUnavailable();
    return candidates.sort(compareCandidates).map(({ chunkId, score }) => {
      const record = chunks.get(chunkId);
      if (!record || !Number.isFinite(score) || score < -1 || score > 1) throw semanticSearchUnavailable();
      return {
        path: record.path,
        chunkId: record.chunkId,
        ordinal: record.ordinal,
        ...boundedHeadings(record.headingPath),
        source: { ...record.source },
        score,
        ...boundedText(record.text),
      };
    });
  }
}

/** Kept as an independently testable, permanent SQLite-only entry point. */
export class SqliteSemanticSearch extends SemanticSearchService {
  constructor(storage: McpReadStorage, provider: QueryEmbeddingProvider) { super(storage, provider); }
}
