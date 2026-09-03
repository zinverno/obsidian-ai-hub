import {
  RagGenerationError,
  RagInsufficientContextError,
  RagValidationError,
} from "./errors";
import { buildRagPrompt } from "./ragPrompt";
import type {
  RagAskOptions,
  RagAskResult,
  RagContext,
} from "./types";

export const MAX_RAG_QUESTION_CODE_POINTS = 2000;

export type RagContextLoader = (question: string) => Promise<RagContext>;

function normalizeQuestion(value: unknown): string {
  if (typeof value !== "string") {
    throw new RagValidationError("Vault question must be a string.");
  }
  const question = value.trim();
  if (!question) {
    throw new RagValidationError("Vault question must not be empty.");
  }
  if (question.includes("\0")) {
    throw new RagValidationError("Vault question must not contain NUL.");
  }
  if (Array.from(question).length > MAX_RAG_QUESTION_CODE_POINTS) {
    throw new RagValidationError(
      `Vault question must not exceed ${MAX_RAG_QUESTION_CODE_POINTS} Unicode code points.`,
    );
  }
  return question;
}

function abortError(): Error {
  const error = new Error("Vault question was cancelled.");
  error.name = "AbortError";
  return error;
}

function isCancellation(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

export function parseRagCitations(
  answer: string,
  context: RagContext,
): { citedSourceIds: string[]; unknownCitationIds: string[] } {
  const trusted = new Set(context.sources.map((source) => source.id));
  const citedSourceIds: string[] = [];
  const unknownCitationIds: string[] = [];
  const seen = new Set<string>();
  for (const match of answer.matchAll(/\[(S\d+)\]/g)) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    if (trusted.has(id)) citedSourceIds.push(id);
    else unknownCitationIds.push(id);
  }
  return { citedSourceIds, unknownCitationIds };
}

export class RagService {
  constructor(private readonly loadContext: RagContextLoader) {
    if (typeof loadContext !== "function") {
      throw new RagValidationError("A RAG context loader is required.");
    }
  }

  async ask(rawQuestion: string, options: RagAskOptions): Promise<RagAskResult> {
    const question = normalizeQuestion(rawQuestion);
    if (!options || typeof options.generate !== "function") {
      throw new RagValidationError("A RAG generator is required.");
    }
    if (options.signal?.aborted) throw abortError();

    const context = await this.loadContext(question);
    if (options.signal?.aborted) throw abortError();
    if (!context.sources.length) throw new RagInsufficientContextError();

    options.onContext?.(context);
    const prompt = buildRagPrompt(question, context);
    let answer = "";
    try {
      await options.generate({
        ...prompt,
        signal: options.signal,
        onToken: (token) => {
          if (options.signal?.aborted) return;
          answer += token;
          options.onToken?.(token);
        },
      });
    } catch (error) {
      if (isCancellation(error)) throw error;
      throw new RagGenerationError(undefined, error);
    }
    if (options.signal?.aborted) throw abortError();
    if (!answer.trim()) {
      throw new RagGenerationError("Language model returned an empty answer.");
    }

    const citations = parseRagCitations(answer, context);
    return Object.freeze({
      answer,
      context,
      citedSourceIds: Object.freeze(citations.citedSourceIds),
      unknownCitationIds: Object.freeze(citations.unknownCitationIds),
    });
  }
}
