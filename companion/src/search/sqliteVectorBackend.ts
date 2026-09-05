import type { McpReadStorage } from "../storage/mcpReadStorage.js";
import { semanticSearchUnavailable } from "../mcp/errors.js";
import { scoreVector } from "./vectorMath.js";
import { compareCandidates } from "./vectorBackend.js";
import type { SearchContext, VectorCandidate, VectorSearchBackend } from "./vectorBackend.js";

export class SQLiteVectorBackend implements VectorSearchBackend {
  constructor(private readonly storage: McpReadStorage) {}
  search({ snapshot, queryVector }: SearchContext, limit: number): Promise<VectorCandidate[]> {
    if (!snapshot.descriptor) throw semanticSearchUnavailable();
    const ranked: VectorCandidate[] = [];
    for (const record of this.storage.iterateMcpVectors(snapshot.vaultId, snapshot.descriptor.dimensions)) {
      ranked.push({ chunkId: record.chunkId, score: scoreVector(record.vector, queryVector) });
      ranked.sort(compareCandidates);
      if (ranked.length > limit) ranked.length = limit;
    }
    return Promise.resolve(ranked);
  }
}
