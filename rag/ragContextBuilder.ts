import type { ChunkingStrategy, NoteChunk } from "../chunking/types";
import type { MarkdownDocumentSource } from "../indexing/types";
import type { SemanticSearchService } from "../semantic/semanticSearchService";
import type {
  SemanticChunkMatch,
  SemanticDocumentResult,
} from "../semantic/types";
import { RagValidationError } from "./errors";
import type {
  RagContext,
  RagContextBuildOptions,
  RagSource,
} from "./types";

export const DEFAULT_RAG_CANDIDATE_DOCUMENT_LIMIT = 12;
export const DEFAULT_RAG_CANDIDATE_CHUNKS_PER_DOCUMENT = 3;
export const DEFAULT_RAG_MAX_DOCUMENTS = 6;
export const DEFAULT_RAG_MAX_CHUNKS_PER_DOCUMENT = 2;
export const DEFAULT_RAG_CONTEXT_CODE_POINTS = 12_000;

interface PreparedOptions {
  candidateDocumentLimit: number;
  candidateChunksPerDocument: number;
  maxDocuments: number;
  maxChunksPerDocument: number;
  maxContextCodePoints: number;
}

interface ReconstructedCandidate {
  path: string;
  score: number;
  chunk: NoteChunk;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RagValidationError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function prepareOptions(options: RagContextBuildOptions = {}): PreparedOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new RagValidationError("RAG context options must be an object.");
  }
  const prepared = {
    candidateDocumentLimit: positiveSafeInteger(
      options.candidateDocumentLimit ?? DEFAULT_RAG_CANDIDATE_DOCUMENT_LIMIT,
      "candidateDocumentLimit",
    ),
    candidateChunksPerDocument: positiveSafeInteger(
      options.candidateChunksPerDocument ??
        DEFAULT_RAG_CANDIDATE_CHUNKS_PER_DOCUMENT,
      "candidateChunksPerDocument",
    ),
    maxDocuments: positiveSafeInteger(
      options.maxDocuments ?? DEFAULT_RAG_MAX_DOCUMENTS,
      "maxDocuments",
    ),
    maxChunksPerDocument: positiveSafeInteger(
      options.maxChunksPerDocument ?? DEFAULT_RAG_MAX_CHUNKS_PER_DOCUMENT,
      "maxChunksPerDocument",
    ),
    maxContextCodePoints: positiveSafeInteger(
      options.maxContextCodePoints ?? DEFAULT_RAG_CONTEXT_CODE_POINTS,
      "maxContextCodePoints",
    ),
  };
  if (prepared.maxDocuments > prepared.candidateDocumentLimit) {
    throw new RagValidationError(
      "maxDocuments cannot exceed candidateDocumentLimit.",
    );
  }
  if (prepared.maxChunksPerDocument > prepared.candidateChunksPerDocument) {
    throw new RagValidationError(
      "maxChunksPerDocument cannot exceed candidateChunksPerDocument.",
    );
  }
  return prepared;
}

function isCanonicalMarkdownPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    !value.toLowerCase().endsWith(".md")
  ) {
    return false;
  }
  return !value
    .split("/")
    .some((segment) => !segment || segment === "." || segment === "..");
}

function chunkIsValid(
  chunk: NoteChunk,
  path: string,
  contentLength: number,
  lineCount: number,
): boolean {
  return (
    chunk &&
    chunk.path === path &&
    typeof chunk.id === "string" &&
    chunk.id.length > 0 &&
    typeof chunk.contentHash === "string" &&
    chunk.contentHash.length > 0 &&
    typeof chunk.text === "string" &&
    chunk.text.length > 0 &&
    Array.isArray(chunk.headingPath) &&
    chunk.headingPath.every((heading) => typeof heading === "string") &&
    Number.isSafeInteger(chunk.ordinal) &&
    chunk.ordinal >= 0 &&
    Boolean(chunk.source) &&
    Number.isSafeInteger(chunk.source.startOffset) &&
    Number.isSafeInteger(chunk.source.endOffset) &&
    Number.isSafeInteger(chunk.source.startLine) &&
    Number.isSafeInteger(chunk.source.endLine) &&
    chunk.source.startOffset >= 0 &&
    chunk.source.endOffset >= chunk.source.startOffset &&
    chunk.source.endOffset <= contentLength &&
    chunk.source.startLine >= 0 &&
    chunk.source.endLine >= chunk.source.startLine &&
    chunk.source.endLine < lineCount
  );
}

function orderedDocuments(
  results: readonly SemanticDocumentResult[],
): SemanticDocumentResult[] {
  return [...results].sort(
    (left, right) =>
      right.score - left.score || compareStrings(left.path, right.path),
  );
}

function orderedMatches(
  document: SemanticDocumentResult,
): SemanticChunkMatch[] {
  return [...document.matches].sort(
    (left, right) =>
      right.score - left.score ||
      left.ordinal - right.ordinal ||
      compareStrings(left.id, right.id),
  );
}

function freezeSource(source: RagSource): RagSource {
  return Object.freeze({
    ...source,
    headingPath: Object.freeze([...source.headingPath]),
    source: Object.freeze({ ...source.source }),
  });
}

export class RagContextBuilder {
  private readonly options: PreparedOptions;

  constructor(
    private readonly searchService: Pick<SemanticSearchService, "search">,
    private readonly source: MarkdownDocumentSource,
    private readonly chunker: ChunkingStrategy,
    options: RagContextBuildOptions = {},
  ) {
    if (!searchService || typeof searchService.search !== "function") {
      throw new RagValidationError("A semantic search service is required.");
    }
    if (!source || typeof source.readPaths !== "function") {
      throw new RagValidationError("A Markdown document source is required.");
    }
    if (!chunker || typeof chunker.chunk !== "function") {
      throw new RagValidationError("A Markdown chunker is required.");
    }
    this.options = prepareOptions(options);
  }

  async build(question: string): Promise<RagContext> {
    const results = await this.searchService.search(question, {
      limit: this.options.candidateDocumentLimit,
      matchesPerDocument: this.options.candidateChunksPerDocument,
    });
    const reconstructed = await this.reconstruct(results);
    return this.select(reconstructed);
  }

  private async reconstruct(
    results: readonly SemanticDocumentResult[],
  ): Promise<ReconstructedCandidate[][]> {
    const reconstructed: ReconstructedCandidate[][] = [];
    const seenCandidateIds = new Set<string>();
    const seenContent = new Set<string>();

    for (const document of orderedDocuments(results)) {
      if (!isCanonicalMarkdownPath(document.path)) continue;
      const matches = orderedMatches(document).filter((match) => {
        if (
          match.path !== document.path ||
          typeof match.id !== "string" ||
          !match.id ||
          typeof match.contentHash !== "string" ||
          !match.contentHash ||
          !Number.isFinite(match.score) ||
          seenCandidateIds.has(match.id)
        ) {
          return false;
        }
        seenCandidateIds.add(match.id);
        return true;
      });
      if (!matches.length) continue;

      let selection: Awaited<ReturnType<MarkdownDocumentSource["readPaths"]>>;
      try {
        selection = await this.source.readPaths([document.path]);
      } catch {
        continue;
      }
      const sourceDocument = selection.documents.find(
        (candidate) => candidate.path === document.path,
      );
      if (!sourceDocument || typeof sourceDocument.content !== "string") {
        continue;
      }

      let chunks: NoteChunk[];
      try {
        chunks = this.chunker.chunk({
          path: sourceDocument.path,
          content: sourceDocument.content,
          cache: sourceDocument.cache,
        });
      } catch {
        continue;
      }
      const lineCount = sourceDocument.content.split("\n").length;
      const chunksById = new Map<string, NoteChunk>();
      for (const chunk of chunks) {
        if (
          chunkIsValid(
            chunk,
            document.path,
            sourceDocument.content.length,
            lineCount,
          ) &&
          !chunksById.has(chunk.id)
        ) {
          chunksById.set(chunk.id, chunk);
        }
      }

      const documentCandidates: ReconstructedCandidate[] = [];
      for (const match of matches) {
        const chunk = chunksById.get(match.id);
        if (!chunk || chunk.contentHash !== match.contentHash) continue;
        if (seenContent.has(chunk.text)) continue;
        seenContent.add(chunk.text);
        documentCandidates.push({
          path: document.path,
          score: match.score,
          chunk,
        });
      }
      if (documentCandidates.length) reconstructed.push(documentCandidates);
    }
    return reconstructed;
  }

  private select(documents: readonly ReconstructedCandidate[][]): RagContext {
    const sources: RagSource[] = [];
    const selectedDocuments = new Set<string>();
    const selectedPerDocument = new Map<string, number>();
    let usedCodePoints = 0;

    for (
      let round = 0;
      round < this.options.maxChunksPerDocument;
      round++
    ) {
      for (const candidates of documents) {
        const candidate = candidates[round];
        if (!candidate) continue;
        const alreadySelected = selectedDocuments.has(candidate.path);
        if (
          !alreadySelected &&
          selectedDocuments.size >= this.options.maxDocuments
        ) {
          continue;
        }
        if (
          (selectedPerDocument.get(candidate.path) ?? 0) >=
          this.options.maxChunksPerDocument
        ) {
          continue;
        }
        const codePoints = Array.from(candidate.chunk.text).length;
        if (
          codePoints <= 0 ||
          usedCodePoints + codePoints > this.options.maxContextCodePoints
        ) {
          continue;
        }
        selectedDocuments.add(candidate.path);
        selectedPerDocument.set(
          candidate.path,
          (selectedPerDocument.get(candidate.path) ?? 0) + 1,
        );
        usedCodePoints += codePoints;
        sources.push(
          freezeSource({
            id: `S${sources.length + 1}`,
            path: candidate.path,
            headingPath: [...candidate.chunk.headingPath],
            chunkId: candidate.chunk.id,
            contentHash: candidate.chunk.contentHash,
            source: { ...candidate.chunk.source },
            score: candidate.score,
            text: candidate.chunk.text,
          }),
        );
      }
    }

    return Object.freeze({
      sources: Object.freeze(sources),
      usedCodePoints,
    });
  }
}

export { isCanonicalMarkdownPath, prepareOptions };
