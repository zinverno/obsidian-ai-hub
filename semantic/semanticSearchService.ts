import type { EmbeddingProvider } from "../embeddings/types";
import type {
  VectorSearchResult,
  VectorStore,
} from "../vectorStore/types";
import {
  SemanticProviderError,
  SemanticValidationError,
} from "./errors";
import type {
  SemanticChunkMatch,
  SemanticDocumentResult,
  SemanticSearchOptions,
} from "./types";

const DEFAULT_DOCUMENT_LIMIT = 10;
const MAX_DOCUMENT_LIMIT = 100;
const DEFAULT_MATCHES_PER_DOCUMENT = 3;
const MAX_QUERY_CODE_POINTS = 2000;
const MIN_VECTOR_NORM = 1e-12;

interface PreparedSearchOptions {
  limit: number;
  minScore?: number;
  matchesPerDocument: number;
  excludePaths: string[];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function positiveSafeInteger(
  value: unknown,
  label: string,
  maximum?: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    (maximum !== undefined && value > maximum)
  ) {
    throw new SemanticValidationError(
      `${label} must be a positive safe integer${
        maximum === undefined ? "." : ` not greater than ${maximum}.`
      }`,
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
      "Excluded paths must be canonical vault-relative paths.",
    );
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new SemanticValidationError(
      "Excluded paths must be canonical vault-relative paths.",
    );
  }
  return value;
}

function prepareOptions(
  options: SemanticSearchOptions | undefined,
): PreparedSearchOptions {
  if (
    options !== undefined &&
    (typeof options !== "object" || options === null || Array.isArray(options))
  ) {
    throw new SemanticValidationError("Search options must be an object.");
  }
  const limit = positiveSafeInteger(
    options?.limit ?? DEFAULT_DOCUMENT_LIMIT,
    "Search limit",
    MAX_DOCUMENT_LIMIT,
  );
  const matchesPerDocument = positiveSafeInteger(
    options?.matchesPerDocument ?? DEFAULT_MATCHES_PER_DOCUMENT,
    "matchesPerDocument",
    MAX_DOCUMENT_LIMIT,
  );
  if (
    options?.minScore !== undefined &&
    (typeof options.minScore !== "number" ||
      !Number.isFinite(options.minScore))
  ) {
    throw new SemanticValidationError("minScore must be finite.");
  }
  if (
    options?.excludePaths !== undefined &&
    !Array.isArray(options.excludePaths)
  ) {
    throw new SemanticValidationError("excludePaths must be an array.");
  }
  const excludePaths = (options?.excludePaths ?? []).map(validatePath);
  return {
    limit,
    matchesPerDocument,
    minScore: options?.minScore,
    excludePaths,
  };
}

function normalizedQuery(value: unknown): string {
  if (typeof value !== "string") {
    throw new SemanticValidationError("Semantic query must be a string.");
  }
  const query = value.trim();
  if (!query) {
    throw new SemanticValidationError("Semantic query must not be empty.");
  }
  if (query.includes("\0")) {
    throw new SemanticValidationError("Semantic query must not contain NUL.");
  }
  if (Array.from(query).length > MAX_QUERY_CODE_POINTS) {
    throw new SemanticValidationError(
      `Semantic query must not exceed ${MAX_QUERY_CODE_POINTS} Unicode code points.`,
    );
  }
  return query;
}

function stableNorm(vector: Float32Array): number {
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

function copyMatch(result: VectorSearchResult): SemanticChunkMatch {
  const match: SemanticChunkMatch = {
    id: result.id,
    path: result.path,
    headingPath: [...result.headingPath],
    ordinal: result.ordinal,
    source: { ...result.source },
    score: result.score,
  };
  if (result.preview !== undefined) match.preview = result.preview;
  return match;
}

function groupResults(
  results: readonly VectorSearchResult[],
  options: PreparedSearchOptions,
): SemanticDocumentResult[] {
  const grouped = new Map<string, SemanticDocumentResult>();
  for (const result of results) {
    let document = grouped.get(result.path);
    if (!document) {
      document = { path: result.path, score: result.score, matches: [] };
      grouped.set(result.path, document);
    }
    if (result.score > document.score) document.score = result.score;
    if (document.matches.length < options.matchesPerDocument) {
      document.matches.push(copyMatch(result));
    }
  }

  return [...grouped.values()]
    .sort(
      (left, right) =>
        right.score - left.score || compareStrings(left.path, right.path),
    )
    .slice(0, options.limit)
    .map((document) => ({
      path: document.path,
      score: document.score,
      matches: document.matches.map((match) => ({
        ...match,
        headingPath: [...match.headingPath],
        source: { ...match.source },
      })),
    }));
}

export class SemanticSearchService {
  private readonly provider: EmbeddingProvider;
  private readonly vectorStore: VectorStore;
  private readonly dimensions: number;

  constructor(
    provider: EmbeddingProvider,
    vectorStore: VectorStore,
    dimensions: number,
  ) {
    if (
      !provider ||
      typeof provider.embed !== "function" ||
      typeof provider.dimensions !== "function" ||
      typeof provider.id !== "string" ||
      typeof provider.model !== "string" ||
      provider.model.trim().length === 0
    ) {
      throw new SemanticValidationError(
        "A valid embedding provider is required.",
      );
    }
    if (
      !vectorStore ||
      typeof vectorStore.search !== "function" ||
      typeof vectorStore.getStats !== "function"
    ) {
      throw new SemanticValidationError("A valid vector store is required.");
    }
    this.dimensions = positiveSafeInteger(dimensions, "Dimensions");
    this.provider = provider;
    this.vectorStore = vectorStore;
  }

  async search(
    rawQuery: string,
    rawOptions?: SemanticSearchOptions,
  ): Promise<SemanticDocumentResult[]> {
    const query = normalizedQuery(rawQuery);
    const options = prepareOptions(rawOptions);
    const vectorCount = this.vectorStore.getStats().count;
    if (!Number.isSafeInteger(vectorCount) || vectorCount < 0) {
      throw new SemanticValidationError(
        "Vector store returned invalid statistics.",
      );
    }
    if (vectorCount === 0) return [];

    let output: unknown;
    try {
      output = await this.provider.embed([query]);
    } catch {
      throw new SemanticProviderError();
    }
    if (!Array.isArray(output) || output.length !== 1) {
      throw new SemanticProviderError();
    }
    const rawVector = output[0];
    if (
      !(rawVector instanceof Float32Array) ||
      rawVector.length !== this.dimensions
    ) {
      throw new SemanticProviderError();
    }
    const vector = new Float32Array(rawVector);
    for (let index = 0; index < vector.length; index++) {
      if (!Number.isFinite(vector[index])) throw new SemanticProviderError();
    }
    const norm = stableNorm(vector);
    if (!Number.isFinite(norm) || norm <= MIN_VECTOR_NORM) {
      throw new SemanticProviderError();
    }

    const matches = await this.vectorStore.search(vector, {
      limit: vectorCount,
      minScore: options.minScore,
      excludePaths: options.excludePaths,
    });
    return groupResults(matches, options);
  }
}

export {
  DEFAULT_DOCUMENT_LIMIT,
  DEFAULT_MATCHES_PER_DOCUMENT,
  MAX_DOCUMENT_LIMIT,
  MAX_QUERY_CODE_POINTS,
  groupResults,
};
