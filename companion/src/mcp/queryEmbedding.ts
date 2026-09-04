import type { SemanticDescriptor } from "../protocol/types.js";
import { assertCompatibleDescriptor, normalizeDescriptorBaseUrl } from "./descriptor.js";
import { semanticSearchUnavailable } from "./errors.js";

export interface QueryEmbeddingProvider {
  embedQuery(descriptor: SemanticDescriptor, query: string): Promise<Float32Array>;
}

export type QueryEmbeddingFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DescriptorQueryEmbeddingProviderOptions {
  apiKey: string;
  timeoutMs: number;
  fetch?: QueryEmbeddingFetch;
}

function embeddingEndpoint(baseUrl: string, suffix: string): string {
  const url = new URL(normalizeDescriptorBaseUrl(baseUrl));
  const baseParts = url.pathname.split("/").filter(Boolean);
  const suffixParts = suffix.split("/").filter(Boolean);
  const alreadyPresent = suffixParts.length <= baseParts.length && suffixParts.every(
    (part, index) => baseParts[baseParts.length - suffixParts.length + index] === part,
  );
  url.pathname = `/${(alreadyPresent ? baseParts : [...baseParts, ...suffixParts]).join("/")}`;
  return url.toString();
}

function vectorFromPayload(payload: unknown, providerId: string): Float32Array {
  if (!payload || typeof payload !== "object") throw semanticSearchUnavailable();
  let raw: unknown;
  if (providerId === "ollama") {
    const embeddings = (payload as { embeddings?: unknown }).embeddings;
    raw = Array.isArray(embeddings) && embeddings.length === 1 ? embeddings[0] : undefined;
  } else {
    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length !== 1 || !data[0] || typeof data[0] !== "object") {
      throw semanticSearchUnavailable();
    }
    const item = data[0] as { index?: unknown; embedding?: unknown };
    if (item.index !== undefined && item.index !== 0) throw semanticSearchUnavailable();
    raw = item.embedding;
  }
  if (!Array.isArray(raw) || raw.length === 0) throw semanticSearchUnavailable();
  const vector = new Float32Array(raw.length);
  for (let index = 0; index < raw.length; index++) {
    const value = raw[index];
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 3.4028234663852886e38) {
      throw semanticSearchUnavailable();
    }
    vector[index] = value;
  }
  return vector;
}

export class DescriptorQueryEmbeddingProvider implements QueryEmbeddingProvider {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly performFetch: QueryEmbeddingFetch;

  constructor(options: DescriptorQueryEmbeddingProviderOptions) {
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.performFetch = options.fetch ?? fetch;
  }

  async embedQuery(descriptor: SemanticDescriptor, query: string): Promise<Float32Array> {
    assertCompatibleDescriptor(descriptor);
    const keyedProvider = descriptor.providerId === "openrouter" ||
      (descriptor.providerId === "openai-compatible" && new URL(descriptor.baseUrl).hostname === "api.openai.com");
    if (keyedProvider && !this.apiKey) throw semanticSearchUnavailable();
    const ollama = descriptor.providerId === "ollama";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey && !ollama) headers.authorization = `Bearer ${this.apiKey}`;
    if (descriptor.providerId === "openrouter") {
      headers["http-referer"] = "https://obsidian.md";
      headers["x-title"] = "Vault Audit AI Companion";
    }
    const body = ollama
      ? { model: descriptor.model, input: [query] }
      : { model: descriptor.model, input: [query], encoding_format: "float" };
    let response: Response;
    try {
      response = await this.performFetch(
        embeddingEndpoint(descriptor.baseUrl, ollama ? "api/embed" : "embeddings"),
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: "error",
        },
      );
    } catch {
      throw semanticSearchUnavailable();
    }
    if (!response.ok) throw semanticSearchUnavailable();
    let payload: unknown;
    try {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (!response.body) throw semanticSearchUnavailable();
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 2 * 1024 * 1024) throw semanticSearchUnavailable();
        chunks.push(chunk);
      }
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw semanticSearchUnavailable();
    }
    if (payload && typeof payload === "object" && "model" in payload && payload.model !== descriptor.model) {
      throw semanticSearchUnavailable();
    }
    return vectorFromPayload(payload, descriptor.providerId);
  }
}
