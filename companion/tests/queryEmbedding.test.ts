import { describe, expect, it, vi } from "vitest";
import { DescriptorQueryEmbeddingProvider, type QueryEmbeddingFetch } from "../src/mcp/queryEmbedding.js";
import { descriptor } from "./fixtures.js";

describe("Companion query embedding provider", () => {
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
