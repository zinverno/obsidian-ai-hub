import {
  BaseEmbeddingProvider,
  buildEmbeddingEndpoint,
  parseOllamaEmbeddingResponse,
  parseOpenAIEmbeddingResponse,
  requestEmbeddingJson,
} from "./shared";
import type { EmbeddingProviderId } from "./types";

export interface OpenAICompatibleEmbeddingConfig {
  provider: "openrouter" | "openai-compatible";
  model: string;
  baseUrl: string;
  apiKey: string;
}

export class OpenAICompatibleEmbeddingProvider extends BaseEmbeddingProvider {
  readonly id: EmbeddingProviderId;
  private readonly endpoint: string;
  private readonly apiKey: string;

  constructor(config: OpenAICompatibleEmbeddingConfig) {
    super(config.model);
    this.id = config.provider;
    this.endpoint = buildEmbeddingEndpoint(config.baseUrl, "embeddings");
    this.apiKey = config.apiKey;
  }

  protected async embedBatch(texts: string[]): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (this.id === "openrouter") {
      headers["HTTP-Referer"] = "https://obsidian.md";
      headers["X-Title"] = "Obsidian AI Hub";
    }

    const payload = await requestEmbeddingJson(
      this.endpoint,
      headers,
      {
        model: this.model,
        input: texts,
        encoding_format: "float",
      },
    );
    return parseOpenAIEmbeddingResponse(payload, texts.length);
  }
}

export interface OllamaEmbeddingConfig {
  model: string;
  baseUrl: string;
}

export class OllamaEmbeddingProvider extends BaseEmbeddingProvider {
  readonly id = "ollama" as const;
  private readonly endpoint: string;

  constructor(config: OllamaEmbeddingConfig) {
    super(config.model);
    this.endpoint = buildEmbeddingEndpoint(config.baseUrl, "api/embed");
  }

  protected async embedBatch(texts: string[]): Promise<unknown> {
    const payload = await requestEmbeddingJson(
      this.endpoint,
      { "Content-Type": "application/json" },
      { model: this.model, input: texts },
    );
    return parseOllamaEmbeddingResponse(payload);
  }
}
