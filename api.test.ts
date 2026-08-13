import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";

const obsidianMocks = vi.hoisted(() => ({
  requestUrl: vi.fn<
    (request: RequestUrlParam) => Promise<RequestUrlResponse>
  >(),
}));

vi.mock("obsidian", () => ({
  getLanguage: () => "ru",
  requestUrl: obsidianMocks.requestUrl,
}));

import {
  callOpenRouter,
  fetchOllamaModels,
  fetchOpenRouterFreeModels,
  streamOpenRouter,
} from "./api";
import { STREAM_TIMEOUT_MS } from "./constants";
import type { AIHubSettings } from "./settings";

function settings(overrides: Partial<AIHubSettings> = {}): AIHubSettings {
  return {
    provider: "openrouter",
    apiKey: "sk-test",
    model: "model-a",
    baseUrl: "https://example.test/v1",
    temperature: 0.5,
    topK: 12,
    defaultInsertion: "end",
    newNoteFolder: "",
    filenameTemplate: "AI-{{date}}-{{topic}}",
    mocFolder: "MOCs/",
    atomsLocation: "same",
    atomsFolder: "Atoms/",
    showContextMenu: true,
    notifyOnCopy: true,
    language: "auto",
    deepAudit: { batchSize: 5, maxConcurrent: 3, delayMs: 1000 },
    semantic: {
      enabled: false,
      embeddingProvider: "openai-compatible",
      embeddingModel: "embedding-model",
      embeddingBaseUrl: "https://example.test/v1",
      openRouterApiKey: "",
      openAICompatibleApiKey: "",
    },
    semanticAutoSyncSuspended: false,
    ...overrides,
  };
}

function response(status: number, text: string): RequestUrlResponse {
  return {
    status,
    headers: {},
    arrayBuffer: new ArrayBuffer(0),
    json: null,
    text,
  };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("Expected the promise to reject with an Error.");
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

function createControlledStream() {
  let streamController:
    | ReadableStreamDefaultController<Uint8Array>
    | undefined;
  const cancel = vi.fn<() => void>();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    cancel() {
      cancel();
    },
  });
  return {
    body,
    cancel,
    controller(): ReadableStreamDefaultController<Uint8Array> {
      if (!streamController) throw new Error("Stream controller is not ready.");
      return streamController;
    },
  };
}

const encoder = new TextEncoder();

function sseToken(content: string): Uint8Array {
  return encoder.encode(
    `data: ${JSON.stringify({
      choices: [{ delta: { content } }],
    })}\n`,
  );
}

describe("API request boundaries", () => {
  beforeEach(() => {
    obsidianMocks.requestUrl.mockReset();
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void, delayMs: number) =>
        setTimeout(callback, delayMs) as unknown as number,
      clearTimeout: (timer: number) => clearTimeout(timer),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses requestUrl for buffered chat completions", async () => {
    obsidianMocks.requestUrl.mockResolvedValueOnce(
      response(200, JSON.stringify({
        choices: [{ message: { content: "safe answer" } }],
      })),
    );

    await expect(callOpenRouter(settings(), "system", "user"))
      .resolves.toBe("safe answer");
    expect(obsidianMocks.requestUrl).toHaveBeenCalledOnce();
    const request = obsidianMocks.requestUrl.mock.calls[0][0];
    expect(request).toMatchObject({
      url: "https://example.test/v1/chat/completions",
      method: "POST",
      contentType: "application/json",
      throw: false,
    });
  });

  it("rejects malformed buffered JSON at the trust boundary", async () => {
    obsidianMocks.requestUrl.mockResolvedValueOnce(
      response(200, "provider-secret-invalid-json"),
    );

    const error = await rejection(
      callOpenRouter(settings(), "system", "user"),
    );
    expect(error.message).toContain("JSON");
    expect(error.message).not.toContain("provider-secret");
  });

  it.each([
    ["null", "null"],
    ["array", "[]"],
    [
      "unexpected object",
      JSON.stringify({ unexpected: "provider-secret" }),
    ],
    ["non-array choices", JSON.stringify({ choices: "not-array" })],
    ["empty choice", JSON.stringify({ choices: [{}] })],
    [
      "non-string content",
      JSON.stringify({ choices: [{ message: { content: 123 } }] }),
    ],
  ])("rejects structurally invalid buffered JSON: %s", async (_name, payload) => {
    obsidianMocks.requestUrl.mockResolvedValueOnce(response(200, payload));

    const error = await rejection(
      callOpenRouter(settings(), "system", "user"),
    );
    expect(error.message).toContain("неверного формата");
    expect(error.message).not.toContain("provider-secret");
    expect(error.message).not.toContain(payload);
  });

  it("redacts provider bodies from buffered HTTP errors", async () => {
    obsidianMocks.requestUrl.mockResolvedValueOnce(
      response(401, "api-key=sk-private provider-body"),
    );

    const error = await rejection(
      callOpenRouter(settings(), "system", "user"),
    );
    expect(error.message).toContain("401");
    expect(error.message).not.toContain("sk-private");
    expect(error.message).not.toContain("provider-body");
  });

  it("honors an external abort while requestUrl settles in background", async () => {
    obsidianMocks.requestUrl.mockImplementation(
      () => new Promise<RequestUrlResponse>(() => undefined),
    );
    const controller = new AbortController();
    const pending = callOpenRouter(settings(), "system", "user", {
      signal: controller.signal,
    });

    controller.abort();
    const error = await rejection(pending);
    expect(error.name).toBe("AbortError");
  });

  it("limits how long the caller waits for requestUrl", async () => {
    vi.useFakeTimers();
    obsidianMocks.requestUrl.mockImplementation(
      () => new Promise<RequestUrlResponse>(() => undefined),
    );
    const errorPromise = rejection(
      callOpenRouter(settings(), "system", "user"),
    );

    await vi.advanceTimersByTimeAsync(30_000);
    const error = await errorPromise;
    expect(error.name).toBe("TimeoutError");
  });

  it("ignores a late requestUrl rejection without an unhandled rejection", async () => {
    vi.useFakeTimers();
    let rejectRequest!: (reason: unknown) => void;
    obsidianMocks.requestUrl.mockReturnValueOnce(
      new Promise<RequestUrlResponse>((_resolve, reject) => {
        rejectRequest = reject;
      }),
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const errorPromise = rejection(
        callOpenRouter(settings(), "system", "user"),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await errorPromise).name).toBe("TimeoutError");

      rejectRequest(new Error("late provider-secret rejection"));
      await flushMicrotasks();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("ignores a late requestUrl fulfillment after timeout", async () => {
    vi.useFakeTimers();
    let resolveRequest!: (value: RequestUrlResponse) => void;
    obsidianMocks.requestUrl.mockReturnValueOnce(
      new Promise<RequestUrlResponse>((resolve) => {
        resolveRequest = resolve;
      }),
    );
    let observableSettlements = 0;
    const pending = callOpenRouter(settings(), "system", "user");
    void pending.then(
      () => {
        observableSettlements++;
      },
      () => {
        observableSettlements++;
      },
    );
    const errorPromise = rejection(pending);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await errorPromise).name).toBe("TimeoutError");
    expect(observableSettlements).toBe(1);

    resolveRequest(
      response(
        200,
        JSON.stringify({
          choices: [{ message: { content: "late answer" } }],
        }),
      ),
    );
    await flushMicrotasks();
    expect(observableSettlements).toBe(1);
  });

  it("ignores a late requestUrl rejection after external abort", async () => {
    let rejectRequest!: (reason: unknown) => void;
    obsidianMocks.requestUrl.mockReturnValueOnce(
      new Promise<RequestUrlResponse>((_resolve, reject) => {
        rejectRequest = reject;
      }),
    );
    const controller = new AbortController();
    const errorPromise = rejection(
      callOpenRouter(settings(), "system", "user", controller.signal),
    );
    controller.abort();
    expect((await errorPromise).name).toBe("AbortError");

    rejectRequest(new Error("late provider-secret rejection"));
    await flushMicrotasks();
  });

  it("validates Ollama model names instead of trusting response.json", async () => {
    obsidianMocks.requestUrl.mockResolvedValueOnce(
      response(200, JSON.stringify({
        models: [{ name: "llama3.2" }, { name: 42 }, null],
      })),
    );

    await expect(fetchOllamaModels("http://localhost:11434/v1"))
      .resolves.toEqual(["llama3.2"]);
  });

  it("validates and sorts OpenRouter free model metadata", async () => {
    obsidianMocks.requestUrl.mockResolvedValueOnce(
      response(200, JSON.stringify({
        data: [
          { id: "small:free", name: "Small (free)", context_length: 8 },
          { id: "paid", context_length: 100 },
          { id: "large:free", context_length: 32 },
          { id: 42 },
        ],
      })),
    );

    await expect(fetchOpenRouterFreeModels()).resolves.toEqual([
      { id: "large:free", name: "large:free", context: 32 },
      { id: "small:free", name: "Small", context: 8 },
    ]);
  });

  it("keeps SSE token streaming on the fetch response body", async () => {
    const streamBody = [
      'data: {"choices":[{"delta":{"content":"one "}}]}',
      'data: {"choices":[{"delta":{"content":"two"}}]}',
      "data: [DONE]",
      "",
    ].join("\n");
    const fetchMock = vi.fn(async () => new Response(streamBody));
    vi.stubGlobal("fetch", fetchMock);
    const tokens: string[] = [];

    await streamOpenRouter(settings(), "system", "user", (token) => {
      tokens.push(token);
    });

    expect(tokens).toEqual(["one ", "two"]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(obsidianMocks.requestUrl).not.toHaveBeenCalled();
  });

  it("redacts streaming HTTP response bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("sk-private provider-body", {
        status: 500,
      })),
    );

    const error = await rejection(
      streamOpenRouter(settings(), "system", "user", () => undefined),
    );
    expect(error.message).toContain("500");
    expect(error.message).not.toContain("sk-private");
    expect(error.message).not.toContain("provider-body");
  });

  it("delivers three SSE tokens incrementally", async () => {
    const controlled = createControlledStream();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(controlled.body)));
    const tokens: string[] = [];
    const pending = streamOpenRouter(
      settings(),
      "system",
      "user",
      (token) => tokens.push(token),
    );
    await flushMicrotasks();

    controlled.controller().enqueue(sseToken("one"));
    await vi.waitFor(() => expect(tokens).toEqual(["one"]));
    controlled.controller().enqueue(sseToken("two"));
    await vi.waitFor(() => expect(tokens).toEqual(["one", "two"]));
    controlled.controller().enqueue(sseToken("three"));
    await vi.waitFor(() => expect(tokens).toEqual(["one", "two", "three"]));
    controlled.controller().enqueue(encoder.encode("data: [DONE]\n"));

    await pending;
    expect(controlled.cancel).toHaveBeenCalledOnce();
    expect(controlled.body.locked).toBe(false);
  });

  it("aborts the full stream lifecycle after the first token", async () => {
    const controlled = createControlledStream();
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        fetchSignal = init?.signal ?? undefined;
        return new Response(controlled.body);
      }),
    );
    const external = new AbortController();
    const tokens: string[] = [];
    const pending = streamOpenRouter(
      settings(),
      "system",
      "user",
      (token) => tokens.push(token),
      external.signal,
    );
    await flushMicrotasks();
    controlled.controller().enqueue(sseToken("one"));
    await vi.waitFor(() => expect(tokens).toEqual(["one"]));

    external.abort();
    const error = await rejection(pending);
    expect(error.name).toBe("AbortError");
    expect(fetchSignal?.aborted).toBe(true);
    expect(tokens).toEqual(["one"]);
    expect(controlled.cancel).toHaveBeenCalledOnce();
    expect(controlled.body.locked).toBe(false);
    expect(() => controlled.controller().enqueue(sseToken("two"))).toThrow();
  });

  it("times out while the response body is pending after headers", async () => {
    vi.useFakeTimers();
    const controlled = createControlledStream();
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        fetchSignal = init?.signal ?? undefined;
        return new Response(controlled.body);
      }),
    );
    const errorPromise = rejection(
      streamOpenRouter(settings(), "system", "user", () => undefined),
    );
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(STREAM_TIMEOUT_MS);
    const error = await errorPromise;
    expect(error.name).toBe("TimeoutError");
    expect(fetchSignal?.aborted).toBe(true);
    expect(controlled.cancel).toHaveBeenCalledOnce();
    expect(controlled.body.locked).toBe(false);
  });

  it("cancels after DONE and ignores later events in the same chunk", async () => {
    const controlled = createControlledStream();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(controlled.body)));
    const tokens: string[] = [];
    const pending = streamOpenRouter(
      settings(),
      "system",
      "user",
      (token) => tokens.push(token),
    );
    await flushMicrotasks();
    const payload = [
      new TextDecoder().decode(sseToken("before")),
      "data: [DONE]\n",
      new TextDecoder().decode(sseToken("after")),
    ].join("");
    controlled.controller().enqueue(encoder.encode(payload));

    await pending;
    expect(tokens).toEqual(["before"]);
    expect(controlled.cancel).toHaveBeenCalledOnce();
    expect(controlled.body.locked).toBe(false);
  });

  it("releases the reader without cancel after natural EOF", async () => {
    const controlled = createControlledStream();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(controlled.body)));
    const tokens: string[] = [];
    const pending = streamOpenRouter(
      settings(),
      "system",
      "user",
      (token) => tokens.push(token),
    );
    await flushMicrotasks();
    controlled.controller().enqueue(sseToken("final"));
    controlled.controller().close();

    await pending;
    expect(tokens).toEqual(["final"]);
    expect(controlled.cancel).not.toHaveBeenCalled();
    expect(controlled.body.locked).toBe(false);
  });

  it("skips malformed SSE between valid events", async () => {
    const controlled = createControlledStream();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(controlled.body)));
    const tokens: string[] = [];
    const pending = streamOpenRouter(
      settings(),
      "system",
      "user",
      (token) => tokens.push(token),
    );
    await flushMicrotasks();
    controlled.controller().enqueue(sseToken("before"));
    controlled.controller().enqueue(encoder.encode("data: {malformed}\n"));
    controlled.controller().enqueue(sseToken("after"));
    controlled.controller().close();

    await pending;
    expect(tokens).toEqual(["before", "after"]);
  });

  it("surfaces reader failures as controlled Errors and releases the lock", async () => {
    const controlled = createControlledStream();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(controlled.body)));
    const pending = streamOpenRouter(
      settings(),
      "system",
      "user",
      () => undefined,
    );
    await flushMicrotasks();
    controlled.controller().error(new Error("reader failure"));

    const error = await rejection(pending);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("reader failure");
    expect(controlled.body.locked).toBe(false);
  });

  it("cancels the reader when repetition detection stops generation", async () => {
    const controlled = createControlledStream();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(controlled.body)));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tokens: string[] = [];
    const pending = streamOpenRouter(
      settings(),
      "system",
      "user",
      (token) => tokens.push(token),
    );
    await flushMicrotasks();
    controlled.controller().enqueue(sseToken("prefix"));
    await vi.waitFor(() => expect(tokens).toEqual(["prefix"]));
    controlled.controller().enqueue(
      sseToken("abcdefghijklmnopqrst".repeat(20)),
    );

    await pending;
    expect(tokens).toEqual(["prefix"]);
    expect(warning).toHaveBeenCalledOnce();
    expect(controlled.cancel).toHaveBeenCalledOnce();
    expect(controlled.body.locked).toBe(false);
  });

  it("cancels and propagates a consumer callback failure", async () => {
    const controlled = createControlledStream();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(controlled.body)));
    const pending = streamOpenRouter(settings(), "system", "user", () => {
      throw new Error("consumer failure");
    });
    await flushMicrotasks();
    controlled.controller().enqueue(sseToken("token"));

    const error = await rejection(pending);
    expect(error.message).toBe("consumer failure");
    expect(controlled.cancel).toHaveBeenCalledOnce();
    expect(controlled.body.locked).toBe(false);
  });

  it("cleans the lifecycle when fetch rejects", async () => {
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        fetchSignal = init?.signal ?? undefined;
        throw new Error("network failure");
      }),
    );

    const error = await rejection(
      streamOpenRouter(settings(), "system", "user", () => undefined),
    );
    expect(error.message).toBe("network failure");
    expect(fetchSignal?.aborted).toBe(true);
  });
});
