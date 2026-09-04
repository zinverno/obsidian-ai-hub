import type { MirroredNote, SemanticDescriptor, SyncBatchRequest } from "../src/protocol/types.js";
import { PROTOCOL_VERSION } from "../src/protocol/types.js";

export const VAULT_A = "11111111-1111-4111-8111-111111111111";
export const VAULT_B = "22222222-2222-4222-8222-222222222222";

export function descriptor(overrides: Partial<SemanticDescriptor> = {}): SemanticDescriptor {
  return {
    providerId: "openai-compatible",
    model: "text-embedding-test",
    baseUrl: "https://embed.example/v1",
    dimensions: 3,
    embeddingSpaceId: "embedding-space:v1|provider=openai-compatible|model=text-embedding-test|endpoint=https%3A%2F%2Fembed.example%2Fv1|dimensions=3",
    normalized: true,
    ...overrides,
  };
}

export function note(path = "A.md", content = "# A\n\nAlpha", vector = [0.25, -0.5, 0.75]): MirroredNote {
  return {
    path,
    content,
    contentHash: `note-${content}`,
    metadata: { test: true },
    chunks: [{
      chunkId: `chunk-${path}-${content}`,
      notePath: path,
      ordinal: 0,
      headingPath: [path.replace(/\.md$/u, "")],
      text: `${path.replace(/\.md$/u, "")}\n\n${content.split("\n").at(-1) ?? ""}`,
      contentHash: `chunk-hash-${content}`,
      source: { startOffset: 0, endOffset: content.length, startLine: 0, endLine: 2 },
      embedding: vector,
    }],
  };
}

export function upsertBatch(
  generation: number,
  notes: MirroredNote[],
  overrides: Partial<SyncBatchRequest> = {},
): SyncBatchRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    generation,
    descriptor: descriptor(),
    operations: notes.map((value) => ({ type: "UPSERT" as const, note: value })),
    ...overrides,
  };
}
