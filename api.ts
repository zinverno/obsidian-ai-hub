import { t as tr } from "./i18n";
import { requestUrl } from "obsidian";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import type { AIHubSettings } from "./settings";
import { PROVIDER_PROFILES } from "./constants";
import {
  API_TIMEOUT_MS,
  STREAM_TIMEOUT_MS,
  REPETITION_WINDOW,
  REPETITION_THRESHOLD,
} from "./constants";

export function validateSettings(settings: AIHubSettings): string | null {
  if (!settings.model.trim()) return tr("⚠️ Укажите название модели!");
  if (!settings.baseUrl.trim()) return tr("⚠️ Укажите Base URL!");
  if (settings.temperature < 0 || settings.temperature > 1) {
    return tr("⚠️ Temperature должен быть 0.0–1.0");
  }
  // API key нужен не всем провайдерам
  const profile = PROVIDER_PROFILES[settings.provider ?? "openrouter"];
  if (profile.requiresApiKey && !settings.apiKey.trim()) {
    return tr("⚠️ Введите API Key для {p}!", { p: profile.label });
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
  error?: { code?: number };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(tr("API вернул некорректный JSON."));
  }
}

function parseOpenRouterResponse(text: string): OpenRouterResponse {
  const payload = parseJson(text);
  if (!isObject(payload)) {
    throw new Error(tr("API вернул ответ неверного формата."));
  }

  let error: OpenRouterResponse["error"];
  if (payload.error !== undefined) {
    if (!isObject(payload.error)) {
      throw new Error(tr("API вернул ответ неверного формата."));
    }
    error = {
      code:
        typeof payload.error.code === "number"
          ? payload.error.code
          : undefined,
    };
  }

  let choices: OpenRouterChoice[] | undefined;
  if (payload.choices !== undefined) {
    if (!Array.isArray(payload.choices)) {
      throw new Error(tr("API вернул ответ неверного формата."));
    }
    choices = payload.choices.map((rawChoice) => {
      if (!isObject(rawChoice)) {
        throw new Error(tr("API вернул ответ неверного формата."));
      }
      const choice: OpenRouterChoice = {};
      if (rawChoice.message !== undefined) {
        if (!isObject(rawChoice.message)) {
          throw new Error(tr("API вернул ответ неверного формата."));
        }
        if (typeof rawChoice.message.content !== "string") {
          throw new Error(tr("API вернул ответ неверного формата."));
        }
        choice.message = { content: rawChoice.message.content };
      }
      if (rawChoice.delta !== undefined) {
        if (!isObject(rawChoice.delta)) {
          throw new Error(tr("API вернул ответ неверного формата."));
        }
        if (rawChoice.delta.content !== undefined) {
          if (typeof rawChoice.delta.content !== "string") {
            throw new Error(tr("API вернул ответ неверного формата."));
          }
          choice.delta = { content: rawChoice.delta.content };
        }
      }
      if (
        typeof rawChoice.finish_reason === "string" ||
        rawChoice.finish_reason === null
      ) {
        choice.finish_reason = rawChoice.finish_reason;
      }
      return choice;
    });
  }
  return { choices, error };
}

function namedError(name: "AbortError" | "TimeoutError", message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/**
 * requestUrl is the mobile-safe path for buffered requests. It cannot cancel
 * an in-flight request, so timeout/abort only stop the caller from waiting;
 * handlers remain attached to the background request to avoid late unhandled
 * rejections.
 */
async function requestBuffered(
  request: RequestUrlParam,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RequestUrlResponse> {
  let timeoutId: number | undefined;
  let onAbort: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(namedError("TimeoutError", tr("Время ожидания API истекло.")));
    }, timeoutMs);
  });
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(namedError("AbortError", tr("API-запрос отменён.")));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  const requestPromise: Promise<RequestUrlResponse> = Promise.resolve().then(
    () => requestUrl({ ...request, throw: false }),
  );

  try {
    return await Promise.race([
      requestPromise,
      timeoutPromise,
      abortPromise,
    ]);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw error;
    }
    throw new Error(tr("Не удалось подключиться к API."));
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

function httpError(status: number): Error {
  return new Error(tr("API вернул HTTP {code}.", { code: status }));
}

function parseOllamaModelNames(text: string): string[] {
  const payload = parseJson(text);
  if (!isObject(payload) || !Array.isArray(payload.models)) {
    throw new Error(tr("Ollama вернул ответ неверного формата."));
  }
  const names: string[] = [];
  for (const model of payload.models) {
    if (isObject(model) && typeof model.name === "string") {
      names.push(model.name);
    }
  }
  return names;
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

  const res = await requestBuffered(
    {
      url: `${settings.baseUrl}/chat/completions`,
      method: "POST",
      contentType: "application/json",
      headers,
      body: JSON.stringify(body),
    },
    API_TIMEOUT_MS,
    opts.signal,
  );

  if (res.status < 200 || res.status >= 300) throw httpError(res.status);

  const json = parseOpenRouterResponse(res.text);

  if (json.error) {
    throw new Error(
      json.error.code === undefined
        ? tr("API вернул ошибку.")
        : tr("API вернул ошибку с кодом {code}.", {
            code: json.error.code,
          }),
    );
  }

  const content = json.choices?.[0]?.message?.content;
  if (content === undefined) {
    throw new Error(tr("API вернул ответ неверного формата."));
  }
  return content;
}

type StreamTermination = "active" | "external-abort" | "timeout";

function streamTerminationError(reason: StreamTermination): Error {
  return reason === "timeout"
    ? namedError("TimeoutError", tr("Время ожидания API истекло."))
    : namedError("AbortError", tr("API-запрос отменён."));
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  termination: () => StreamTermination,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw streamTerminationError(termination());

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(streamTerminationError(termination()));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
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
  const controller = new AbortController();
  let termination: StreamTermination = "active";
  const timeoutId = window.setTimeout(() => {
    if (controller.signal.aborted) return;
    termination = "timeout";
    controller.abort();
  }, STREAM_TIMEOUT_MS);
  const onExternalAbort = () => {
    if (controller.signal.aborted) return;
    termination = "external-abort";
    controller.abort();
  };
  if (opts.signal?.aborted) onExternalAbort();
  else opts.signal?.addEventListener("abort", onExternalAbort, { once: true });

  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let reachedEof = false;
  try {
    response = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw httpError(response.status);
    if (!response.body) throw new Error(tr("Нет тела ответа"));

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let generated = ""; // накопленный текст для проверки петель

    while (true) {
      const { done, value } = await readStreamChunk(
        reader,
        controller.signal,
        () => termination,
      );
      if (done) {
        reachedEof = true;
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;

        const jsonStr = trimmed.slice(6);
        if (jsonStr === "[DONE]") return;

        let json: OpenRouterResponse;
        try {
          json = parseOpenRouterResponse(jsonStr);
        } catch {
          // Неполный чанк — пропускаем
          continue;
        }

        // Проверяем finish_reason
        const finishReason = json.choices?.[0]?.finish_reason;
        if (finishReason && finishReason !== "null") return;

        const content = json.choices?.[0]?.delta?.content;
        if (!content) continue;

        // ── Детектор петли ──────────────────────────────
        generated += content;
        if (detectRepetitionLoop(generated)) {
          // Прерываем стрим — модель зациклилась
          console.warn(tr("[AI Hub] Обнаружена петля повторений, стрим прерван"));
          return;
        }
        // ────────────────────────────────────────────────

        onToken(content);
      }
    }
  } catch (error) {
    if (termination !== "active") {
      throw streamTerminationError(termination);
    }
    throw error instanceof Error
      ? error
      : new Error(tr("Не удалось прочитать поток API."));
  } finally {
    window.clearTimeout(timeoutId);
    opts.signal?.removeEventListener("abort", onExternalAbort);

    if (!controller.signal.aborted) controller.abort();
    if (reader) {
      if (!reachedEof) {
        try {
          await reader.cancel();
        } catch {
          // Transport abort may reject cancel after it already closed the body.
        }
      }
      reader.releaseLock();
    } else if (response?.body) {
      try {
        await response.body.cancel();
      } catch {
        // Ignore cleanup errors and preserve the original request failure.
      }
    }
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
    const res = await requestBuffered(
      { url: `${base}/api/tags`, method: "GET" },
      5000,
    );
    if (res.status < 200 || res.status >= 300) throw httpError(res.status);
    const models = parseOllamaModelNames(res.text);
    const count = models.length;
    const names = models.slice(0, 3).join(", ");
    return tr("✓ Ollama доступен · {n} моделей{names}", { n: count, names: names ? ": " + names : "" });
  }

  // Для остальных — минимальный запрос к chat/completions
  const err = validateSettings(settings);
  if (err) throw new Error(err);

  const headers = buildHeaders(settings);
  const res = await requestBuffered(
    {
      url: `${settings.baseUrl}/chat/completions`,
      method: "POST",
      contentType: "application/json",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.model,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 1,
      }),
    },
    10_000,
  );

  if (res.status < 200 || res.status >= 300) throw httpError(res.status);

  const profile = PROVIDER_PROFILES[provider];
  return tr("✓ {p} отвечает · Модель: {m}", { p: profile.label, m: settings.model });
}

// ─────────────────────────────────────────────
//  Загрузка списка моделей Ollama
// ─────────────────────────────────────────────
export async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
  const base = baseUrl.replace(/\/v1\/?$/, "");
  try {
    const res = await requestBuffered(
      { url: `${base}/api/tags`, method: "GET" },
      5000,
    );
    if (res.status < 200 || res.status >= 300) return [];
    return parseOllamaModelNames(res.text);
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
  const res = await requestBuffered(
    {
      url: "https://openrouter.ai/api/v1/models",
      method: "GET",
    },
    API_TIMEOUT_MS,
  );
  if (res.status < 200 || res.status >= 300) throw httpError(res.status);
  const payload = parseJson(res.text);
  if (!isObject(payload) || !Array.isArray(payload.data)) {
    throw new Error(tr("OpenRouter вернул ответ неверного формата."));
  }
  const models: FreeModelInfo[] = [];
  for (const model of payload.data) {
    if (!isObject(model) || typeof model.id !== "string") continue;
    models.push({
      id: model.id,
      name: typeof model.name === "string" ? model.name : model.id,
      context:
        typeof model.context_length === "number"
          ? model.context_length
          : 0,
    });
  }
  return models
    .filter((m) => m.id.endsWith(":free"))
    .sort((a, b) => b.context - a.context)
    .slice(0, 12)
    .map((m) => ({
      id: m.id,
      name: (m.name ?? m.id).replace(/\s*\(free\)\s*$/i, ""),
      context: m.context,
    }));
}
