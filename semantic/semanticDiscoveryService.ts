import type {
  VectorChunkMetadata,
  VectorStore,
  VectorStoreSnapshot,
} from "../vectorStore/types";
import {
  SemanticSourceNotIndexedError,
  SemanticValidationError,
} from "./errors";
import type {
  SemanticChunkMatch,
  SemanticDocumentSimilarity,
  SemanticDuplicateOptions,
  SemanticDuplicatePair,
  SemanticSimilarNotesOptions,
} from "./types";

export const DEFAULT_SIMILAR_NOTES_LIMIT = 10;
export const DEFAULT_DUPLICATE_PAIR_LIMIT = 100;
export const DEFAULT_DUPLICATE_THRESHOLD = 0.95;
export const MIN_DOCUMENT_MEANINGFUL_CHARACTERS = 32;
/**
 * Unit Float32 chunks can retain aggregate cancellation noise around a few
 * 1e-6 in hundreds of dimensions. Keeping the mean resultant length above
 * 1e-5 rejects numerically ill-conditioned directions while remaining far
 * below the coherence of a meaningfully aligned document.
 */
export const MIN_DOCUMENT_COHERENCE = 1e-5;

const DEFAULT_MATCHES_PER_DOCUMENT = 3;
const MAX_RESULT_LIMIT = 500;
const MAX_MATCHES_PER_DOCUMENT = 10;
const MEANINGFUL_CHARACTER = /[\p{L}\p{N}]/u;

interface PreparedOptions {
  limit: number;
  matchesPerDocument: number;
}

interface PreparedDocument {
  path: string;
  rows: number[];
  vector: Float64Array | null;
  meaningfulCharacters: number;
}

interface PreparedSnapshot {
  snapshot: VectorStoreSnapshot;
  documents: PreparedDocument[];
}

interface DuplicateCandidate {
  left: PreparedDocument;
  right: PreparedDocument;
  score: number;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDuplicateCandidateParts(
  leftScore: number,
  leftLeftPath: string,
  leftRightPath: string,
  rightScore: number,
  rightLeftPath: string,
  rightRightPath: string,
): number {
  return (
    rightScore - leftScore ||
    compareStrings(leftLeftPath, rightLeftPath) ||
    compareStrings(leftRightPath, rightRightPath)
  );
}

function compareDuplicateCandidates(
  left: DuplicateCandidate,
  right: DuplicateCandidate,
): number {
  return compareDuplicateCandidateParts(
    left.score,
    left.left.path,
    left.right.path,
    right.score,
    right.left.path,
    right.right.path,
  );
}

/** Maintains a worst-candidate-first heap with at most `limit` entries. */
function offerDuplicateCandidate(
  heap: DuplicateCandidate[],
  left: PreparedDocument,
  right: PreparedDocument,
  score: number,
  limit: number,
): void {
  if (heap.length < limit) {
    heap.push({ left, right, score });
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (compareDuplicateCandidates(heap[index], heap[parent]) <= 0) break;
      [heap[index], heap[parent]] = [heap[parent], heap[index]];
      index = parent;
    }
    return;
  }

  const worst = heap[0];
  if (
    compareDuplicateCandidateParts(
      score,
      left.path,
      right.path,
      worst.score,
      worst.left.path,
      worst.right.path,
    ) >= 0
  ) {
    return;
  }

  heap[0] = { left, right, score };
  let index = 0;
  while (true) {
    const leftChild = index * 2 + 1;
    if (leftChild >= heap.length) return;
    const rightChild = leftChild + 1;
    let worseChild = leftChild;
    if (
      rightChild < heap.length &&
      compareDuplicateCandidates(heap[rightChild], heap[leftChild]) > 0
    ) {
      worseChild = rightChild;
    }
    if (compareDuplicateCandidates(heap[worseChild], heap[index]) <= 0) return;
    [heap[index], heap[worseChild]] = [heap[worseChild], heap[index]];
    index = worseChild;
  }
}

function positiveSafeInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw new SemanticValidationError(
      `${label} must be a positive safe integer not greater than ${maximum}.`,
    );
  }
  return value;
}

function validatePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.includes("\\")
  ) {
    throw new SemanticValidationError(
      "Source path must be a canonical vault-relative path.",
    );
  }
  if (
    value
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new SemanticValidationError(
      "Source path must be a canonical vault-relative path.",
    );
  }
  return value;
}

function prepareOptions(
  raw: SemanticSimilarNotesOptions | SemanticDuplicateOptions | undefined,
  defaultLimit: number,
): PreparedOptions {
  if (
    raw !== undefined &&
    (typeof raw !== "object" || raw === null || Array.isArray(raw))
  ) {
    throw new SemanticValidationError("Discovery options must be an object.");
  }
  return {
    limit: positiveSafeInteger(
      raw?.limit ?? defaultLimit,
      "Discovery limit",
      MAX_RESULT_LIMIT,
    ),
    matchesPerDocument: positiveSafeInteger(
      raw?.matchesPerDocument ?? DEFAULT_MATCHES_PER_DOCUMENT,
      "matchesPerDocument",
      MAX_MATCHES_PER_DOCUMENT,
    ),
  };
}

function stableNorm(vector: Float64Array): number {
  let scale = 0;
  let sum = 1;
  for (let index = 0; index < vector.length; index++) {
    const absolute = Math.abs(vector[index]);
    if (absolute === 0) continue;
    if (scale < absolute) {
      const ratio = scale / absolute;
      sum = 1 + sum * ratio * ratio;
      scale = absolute;
    } else {
      const ratio = absolute / scale;
      sum += ratio * ratio;
    }
  }
  return scale === 0 ? 0 : scale * Math.sqrt(sum);
}

function meaningfulCharacterCount(previews: ReadonlySet<string>): number {
  let count = 0;
  for (const preview of previews) {
    for (const character of preview) {
      if (MEANINGFUL_CHARACTER.test(character)) count++;
    }
  }
  return count;
}

function normalizedMean(
  rows: readonly number[],
  vectors: Float32Array,
  dimensions: number,
): Float64Array | null {
  if (rows.length === 0) return null;
  const mean = new Float64Array(dimensions);
  for (const row of rows) {
    const start = row * dimensions;
    for (let column = 0; column < dimensions; column++) {
      const value = vectors[start + column];
      if (!Number.isFinite(value)) {
        throw new SemanticValidationError(
          "Vector snapshot contains a non-finite component.",
        );
      }
      mean[column] += value;
    }
  }
  const norm = stableNorm(mean);
  const coherence = norm / rows.length;
  if (
    !Number.isFinite(norm) ||
    !Number.isFinite(coherence) ||
    coherence <= MIN_DOCUMENT_COHERENCE
  ) {
    return null;
  }
  for (let column = 0; column < dimensions; column++) {
    mean[column] /= norm;
  }
  return mean;
}

function cosine(
  left: Float64Array,
  right: Float64Array | Float32Array,
  rightOffset = 0,
): number {
  let score = 0;
  for (let index = 0; index < left.length; index++) {
    score += left[index] * right[rightOffset + index];
  }
  if (!Number.isFinite(score)) {
    throw new SemanticValidationError(
      "Document similarity produced a non-finite score.",
    );
  }
  const clamped = Math.max(-1, Math.min(1, score));
  return Object.is(clamped, -0) ? 0 : clamped;
}

function copyMatch(
  metadata: VectorChunkMetadata,
  score: number,
): SemanticChunkMatch {
  const match: SemanticChunkMatch = {
    id: metadata.id,
    path: metadata.path,
    headingPath: [...metadata.headingPath],
    ordinal: metadata.ordinal,
    source: { ...metadata.source },
    score,
  };
  if (metadata.preview !== undefined) match.preview = metadata.preview;
  return match;
}

export class SemanticDiscoveryService {
  constructor(
    private readonly vectorStore: VectorStore,
    private readonly dimensions: number,
    private readonly duplicateThreshold = DEFAULT_DUPLICATE_THRESHOLD,
  ) {
    if (!vectorStore || typeof vectorStore.readSnapshot !== "function") {
      throw new SemanticValidationError(
        "A snapshot-capable vector store is required.",
      );
    }
    positiveSafeInteger(dimensions, "Dimensions", 0xffff_ffff);
    if (
      typeof duplicateThreshold !== "number" ||
      !Number.isFinite(duplicateThreshold) ||
      duplicateThreshold < -1 ||
      duplicateThreshold > 1
    ) {
      throw new SemanticValidationError(
        "Duplicate threshold must be finite and between -1 and 1.",
      );
    }
  }

  findSimilarNotes(
    rawSourcePath: string,
    rawOptions?: SemanticSimilarNotesOptions,
  ): SemanticDocumentSimilarity[] {
    const sourcePath = validatePath(rawSourcePath);
    const options = prepareOptions(rawOptions, DEFAULT_SIMILAR_NOTES_LIMIT);
    const prepared = this.prepareSnapshot();
    if (prepared.documents.length === 0) return [];
    const source = prepared.documents.find(
      (document) => document.path === sourcePath,
    );
    if (!source) throw new SemanticSourceNotIndexedError();
    if (!this.eligible(source)) return [];

    return prepared.documents
      .filter(
        (document) =>
          document.path !== sourcePath && this.eligible(document),
      )
      .map((document) => ({
        path: document.path,
        score: cosine(source.vector as Float64Array, document.vector as Float64Array),
        matches: this.bestMatches(
          source.vector as Float64Array,
          document,
          prepared.snapshot,
          options.matchesPerDocument,
        ),
      }))
      .sort(
        (left, right) =>
          right.score - left.score || compareStrings(left.path, right.path),
      )
      .slice(0, options.limit);
  }

  findPotentialDuplicates(
    rawOptions?: SemanticDuplicateOptions,
  ): SemanticDuplicatePair[] {
    const options = prepareOptions(rawOptions, DEFAULT_DUPLICATE_PAIR_LIMIT);
    const prepared = this.prepareSnapshot();
    const documents = prepared.documents.filter((document) =>
      this.eligible(document),
    );
    const topCandidates: DuplicateCandidate[] = [];

    for (let leftIndex = 0; leftIndex < documents.length; leftIndex++) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < documents.length;
        rightIndex++
      ) {
        const left = documents[leftIndex];
        const right = documents[rightIndex];
        const score = cosine(
          left.vector as Float64Array,
          right.vector as Float64Array,
        );
        if (score >= this.duplicateThreshold) {
          offerDuplicateCandidate(
            topCandidates,
            left,
            right,
            score,
            options.limit,
          );
        }
      }
    }

    return topCandidates
      .sort(compareDuplicateCandidates)
      .map(({ left, right, score }) => ({
        leftPath: left.path,
        rightPath: right.path,
        score,
        leftMatches: this.bestMatches(
          right.vector as Float64Array,
          left,
          prepared.snapshot,
          options.matchesPerDocument,
        ),
        rightMatches: this.bestMatches(
          left.vector as Float64Array,
          right,
          prepared.snapshot,
          options.matchesPerDocument,
        ),
      }));
  }

  private prepareSnapshot(): PreparedSnapshot {
    const snapshot = this.vectorStore.readSnapshot();
    if (
      !snapshot ||
      !Number.isSafeInteger(snapshot.generation) ||
      snapshot.generation < 0 ||
      snapshot.dimensions !== this.dimensions ||
      !Array.isArray(snapshot.metadata) ||
      !(snapshot.vectors instanceof Float32Array) ||
      snapshot.vectors.length !== snapshot.metadata.length * this.dimensions
    ) {
      throw new SemanticValidationError(
        "Vector store returned an invalid discovery snapshot.",
      );
    }

    const grouped = new Map<string, number[]>();
    for (let row = 0; row < snapshot.metadata.length; row++) {
      const metadata = snapshot.metadata[row];
      const rows = grouped.get(metadata.path) ?? [];
      rows.push(row);
      grouped.set(metadata.path, rows);
    }

    const documents = [...grouped.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([path, rows]) => {
        rows.sort((left, right) => {
          const leftMetadata = snapshot.metadata[left];
          const rightMetadata = snapshot.metadata[right];
          return (
            leftMetadata.ordinal - rightMetadata.ordinal ||
            compareStrings(leftMetadata.id, rightMetadata.id)
          );
        });
        const previews = new Set<string>();
        for (const row of rows) {
          const preview = snapshot.metadata[row].preview;
          if (preview) previews.add(preview);
        }
        return {
          path,
          rows,
          vector: normalizedMean(rows, snapshot.vectors, this.dimensions),
          meaningfulCharacters: meaningfulCharacterCount(previews),
        };
      });
    return { snapshot, documents };
  }

  private eligible(document: PreparedDocument): boolean {
    return (
      document.vector !== null &&
      document.meaningfulCharacters >= MIN_DOCUMENT_MEANINGFUL_CHARACTERS
    );
  }

  private bestMatches(
    query: Float64Array,
    document: PreparedDocument,
    snapshot: VectorStoreSnapshot,
    limit: number,
  ): SemanticChunkMatch[] {
    return document.rows
      .map((row) => ({
        metadata: snapshot.metadata[row],
        score: cosine(
          query,
          snapshot.vectors,
          row * this.dimensions,
        ),
      }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          compareStrings(left.metadata.id, right.metadata.id),
      )
      .slice(0, limit)
      .map(({ metadata, score }) => copyMatch(metadata, score));
  }
}
