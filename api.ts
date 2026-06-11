import { requestUrl } from "obsidian";
import { AIHubSettings } from "./settings";
import { PROVIDER_PROFILES } from "./constants";
import {
  API_TIMEOUT_MS,
  STREAM_TIMEOUT_MS,
  REPETITION_WINDOW,
  REPETITION_THRESHOLD,
} from "./constants";

export function validateSettings(settings: AIHubSettings): string | null {
  if (!settings.model.trim()) return "⚠️ Укажите название модели!";
  if (!settings.baseUrl.trim()) return "⚠️ Укажите Base URL!";
  if (settings.temperature < 0 || settings.temperature > 1) {
    return "⚠️ Temperature должен быть 0.0–1.0";
  }
  // API key нужен не всем провайдерам
  const profile = PROVIDER_PROFILES[settings.provider ?? "openrouter"];
  if (profile.requiresApiKey && !settings.apiKey.trim()) {
    return `⚠️ Введите API Key для ${profile.label}!`;
  }
  return null;
}

// ─────────────────────────────────────────────
//  Построение заголовков запроса по провайдеру
// ─────────────────────────────────────────────
function buildHeaders(settings: AIHubSettings): Record<string, string> {
  const provider = settings.provider ?? "openrouter";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (provider === "ollama" && !settings.apiKey.trim()) {
    headers["Authorization"] = "Bearer ollama";
  } else if (settings.apiKey.trim()) {
    headers["Authorization"] = `Bearer ${settings.apiKey}`;
  }

  // OpenRouter требует дополнительные заголовки
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://obsidian.md";
    headers["X-Title"] = "Obsidian AI Hub";
  }

  return headers;
}

// ─────────────────────────────────────────────
//  Построение тела запроса по провайдеру
// ─────────────────────────────────────────────
function buildBody(
  settings: AIHubSettings,
  system: string,
  user: string,
  opts: CallOptions,
  stream = false,
): Record<string, unknown> {
  const profile = PROVIDER_PROFILES[settings.provider ?? "openrouter"];

  const body: Record<string, unknown> = {
    model: settings.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: opts.temperature ?? settings.temperature,
    max_tokens: opts.maxTokens ?? 2000,
  };

  if (stream) body["stream"] = true;

  // repetition_penalty — только для OpenRouter
  if (profile.supportsRepetitionPenalty) {
    body["repetition_penalty"] = opts.repetitionPenalty ?? 1.15;
  }

  // frequency_penalty поддерживают все кроме базового Ollama
  if (settings.provider !== "ollama") {
    body["frequency_penalty"] = opts.frequencyPenalty ?? 0.1;
  }

  return body;
}

// ─────────────────────────────────────────────
//  Fetch с таймаутом + поддержка внешнего signal
// ─────────────────────────────────────────────
export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = API_TIMEOUT_MS,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  const onAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onAbort);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

// ─────────────────────────────────────────────
//  Детектор петель повторений
//  Ищет одинаковые блоки размером >= minChunk в конце буфера
// ─────────────────────────────────────────────
export function detectRepetitionLoop(
  buffer: string,
  window = REPETITION_WINDOW,
  threshold = REPETITION_THRESHOLD,
): boolean {
  if (buffer.length < window * 2) return false;

  const tail = buffer.slice(-window * threshold);

  // Проверяем повторение блоков разной длины (от 20 до window/2 символов)
  for (let chunkLen = 20; chunkLen <= Math.floor(window / 2); chunkLen += 10) {
    const probe = tail.slice(-chunkLen);
    if (probe.trim().length < 10) continue; // игнорируем пробелы/переносы

    let count = 0;
    let pos = tail.length - chunkLen;
    while (pos >= chunkLen) {
      if (tail.slice(pos - chunkLen, pos) === probe) {
        count++;
        pos -= chunkLen;
        if (count >= threshold - 1) return true;
      } else {
        break;
      }
    }
  }
  return false;
}

// ─────────────────────────────────────────────
//  Типы ответа API
// ─────────────────────────────────────────────
interface OpenRouterChoice {
  message?: { content?: string };
  delta?: { content?: string };
  finish_reason?: string | null;
}

interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
  error?: { message?: string; code?: number };
}

// ─────────────────────────────────────────────
//  Параметры запроса (можно расширять)
// ─────────────────────────────────────────────
export interface CallOptions {
  maxTokens?: number;
  temperature?: number;
  repetitionPenalty?: number;
  frequencyPenalty?: number;
  signal?: AbortSignal;
}

// ─────────────────────────────────────────────
//  Обычный (не-стриминговый) вызов
// ─────────────────────────────────────────────
export async function callOpenRouter(
  settings: AIHubSettings,
  system: string,
  user: string,
  signalOrOptions?: AbortSignal | CallOptions,
): Promise<string> {
  const err = validateSettings(settings);
  if (err) throw new Error(err);

  // Поддерживаем старый сигнатуру (signal) и новый (options)
  const opts: CallOptions =
    signalOrOptions instanceof AbortSignal
      ? { signal: signalOrOptions }
      : (signalOrOptions ?? {});

  const body = buildBody(settings, system, user, opts, false);
  const headers = buildHeaders(settings);

  const res = await fetchWithTimeout(
    `${settings.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    API_TIMEOUT_MS,
    opts.signal,
  );

  if (!res.ok) {
    const errorText = await res.text().catch(() => "Нет деталей");
    throw new Error(`API ${res.status}: ${errorText.slice(0, 200)}`);
  }

  const json = (await res.json()) as OpenRouterResponse;

  if (json.error?.message) {
    throw new Error(`API error: ${json.error.message}`);
  }

  return json.choices?.[0]?.message?.content ?? "";
}

// ─────────────────────────────────────────────
//  Стриминговый вызов с защитой от петель
// ─────────────────────────────────────────────
export async function streamOpenRouter(
  settings: AIHubSettings,
  system: string,
  user: string,
  onToken: (text: string) => void,
  signalOrOptions?: AbortSignal | CallOptions,
): Promise<void> {
  const err = validateSettings(settings);
  if (err) throw new Error(err);

  const opts: CallOptions =
    signalOrOptions instanceof AbortSignal
      ? { signal: signalOrOptions }
      : (signalOrOptions ?? {});

  const body = buildBody(settings, system, user, opts, true);
  const headers = { ...buildHeaders(settings), Accept: "text/event-stream" };

  const res = await fetchWithTimeout(
    `${settings.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    STREAM_TIMEOUT_MS, // ← увеличенный таймаут для стриминга
    opts.signal,
  );

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${errorText.slice(0, 200)}`);
  }
  if (!res.body) throw new Error("Нет тела ответа");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let generated = ""; // накопленный текст для проверки петель

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;

        const jsonStr = trimmed.slice(6);
        if (jsonStr === "[DONE]") return;

        try {
          const json = JSON.parse(jsonStr) as OpenRouterResponse;

          // Проверяем finish_reason
          const finishReason = json.choices?.[0]?.finish_reason;
          if (finishReason && finishReason !== "null") return;

          const content = json.choices?.[0]?.delta?.content;
          if (!content) continue;

          // ── Детектор петли ──────────────────────────────
          generated += content;
          if (detectRepetitionLoop(generated)) {
            // Прерываем стрим — модель зациклилась
            console.warn("[AI Hub] Обнаружена петля повторений, стрим прерван");
            return;
          }
          // ────────────────────────────────────────────────

          onToken(content);
        } catch {
          // Неполный чанк — пропускаем
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─────────────────────────────────────────────
//  Проверка соединения с провайдером
// ─────────────────────────────────────────────
export async function testConnection(settings: AIHubSettings): Promise<string> {
  const provider = settings.provider ?? "openrouter";

  // Для Ollama — проверяем /api/tags
  if (provider === "ollama") {
    const base = settings.baseUrl.replace(/\/v1\/?$/, "");
    const res = await fetchWithTimeout(
      `${base}/api/tags`,
      { method: "GET" },
      5000,
    );
    if (!res.ok) throw new Error(`Ollama не отвечает: HTTP ${res.status}`);
    const json = (await res.json()) as { models?: Array<{ name: string }> };
    const count = json.models?.length ?? 0;
    const names =
      json.models
        ?.slice(0, 3)
        .map((m) => m.name)
        .join(", ") ?? "";
    return `✓ Ollama доступен · ${count} моделей${names ? ": " + names : ""}`;
  }

  // Для остальных — минимальный запрос к chat/completions
  const err = validateSettings(settings);
  if (err) throw new Error(err);

  const headers = buildHeaders(settings);
  const res = await fetchWithTimeout(
    `${settings.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.model,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 1,
      }),
    },
    10_000,
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 120)}`);
  }

  const profile = PROVIDER_PROFILES[provider];
  return `✓ ${profile.label} отвечает · Модель: ${settings.model}`;
}

// ─────────────────────────────────────────────
//  Загрузка списка моделей Ollama
// ─────────────────────────────────────────────
export async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
  const base = baseUrl.replace(/\/v1\/?$/, "");
  try {
    const res = await fetchWithTimeout(
      `${base}/api/tags`,
      { method: "GET" },
      5000,
    );
    if (!res.ok) return [];
    const json = (await res.json()) as { models?: Array<{ name: string }> };
    return json.models?.map((m) => m.name) ?? [];
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────
//  Бесплатные модели OpenRouter (публичный эндпоинт, ключ не нужен)
// ─────────────────────────────────────────────
export interface FreeModelInfo {
  id: string;
  name: string;
  context: number;
}

export async function fetchOpenRouterFreeModels(): Promise<FreeModelInfo[]> {
  const res = await requestUrl({
    url: "https://openrouter.ai/api/v1/models",
    method: "GET",
  });
  const json = res.json as {
    data?: Array<{ id: string; name?: string; context_length?: number }>;
  };
  return (json.data ?? [])
    .filter((m) => m.id.endsWith(":free"))
    .sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0))
    .slice(0, 12)
    .map((m) => ({
      id: m.id,
      name: (m.name ?? m.id).replace(/\s*\(free\)\s*$/i, ""),
      context: m.context_length ?? 0,
    }));
}