export type EmbeddingProviderId =
  | "openrouter"
  | "openai-compatible"
  | "ollama";

export interface EmbeddingSettings {
  enabled: boolean;
  embeddingProvider: EmbeddingProviderId;
  embeddingModel: string;
  embeddingBaseUrl: string;
  openRouterApiKey: string;
  openAICompatibleApiKey: string;
}

export interface EmbeddingProvider {
  readonly id: EmbeddingProviderId;
  readonly model: string;

  embed(texts: string[]): Promise<Float32Array[]>;

  dimensions(): Promise<number>;
}

export interface EmbeddingTestResult {
  provider: string;
  model: string;
  dimensions: number;
}

export interface EmbeddingProviderProfile {
  id: EmbeddingProviderId;
  label: string;
  defaultBaseUrl: string;
  defaultModel: string;
  requiresApiKey: boolean;
}

export const EMBEDDING_PROVIDER_PROFILES: Record<
  EmbeddingProviderId,
  EmbeddingProviderProfile
> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/text-embedding-3-small",
    requiresApiKey: true,
  },
  "openai-compatible": {
    id: "openai-compatible",
    label: "OpenAI-compatible",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "text-embedding-3-small",
    requiresApiKey: false,
  },
  ollama: {
    id: "ollama",
    label: "Ollama",
    defaultBaseUrl: "http://localhost:11434",
    defaultModel: "embeddinggemma",
    requiresApiKey: false,
  },
};

export const DEFAULT_EMBEDDING_SETTINGS: EmbeddingSettings = {
  enabled: false,
  embeddingProvider: "openrouter",
  embeddingModel: EMBEDDING_PROVIDER_PROFILES.openrouter.defaultModel,
  embeddingBaseUrl: EMBEDDING_PROVIDER_PROFILES.openrouter.defaultBaseUrl,
  openRouterApiKey: "",
  openAICompatibleApiKey: "",
};

/** Shape accepted while loading settings written by the first local draft. */
export type StoredEmbeddingSettings = Partial<EmbeddingSettings> & {
  embeddingApiKey?: string;
};

export function isEmbeddingProviderId(
  value: unknown,
): value is EmbeddingProviderId {
  return (
    value === "openrouter" ||
    value === "openai-compatible" ||
    value === "ollama"
  );
}

/**
 * Merge persisted settings with defaults and migrate the draft's shared key.
 * A legacy key is assigned only to the selected keyed provider; Ollama never
 * receives or retains an API key.
 */
export function mergeEmbeddingSettings(
  stored?: StoredEmbeddingSettings | null,
): EmbeddingSettings {
  const provider = isEmbeddingProviderId(stored?.embeddingProvider)
    ? stored.embeddingProvider
    : DEFAULT_EMBEDDING_SETTINGS.embeddingProvider;
  const legacyApiKey =
    typeof stored?.embeddingApiKey === "string"
      ? stored.embeddingApiKey.trim()
      : "";

  let openRouterApiKey =
    typeof stored?.openRouterApiKey === "string"
      ? stored.openRouterApiKey
      : DEFAULT_EMBEDDING_SETTINGS.openRouterApiKey;
  let openAICompatibleApiKey =
    typeof stored?.openAICompatibleApiKey === "string"
      ? stored.openAICompatibleApiKey
      : DEFAULT_EMBEDDING_SETTINGS.openAICompatibleApiKey;

  if (legacyApiKey && provider === "openrouter" && !openRouterApiKey) {
    openRouterApiKey = legacyApiKey;
  }
  if (
    legacyApiKey &&
    provider === "openai-compatible" &&
    !openAICompatibleApiKey
  ) {
    openAICompatibleApiKey = legacyApiKey;
  }

  return {
    enabled:
      typeof stored?.enabled === "boolean"
        ? stored.enabled
        : DEFAULT_EMBEDDING_SETTINGS.enabled,
    embeddingProvider: provider,
    embeddingModel:
      typeof stored?.embeddingModel === "string"
        ? stored.embeddingModel
        : DEFAULT_EMBEDDING_SETTINGS.embeddingModel,
    embeddingBaseUrl:
      typeof stored?.embeddingBaseUrl === "string"
        ? stored.embeddingBaseUrl
        : DEFAULT_EMBEDDING_SETTINGS.embeddingBaseUrl,
    openRouterApiKey,
    openAICompatibleApiKey,
  };
}
