import { t as tr } from "../i18n";
import {
  OllamaEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider,
} from "./providers";
import { parseEmbeddingBaseUrl } from "./shared";
import { EMBEDDING_PROVIDER_PROFILES } from "./types";
import type {
  EmbeddingProvider,
  EmbeddingSettings,
  EmbeddingTestResult,
} from "./types";

export function isOfficialOpenAIEmbeddingBaseUrl(baseUrl: string): boolean {
  return parseEmbeddingBaseUrl(baseUrl).hostname === "api.openai.com";
}

function embeddingApiKey(settings: EmbeddingSettings): string {
  if (settings.embeddingProvider === "openrouter") {
    return settings.openRouterApiKey.trim();
  }
  if (settings.embeddingProvider === "openai-compatible") {
    return settings.openAICompatibleApiKey.trim();
  }
  return "";
}

export function validateEmbeddingSettings(
  settings: EmbeddingSettings,
): string | null {
  if (!settings.embeddingModel.trim()) {
    return tr("Укажите модель embeddings.");
  }
  if (!settings.embeddingBaseUrl.trim()) {
    return tr("Укажите Base URL embeddings.");
  }
  let baseUrl: URL;
  try {
    baseUrl = parseEmbeddingBaseUrl(settings.embeddingBaseUrl);
  } catch (error) {
    return error instanceof Error
      ? error.message
      : tr("Base URL embeddings должен быть корректным HTTP(S)-адресом.");
  }

  const profile = EMBEDDING_PROVIDER_PROFILES[settings.embeddingProvider];
  if (!profile) return tr("Выбран неизвестный embedding-провайдер.");
  const isOpenAI =
    settings.embeddingProvider === "openai-compatible" &&
    baseUrl.hostname === "api.openai.com";
  if ((profile.requiresApiKey || isOpenAI) && !embeddingApiKey(settings)) {
    return tr("Укажите API-ключ для embedding-провайдера {provider}.", {
      provider: profile.label,
    });
  }
  return null;
}

export function createEmbeddingProvider(
  settings: EmbeddingSettings,
): EmbeddingProvider {
  const error = validateEmbeddingSettings(settings);
  if (error) throw new Error(error);

  if (settings.embeddingProvider === "ollama") {
    return new OllamaEmbeddingProvider({
      model: settings.embeddingModel.trim(),
      baseUrl: settings.embeddingBaseUrl.trim(),
    });
  }

  return new OpenAICompatibleEmbeddingProvider({
    provider: settings.embeddingProvider,
    model: settings.embeddingModel.trim(),
    baseUrl: settings.embeddingBaseUrl.trim(),
    apiKey: embeddingApiKey(settings),
  });
}

export async function testEmbeddingConnection(
  settings: EmbeddingSettings,
): Promise<EmbeddingTestResult> {
  const provider = createEmbeddingProvider(settings);
  const dimensions = await provider.dimensions();
  return {
    provider: EMBEDDING_PROVIDER_PROFILES[provider.id].label,
    model: provider.model,
    dimensions,
  };
}
