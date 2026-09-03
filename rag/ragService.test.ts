import { describe, expect, it, vi } from "vitest";
import {
  RagGenerationError,
  RagInsufficientContextError,
  RagValidationError,
} from "./errors";
import {
  MAX_RAG_QUESTION_CODE_POINTS,
  parseRagCitations,
  RagService,
} from "./ragService";
import type { RagContext, RagGenerationRequest } from "./types";

function context(): RagContext {
  return Object.freeze({
    usedCodePoints: 5,
    sources: Object.freeze([
      Object.freeze({
        id: "S1",
        path: "A.md",
        headingPath: Object.freeze(["A"]),
        chunkId: "a",
        contentHash: "hash-a",
        source: Object.freeze({
          startOffset: 0,
          endOffset: 5,
          startLine: 0,
          endLine: 0,
        }),
        score: 1,
        text: "alpha",
      }),
      Object.freeze({
        id: "S2",
        path: "B.md",
        headingPath: Object.freeze(["B"]),
        chunkId: "b",
        contentHash: "hash-b",
        source: Object.freeze({
          startOffset: 0,
          endOffset: 4,
          startLine: 0,
          endLine: 0,
        }),
        score: 0.9,
        text: "beta",
      }),
    ]),
  });
}

function generator(answer = "Answer [S1]") {
  return vi.fn(async ({ onToken }: RagGenerationRequest) => {
    onToken(answer);
  });
}

describe("RagService", () => {
  it.each(["", "  ", "bad\0question"])(
    "rejects invalid question %j before retrieval",
    async (question) => {
      const load = vi.fn(async () => context());
      const service = new RagService(load);
      await expect(service.ask(question, { generate: generator() }))
        .rejects.toBeInstanceOf(RagValidationError);
      expect(load).not.toHaveBeenCalled();
    },
  );

  it("rejects an oversized Unicode question before retrieval", async () => {
    const load = vi.fn(async () => context());
    const service = new RagService(load);
    await expect(service.ask(
      "😀".repeat(MAX_RAG_QUESTION_CODE_POINTS + 1),
      { generate: generator() },
    )).rejects.toBeInstanceOf(RagValidationError);
    expect(load).not.toHaveBeenCalled();
  });

  it("retrieves exactly once and forwards streamed tokens incrementally", async () => {
    const load = vi.fn(async () => context());
    const generate = vi.fn(async ({ onToken }: RagGenerationRequest) => {
      onToken("one ");
      onToken("two [S2]");
    });
    const tokens: string[] = [];
    const service = new RagService(load);

    const result = await service.ask("  question  ", {
      generate,
      onToken: (token) => tokens.push(token),
    });

    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith("question");
    expect(tokens).toEqual(["one ", "two [S2]"]);
    expect(result.answer).toBe("one two [S2]");
    expect(result.citedSourceIds).toEqual(["S2"]);
  });

  it("does not call the LLM when no valid reconstructed context remains", async () => {
    const generate = generator();
    const service = new RagService(async () => ({
      sources: [],
      usedCodePoints: 0,
    }));

    await expect(service.ask("question", { generate }))
      .rejects.toBeInstanceOf(RagInsufficientContextError);
    expect(generate).not.toHaveBeenCalled();
  });

  it("freezes context loading before generation starts", async () => {
    const events: string[] = [];
    const frozen = context();
    const service = new RagService(async () => {
      events.push("context");
      return frozen;
    });

    await service.ask("question", {
      onContext: (received) => {
        events.push("on-context");
        expect(received).toBe(frozen);
      },
      generate: async ({ onToken }) => {
        events.push("generate");
        onToken("answer");
      },
    });

    expect(events).toEqual(["context", "on-context", "generate"]);
  });

  it("forwards the external AbortSignal to generation", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const service = new RagService(async () => context());

    const pending = service.ask("question", {
      signal: controller.signal,
      generate: async ({ signal }) => {
        observed = signal;
        controller.abort();
        const error = new Error("cancelled");
        error.name = "AbortError";
        throw error;
      },
    });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(observed).toBe(controller.signal);
  });

  it("does not forward late tokens after external abort", async () => {
    const controller = new AbortController();
    const tokens: string[] = [];
    const service = new RagService(async () => context());

    await expect(service.ask("question", {
      signal: controller.signal,
      onToken: (token) => tokens.push(token),
      generate: async ({ onToken }) => {
        onToken("before");
        controller.abort();
        onToken("after");
      },
    })).rejects.toMatchObject({ name: "AbortError" });

    expect(tokens).toEqual(["before"]);
  });

  it("normalizes provider failures without exposing their details", async () => {
    const service = new RagService(async () => context());
    let caught: unknown;
    try {
      await service.ask("question", {
        generate: async () => {
          throw new Error("Bearer sk-private provider response");
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RagGenerationError);
    expect(String(caught)).not.toContain("sk-private");
    expect(String(caught)).not.toContain("provider response");
  });

  it("preserves timeout classification for local UI handling", async () => {
    const service = new RagService(async () => context());
    const timeout = new Error("safe timeout");
    timeout.name = "TimeoutError";
    await expect(service.ask("question", {
      generate: async () => {
        throw timeout;
      },
    })).rejects.toBe(timeout);
  });

  it("rejects a malformed empty model response", async () => {
    const service = new RagService(async () => context());
    await expect(service.ask("question", {
      generate: async () => undefined,
    })).rejects.toBeInstanceOf(RagGenerationError);
  });

  it("validates citations against the code-owned source mapping", async () => {
    const service = new RagService(async () => context());
    const result = await service.ask("question", {
      generate: generator("Supported [S1], repeated [S1], unknown [S999]."),
    });

    expect(result.citedSourceIds).toEqual(["S1"]);
    expect(result.unknownCitationIds).toEqual(["S999"]);
    expect(result.context.sources.map((source) => source.path)).toEqual([
      "A.md",
      "B.md",
    ]);
  });

  it("never creates a trusted source from an unknown model citation", () => {
    expect(parseRagCitations("[S999] [S2]", context())).toEqual({
      citedSourceIds: ["S2"],
      unknownCitationIds: ["S999"],
    });
  });
});
