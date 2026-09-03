import { describe, expect, it, vi } from "vitest";
import type {
  ChunkingStrategy,
  MarkdownChunkInput,
  NoteChunk,
} from "../chunking/types";
import type {
  IndexDocumentInput,
  MarkdownDocumentSource,
} from "../indexing/types";
import type {
  SemanticChunkMatch,
  SemanticDocumentResult,
} from "../semantic/types";
import {
  DEFAULT_RAG_CANDIDATE_CHUNKS_PER_DOCUMENT,
  DEFAULT_RAG_CANDIDATE_DOCUMENT_LIMIT,
  RagContextBuilder,
} from "./ragContextBuilder";
import { RagValidationError } from "./errors";

function chunk(
  path: string,
  id: string,
  text: string,
  ordinal = 0,
  overrides: Partial<NoteChunk> = {},
): NoteChunk {
  return {
    id,
    path,
    ordinal,
    headingPath: ["Root", id],
    text,
    contentHash: "hash-" + id,
    source: {
      startOffset: 0,
      endOffset: text.length,
      startLine: 0,
      endLine: 0,
    },
    ...overrides,
  };
}

function match(
  value: NoteChunk,
  score: number,
  overrides: Partial<SemanticChunkMatch> = {},
): SemanticChunkMatch {
  return {
    id: value.id,
    path: value.path,
    headingPath: [...value.headingPath],
    ordinal: value.ordinal,
    contentHash: value.contentHash,
    preview: "PREVIEW MUST NOT BE USED",
    source: { ...value.source },
    score,
    ...overrides,
  };
}

function document(
  path: string,
  score: number,
  matches: SemanticChunkMatch[],
): SemanticDocumentResult {
  return { path, score, matches };
}

class FixedChunker implements ChunkingStrategy {
  constructor(readonly chunksByPath: Map<string, NoteChunk[]>) {}

  chunk(input: MarkdownChunkInput): NoteChunk[] {
    return (this.chunksByPath.get(input.path) ?? []).map((value) => ({
      ...value,
      headingPath: [...value.headingPath],
      source: { ...value.source },
    }));
  }
}

class FakeSource implements MarkdownDocumentSource {
  readonly calls: string[][] = [];
  readonly failPaths = new Set<string>();

  constructor(readonly documents: Map<string, IndexDocumentInput>) {}

  async readAll(): Promise<IndexDocumentInput[]> {
    return [...this.documents.values()];
  }

  async readPaths(paths: readonly string[]): Promise<{
    documents: IndexDocumentInput[];
    missingPaths: string[];
  }> {
    this.calls.push([...paths]);
    if (paths.some((path) => this.failPaths.has(path))) {
      throw new Error("source vanished");
    }
    const documents = paths
      .map((path) => this.documents.get(path))
      .filter((value): value is IndexDocumentInput => Boolean(value));
    const found = new Set(documents.map((value) => value.path));
    return {
      documents,
      missingPaths: paths.filter((path) => !found.has(path)),
    };
  }
}

function harness(
  results: SemanticDocumentResult[],
  chunks: NoteChunk[],
  options: ConstructorParameters<typeof RagContextBuilder>[3] = {},
) {
  const search = {
    search: vi.fn(async () => results),
  };
  const chunksByPath = new Map<string, NoteChunk[]>();
  const documents = new Map<string, IndexDocumentInput>();
  for (const value of chunks) {
    const stored = chunksByPath.get(value.path) ?? [];
    stored.push(value);
    chunksByPath.set(value.path, stored);
    const minimumLength = Math.max(
      value.source.endOffset,
      value.text.length,
      documents.get(value.path)?.content.length ?? 0,
    );
    documents.set(value.path, {
      path: value.path,
      content: "x".repeat(minimumLength || 1),
    });
  }
  const source = new FakeSource(documents);
  const builder = new RagContextBuilder(
    search,
    source,
    new FixedChunker(chunksByPath),
    options,
  );
  return { builder, search, source, documents, chunksByPath };
}

describe("RagContextBuilder", () => {
  it("retrieves once with a broad bounded candidate set and uses full chunk text", async () => {
    const value = chunk("A.md", "a1", "the complete reconstructed chunk");
    const { builder, search } = harness([
      document("A.md", 0.9, [match(value, 0.9)]),
    ], [value]);

    const context = await builder.build("question");

    expect(search.search).toHaveBeenCalledOnce();
    expect(search.search).toHaveBeenCalledWith("question", {
      limit: DEFAULT_RAG_CANDIDATE_DOCUMENT_LIMIT,
      matchesPerDocument: DEFAULT_RAG_CANDIDATE_CHUNKS_PER_DOCUMENT,
    });
    expect(context.sources[0].text).toBe("the complete reconstructed chunk");
    expect(context.sources[0].text).not.toContain("PREVIEW");
  });

  it("orders tied documents and their matches deterministically", async () => {
    const a1 = chunk("A.md", "a1", "a-one", 0);
    const a2 = chunk("A.md", "a2", "a-two", 1);
    const b1 = chunk("B.md", "b1", "b-one", 0);
    const { builder } = harness([
      document("B.md", 0.8, [match(b1, 0.8)]),
      document("A.md", 0.8, [match(a2, 0.6), match(a1, 0.9)]),
    ], [a1, a2, b1]);

    const context = await builder.build("question");

    expect(context.sources.map((source) => source.chunkId)).toEqual([
      "a1",
      "b1",
      "a2",
    ]);
  });

  it("round-robins documents before selecting second chunks", async () => {
    const values = [
      chunk("A.md", "a1", "a1", 0),
      chunk("A.md", "a2", "a2", 1),
      chunk("B.md", "b1", "b1", 0),
      chunk("B.md", "b2", "b2", 1),
    ];
    const { builder } = harness([
      document("A.md", 0.9, [match(values[0], 0.9), match(values[1], 0.8)]),
      document("B.md", 0.7, [match(values[2], 0.7), match(values[3], 0.6)]),
    ], values);

    const context = await builder.build("question");

    expect(context.sources.map((source) => source.chunkId)).toEqual([
      "a1",
      "b1",
      "a2",
      "b2",
    ]);
  });

  it("enforces max chunks per document", async () => {
    const values = [
      chunk("A.md", "a1", "a1", 0),
      chunk("A.md", "a2", "a2", 1),
    ];
    const { builder } = harness([
      document("A.md", 1, [match(values[0], 1), match(values[1], 0.9)]),
    ], values, {
      candidateDocumentLimit: 2,
      candidateChunksPerDocument: 2,
      maxDocuments: 2,
      maxChunksPerDocument: 1,
    });

    expect((await builder.build("q")).sources.map((source) => source.chunkId))
      .toEqual(["a1"]);
  });

  it("enforces max source documents", async () => {
    const values = ["A", "B", "C"].map((name, index) =>
      chunk(name + ".md", name.toLowerCase(), name, index),
    );
    const results = values.map((value, index) =>
      document(value.path, 1 - index / 10, [match(value, 1 - index / 10)]),
    );
    const { builder } = harness(results, values, {
      candidateDocumentLimit: 3,
      maxDocuments: 2,
    });

    expect(new Set((await builder.build("q")).sources.map((source) => source.path)))
      .toEqual(new Set(["A.md", "B.md"]));
  });

  it("uses a Unicode code-point budget instead of UTF-16 length", async () => {
    const emoji = chunk("Emoji.md", "emoji", "😀😀");
    const extra = chunk("Extra.md", "extra", "x");
    const { builder } = harness([
      document("Emoji.md", 1, [match(emoji, 1)]),
      document("Extra.md", 0.9, [match(extra, 0.9)]),
    ], [emoji, extra], {
      maxContextCodePoints: 2,
    });

    const context = await builder.build("q");

    expect(context.usedCodePoints).toBe(2);
    expect(context.sources.map((source) => source.chunkId)).toEqual(["emoji"]);
  });

  it("skips oversized chunks and continues with smaller candidates", async () => {
    const huge = chunk("Huge.md", "huge", "123456");
    const small = chunk("Small.md", "small", "ok");
    const { builder } = harness([
      document("Huge.md", 1, [match(huge, 1)]),
      document("Small.md", 0.9, [match(small, 0.9)]),
    ], [huge, small], { maxContextCodePoints: 3 });

    expect((await builder.build("q")).sources.map((source) => source.chunkId))
      .toEqual(["small"]);
  });

  it("deduplicates repeated chunk IDs", async () => {
    const value = chunk("A.md", "same", "one");
    const { builder } = harness([
      document("A.md", 1, [match(value, 1), match(value, 0.9)]),
    ], [value]);

    expect((await builder.build("q")).sources).toHaveLength(1);
  });

  it("deduplicates identical reconstructed content across documents", async () => {
    const a = chunk("A.md", "a", "identical");
    const b = chunk("B.md", "b", "identical");
    const { builder } = harness([
      document("A.md", 1, [match(a, 1)]),
      document("B.md", 0.9, [match(b, 0.9)]),
    ], [a, b]);

    expect((await builder.build("q")).sources.map((source) => source.path))
      .toEqual(["A.md"]);
  });

  it("drops a missing source document", async () => {
    const value = chunk("Missing.md", "missing", "gone");
    const { builder, documents } = harness([
      document("Missing.md", 1, [match(value, 1)]),
    ], [value]);
    documents.delete("Missing.md");

    expect((await builder.build("q")).sources).toEqual([]);
  });

  it("isolates a deleted or unreadable candidate and keeps other documents", async () => {
    const a = chunk("A.md", "a", "unreadable");
    const b = chunk("B.md", "b", "available");
    const { builder, source } = harness([
      document("A.md", 1, [match(a, 1)]),
      document("B.md", 0.9, [match(b, 0.9)]),
    ], [a, b]);
    source.failPaths.add("A.md");

    expect((await builder.build("q")).sources.map((item) => item.path))
      .toEqual(["B.md"]);
  });

  it("drops a stale chunk that can no longer be found by stable ID", async () => {
    const indexed = chunk("A.md", "old", "old content");
    const current = chunk("A.md", "new", "new content");
    const { builder } = harness([
      document("A.md", 1, [match(indexed, 1)]),
    ], [current]);

    expect((await builder.build("q")).sources).toEqual([]);
  });

  it("drops a chunk whose reconstructed contentHash changed", async () => {
    const indexed = chunk("A.md", "same", "old", 0, { contentHash: "old-hash" });
    const current = chunk("A.md", "same", "new", 0, { contentHash: "new-hash" });
    const { builder } = harness([
      document("A.md", 1, [match(indexed, 1)]),
    ], [current]);

    expect((await builder.build("q")).sources).toEqual([]);
  });

  it("drops invalid indexed source ranges", async () => {
    const value = chunk("A.md", "a", "safe");
    const bad = match(value, 1, {
      source: { startOffset: 0, endOffset: 999, startLine: 0, endLine: 0 },
    });
    const { builder } = harness([document("A.md", 1, [bad])], [value]);

    expect((await builder.build("q")).sources).toEqual([]);
  });

  it("drops invalid reconstructed source ranges", async () => {
    const value = chunk("A.md", "a", "safe", 0, {
      source: { startOffset: 0, endOffset: 999, startLine: 0, endLine: 0 },
    });
    const indexed = match(value, 1, {
      source: { startOffset: 0, endOffset: 1, startLine: 0, endLine: 0 },
    });
    const { builder } = harness([document("A.md", 1, [indexed])], [value]);
    const sourceDocument = {
      path: "A.md",
      content: "short",
    };
    (builder as unknown as { source: FakeSource }).source.documents.set(
      "A.md",
      sourceDocument,
    );

    expect((await builder.build("q")).sources).toEqual([]);
  });

  it("rejects invalid vault-relative candidate paths without reading them", async () => {
    const value = chunk("../A.md", "a", "unsafe");
    const { builder, source } = harness([
      document("../A.md", 1, [match(value, 1)]),
    ], [value]);

    expect((await builder.build("q")).sources).toEqual([]);
    expect(source.calls).toEqual([]);
  });

  it("assigns stable code-owned source IDs and freezes the materialized context", async () => {
    const a = chunk("A.md", "a", "alpha");
    const b = chunk("B.md", "b", "beta");
    const { builder } = harness([
      document("A.md", 1, [match(a, 1)]),
      document("B.md", 0.9, [match(b, 0.9)]),
    ], [a, b]);

    const first = await builder.build("q");
    const second = await builder.build("q");

    expect(first.sources.map((source) => source.id)).toEqual(["S1", "S2"]);
    expect(second.sources.map((source) => source.id)).toEqual(["S1", "S2"]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.sources)).toBe(true);
    expect(Object.isFrozen(first.sources[0].source)).toBe(true);
  });

  it("reads each candidate document at most once", async () => {
    const a1 = chunk("A.md", "a1", "alpha", 0);
    const a2 = chunk("A.md", "a2", "beta", 1);
    const { builder, source } = harness([
      document("A.md", 1, [match(a1, 1), match(a2, 0.9)]),
    ], [a1, a2]);

    await builder.build("q");

    expect(source.calls).toEqual([["A.md"]]);
  });

  it("validates context limits", () => {
    const dependencies = [{ search: vi.fn() }, new FakeSource(new Map()), new FixedChunker(new Map())] as const;
    expect(() => new RagContextBuilder(...dependencies, {
      candidateDocumentLimit: 1,
      maxDocuments: 2,
    })).toThrow(RagValidationError);
    expect(() => new RagContextBuilder(...dependencies, {
      candidateChunksPerDocument: 1,
      maxChunksPerDocument: 2,
    })).toThrow(RagValidationError);
    expect(() => new RagContextBuilder(...dependencies, {
      maxContextCodePoints: 0,
    })).toThrow(RagValidationError);
  });
});
