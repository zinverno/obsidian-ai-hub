import { describe, expect, it, vi } from "vitest";
import { DescriptorQueryEmbeddingProvider, type QueryEmbeddingFetch } from "../src/mcp/queryEmbedding.js";
import { buildDescriptorEmbeddingSpaceId } from "../src/mcp/descriptor.js";
import type { SemanticDescriptor } from "../src/protocol/types.js";
import { descriptor } from "./fixtures.js";

describe("Companion query embedding provider", () => {
  function modelDescriptor(providerId: string, model: string): SemanticDescriptor {
    const value = descriptor({
      providerId,
      model,
      baseUrl: providerId === "openrouter" ? "https://openrouter.ai/api/v1" : "https://embed.example/v1",
    });
    value.embeddingSpaceId = buildDescriptorEmbeddingSpaceId(value);
    return value;
  }

  it.each([
    ["nvidia/nemotron-3-embed-1b:free", "private/openrouter/nvidia/nemotron-3-embed-1b"],
    ["nvidia/nemotron-3-embed-1b:free", "nvidia/nemotron-3-embed-1b"],
    ["nvidia/nemotron-3-embed-1b:free", "nvidia/nemotron-3-embed-1b:free"],
    ["openai/text-embedding-3-small", "openai/text-embedding-3-small"],
    ["openai/text-embedding-3-small", "private/openrouter/openai/text-embedding-3-small"],
    ["nvidia/nemotron-3-embed-1b:free", "private/openrouter/nvidia/nemotron-3-embed-1b:free"],
  ])("accepts the narrow OpenRouter model equivalence %s -> %s without changing the request", async (requested, reported) => {
    const value = modelDescriptor("openrouter", requested);
    const original = structuredClone(value);
    const performFetch = vi.fn<QueryEmbeddingFetch>(async () => new Response(JSON.stringify({
      model: reported, data: [{ index: 0, embedding: [1, 2, 3] }],
    }), { status: 200 }));
    const provider = new DescriptorQueryEmbeddingProvider({ apiKey: "provider-secret", timeoutMs: 1000, fetch: performFetch });

    expect(Array.from(await provider.embedQuery(value, "query only"))).toEqual([1, 2, 3]);
    expect(performFetch).toHaveBeenCalledTimes(1);
    expect(performFetch.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(JSON.parse(performFetch.mock.calls[0]?.[1]?.body as string)).toEqual({
      model: requested, input: ["query only"], encoding_format: "float",
    });
    expect(value).toEqual(original);
  });

  it.each([
    ["nvidia/nemotron-3-embed-1b:free", "private/openrouter/other/model"],
    ["nvidia/nemotron-3-embed-1b:free", "openai/text-embedding-3-small"],
    ["nvidia/nemotron-3-embed-1b:free", "public/openrouter/nvidia/nemotron-3-embed-1b"],
    ["nvidia/nemotron-3-embed-1b:free", "private/openrouter/private/openrouter/nvidia/nemotron-3-embed-1b"],
    ["nvidia/nemotron-3-embed-1b:free", "private/openrouter/NVIDIA/nemotron-3-embed-1b"],
    ["nvidia/nemotron-3-embed-1b:free", "private/openrouter/nvidia/nemotron-3-embed-1b:paid"],
    ["nvidia/nemotron-3-embed-1b:paid", "private/openrouter/nvidia/nemotron-3-embed-1b"],
    ["nvidia/nemotron-3-embed-1b", "private/openrouter/nvidia/nemotron-3-embed-1b:free"],
    ["nvidia/nemotron-3-embed-1b:free", "private/openrouter/nvidia/nemotron-3-embed-1b "],
  ])("rejects a different OpenRouter response model despite identical dimensions: %s -> %s", async (requested, reported) => {
    const performFetch = vi.fn<QueryEmbeddingFetch>(async () => new Response(JSON.stringify({
      model: reported, data: [{ index: 0, embedding: [1, 2, 3] }],
    }), { status: 200 }));
    const provider = new DescriptorQueryEmbeddingProvider({ apiKey: "provider-secret", timeoutMs: 1000, fetch: performFetch });
    await expect(provider.embedQuery(modelDescriptor("openrouter", requested), "query"))
      .rejects.toMatchObject({ code: "SEMANTIC_SEARCH_UNAVAILABLE" });
    expect(performFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["openai-compatible", "ollama"])("preserves exact reported-model validation for %s", async (providerId) => {
    const value = modelDescriptor(providerId, "nvidia/nemotron-3-embed-1b:free");
    for (const model of [value.model, "private/openrouter/nvidia/nemotron-3-embed-1b", "nvidia/nemotron-3-embed-1b", "other/model"]) {
      const performFetch = vi.fn<QueryEmbeddingFetch>(async () => new Response(JSON.stringify({
        model, data: [{ index: 0, embedding: [1, 2, 3] }], embeddings: [[1, 2, 3]],
      }), { status: 200 }));
      const provider = new DescriptorQueryEmbeddingProvider({ apiKey: "provider-secret", timeoutMs: 1000, fetch: performFetch });
      const result = provider.embedQuery(value, "query");
      if (model === value.model) expect(Array.from(await result)).toEqual([1, 2, 3]);
      else await expect(result).rejects.toMatchObject({ code: "SEMANTIC_SEARCH_UNAVAILABLE" });
      expect(performFetch).toHaveBeenCalledTimes(1);
    }
  });

  it.each([null, 42, {}, ["nvidia/nemotron-3-embed-1b"]])("rejects a non-string OpenRouter response model: %j", async (model) => {
    const provider = new DescriptorQueryEmbeddingProvider({
      apiKey: "provider-secret", timeoutMs: 1000,
      fetch: async (): Promise<Response> => new Response(JSON.stringify({ model, data: [{ index: 0, embedding: [1, 2, 3] }] }), { status: 200 }),
    });
    await expect(provider.embedQuery(modelDescriptor("openrouter", "nvidia/nemotron-3-embed-1b:free"), "query"))
      .rejects.toMatchObject({ code: "SEMANTIC_SEARCH_UNAVAILABLE" });
  });

  it("makes exactly one OpenAI-compatible request using the stored model and endpoint", async () => {
    const performFetch = vi.fn<QueryEmbeddingFetch>(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1, 2, 3] }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = new DescriptorQueryEmbeddingProvider({ apiKey: "provider-secret", timeoutMs: 1000, fetch: performFetch });
    expect(Array.from(await provider.embedQuery(descriptor(), "private query"))).toEqual([1, 2, 3]);
    expect(performFetch).toHaveBeenCalledTimes(1);
    expect(performFetch.mock.calls[0]?.[0]).toBe("https://embed.example/v1/embeddings");
    const init = performFetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      model: "text-embedding-test",
      input: ["private query"],
      encoding_format: "float",
    });
  });

  it("supports Ollama without an API key", async () => {
    const performFetch = vi.fn<QueryEmbeddingFetch>(async () => new Response(JSON.stringify({ embeddings: [[0, 1, 0]] }), { status: 200 }));
    const provider = new DescriptorQueryEmbeddingProvider({ apiKey: "", timeoutMs: 1000, fetch: performFetch });
    const value = descriptor({
      providerId: "ollama",
      model: "embeddinggemma",
      baseUrl: "http://localhost:11434",
      embeddingSpaceId: "embedding-space:v1|provider=ollama|model=embeddinggemma|endpoint=http%3A%2F%2Flocalhost%3A11434|dimensions=3",
    });
    expect(Array.from(await provider.embedQuery(value, "query"))).toEqual([0, 1, 0]);
    expect(performFetch.mock.calls[0]?.[0]).toBe("http://localhost:11434/api/embed");
    expect((performFetch.mock.calls[0]?.[1] as RequestInit).headers).not.toHaveProperty("authorization");
  });

  it("returns one clean unavailable error for missing credentials and malformed responses", async () => {
    const unavailable = new DescriptorQueryEmbeddingProvider({ apiKey: "", timeoutMs: 1000, fetch: vi.fn() });
    await expect(unavailable.embedQuery(descriptor({
      providerId: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
    }), "query")).rejects.toMatchObject({ code: "SEMANTIC_SEARCH_UNAVAILABLE" });

    const malformed = new DescriptorQueryEmbeddingProvider({
      apiKey: "",
      timeoutMs: 1000,
      fetch: async (): Promise<Response> => new Response(JSON.stringify({ data: [{ embedding: [1, "bad", 3] }] }), { status: 200 }),
    });
    await expect(malformed.embedQuery(descriptor(), "query")).rejects.toMatchObject({ code: "SEMANTIC_SEARCH_UNAVAILABLE" });
  });

  it("aborts provider requests at the configured timeout", async () => {
    const performFetch = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    const provider = new DescriptorQueryEmbeddingProvider({ apiKey: "", timeoutMs: 5, fetch: performFetch });
    await expect(provider.embedQuery(descriptor(), "query")).rejects.toMatchObject({ code: "SEMANTIC_SEARCH_UNAVAILABLE" });
  });
});
