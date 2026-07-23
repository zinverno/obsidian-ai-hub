import { requestUrl } from "obsidian";
import type { RequestUrlResponse } from "obsidian";
import { t as tr } from "../i18n";
import type {
  EmbeddingProvider,
  EmbeddingProviderId,
} from "./types";

const EMBEDDING_TIMEOUT_MS = 30_000;
const EMBEDDING_BATCH_SIZE = 64;
const FLOAT32_MAX = 3.4028234663852886e38;

function createTimeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

export function parseEmbeddingBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(
      tr("Base URL embeddings должен быть корректным HTTP(S)-адресом."),
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      tr("Base URL embeddings должен быть корректным HTTP(S)-адресом."),
    );
  }
  if (url.search) {
    throw new Error(
      tr("Base URL embeddings не должен содержать query parameters."),
    );
  }
  if (url.hash) {
    throw new Error(tr("Base URL embeddings не должен содержать fragment."));
  }
  return url;
}

export function buildEmbeddingEndpoint(
  baseUrl: string,
  endpoint: string,
): string {
  const url = parseEmbeddingBaseUrl(baseUrl);
  const baseParts = url.pathname.split("/").filter(Boolean);
  const endpointParts = endpoint.split("/").filter(Boolean);
  const alreadyHasEndpoint =
    endpointParts.length <= baseParts.length &&
    endpointParts.every(
      (part, index) =>
        baseParts[baseParts.length - endpointParts.length + index] === part,
    );

  const resultParts = alreadyHasEndpoint
    ? baseParts
    : [...baseParts, ...endpointParts];
  url.pathname = `/${resultParts.join("/")}`;
  return url.toString();
}

function httpError(status: number): Error {
  if (status === 401 || status === 403) {
    return new Error(
      tr("Ошибка авторизации embeddings (HTTP {code}). Проверьте API-ключ.", {
        code: status,
      }),
    );
  }
  if (status === 429) {
    return new Error(
      tr("Лимит запросов embeddings исчерпан (HTTP 429). Повторите позже."),
    );
  }
  if (status >= 500) {
    return new Error(
      tr("Сервер embeddings временно недоступен (HTTP {code}).", {
        code: status,
      }),
    );
  }
  return new Error(
    tr("Embeddings API вернул HTTP {code}. Проверьте URL, модель и настройки.", {
      code: status,
    }),
  );
}

/**
 * requestUrl avoids browser CORS restrictions in desktop and mobile Obsidian.
 * requestUrl cannot abort an in-flight request. The timeout only limits how
 * long the caller waits; the HTTP operation may still settle in the background.
 * Promise.race keeps rejection handlers attached, so a late success or failure
 * cannot update the caller and does not become an unhandled rejection.
 */
export async function requestEmbeddingJson(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutMs: number = EMBEDDING_TIMEOUT_MS,
): Promise<unknown> {
  let timeoutId: number | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(
        createTimeoutError(
          tr("Таймаут запроса embeddings. Проверьте сервер и URL."),
        ),
      );
    }, timeoutMs);
  });

  const requestPromise: Promise<RequestUrlResponse> = Promise.resolve().then(
    () =>
      requestUrl({
        url,
        method: "POST",
        contentType: "application/json",
        headers,
        body: JSON.stringify(body),
        throw: false,
      }),
  );

  let response: RequestUrlResponse;
  try {
    response = await Promise.race([requestPromise, timeoutPromise]);
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw error;
    }
    throw new Error(
      tr("Не удалось подключиться к серверу embeddings. Проверьте URL и доступность сервера."),
    );
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }

  if (response.status < 200 || response.status >= 300) {
    throw httpError(response.status);
  }

  try {
    return JSON.parse(response.text) as unknown;
  } catch {
    throw new Error(tr("Embeddings API вернул некорректный JSON."));
  }
}

export function validateEmbeddingVectors(
  rawVectors: unknown,
  expectedCount: number,
  expectedDimensions?: number,
): Float32Array[] {
  if (!Array.isArray(rawVectors) || rawVectors.length === 0) {
    throw new Error(tr("Embeddings API вернул пустой ответ."));
  }
  if (rawVectors.length !== expectedCount) {
    throw new Error(
      tr("Количество embeddings не совпало: ожидалось {expected}, получено {actual}.", {
        expected: expectedCount,
        actual: rawVectors.length,
      }),
    );
  }

  let dimensions = expectedDimensions;
  const validatedVectors: number[][] = rawVectors.map(
    (rawVector, vectorIndex) => {
      if (!Array.isArray(rawVector) || rawVector.length === 0) {
        throw new Error(
          tr("Embedding #{n} пуст или имеет неверный формат.", {
            n: vectorIndex + 1,
          }),
        );
      }

      if (dimensions === undefined) dimensions = rawVector.length;
      if (rawVector.length !== dimensions) {
        throw new Error(
          tr("Размерность embeddings не совпала: ожидалось {expected}, получено {actual}.", {
            expected: dimensions,
            actual: rawVector.length,
          }),
        );
      }

      const vector: number[] = [];
      for (let valueIndex = 0; valueIndex < rawVector.length; valueIndex++) {
        const value = rawVector[valueIndex];
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(
            tr("Embedding #{vector} содержит некорректное число в позиции {value}.", {
              vector: vectorIndex + 1,
              value: valueIndex + 1,
            }),
          );
        }
        if (Math.abs(value) > FLOAT32_MAX) {
          throw new Error(
            tr("Embedding #{vector} содержит число вне диапазона Float32 в позиции {value}.", {
              vector: vectorIndex + 1,
              value: valueIndex + 1,
            }),
          );
        }
        vector.push(value);
      }
      return vector;
    },
  );

  return validatedVectors.map((vector) => Float32Array.from(vector));
}

export function parseOpenAIEmbeddingResponse(
  payload: unknown,
  expectedCount: number,
): unknown[] {
  if (!payload || typeof payload !== "object") {
    throw new Error(tr("Embeddings API вернул ответ неверного формата."));
  }

  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(tr("Embeddings API вернул пустой ответ."));
  }
  if (data.length !== expectedCount) {
    throw new Error(
      tr("Количество embeddings не совпало: ожидалось {expected}, получено {actual}.", {
        expected: expectedCount,
        actual: data.length,
      }),
    );
  }

  const items = data.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error(tr("Embeddings API вернул ответ неверного формата."));
    }
    return item as { index?: unknown; embedding?: unknown };
  });

  const hasIndices = items.some((item) => item.index !== undefined);
  if (!hasIndices) return items.map((item) => item.embedding);

  const ordered = new Array<unknown>(expectedCount);
  const seenIndices = new Set<number>();
  for (const item of items) {
    if (
      !Number.isInteger(item.index) ||
      (item.index as number) < 0 ||
      (item.index as number) >= expectedCount ||
      seenIndices.has(item.index as number)
    ) {
      throw new Error(tr("Embeddings API вернул некорректные индексы результатов."));
    }
    seenIndices.add(item.index as number);
    ordered[item.index as number] = item.embedding;
  }

  if (seenIndices.size !== expectedCount) {
    throw new Error(tr("Embeddings API вернул неполный набор результатов."));
  }
  return ordered;
}

export function parseOllamaEmbeddingResponse(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    throw new Error(tr("Ollama вернул ответ embeddings неверного формата."));
  }
  return (payload as { embeddings?: unknown }).embeddings;
}

export abstract class BaseEmbeddingProvider implements EmbeddingProvider {
  abstract readonly id: EmbeddingProviderId;
  readonly model: string;
  private cachedDimensions: number | undefined;

  protected constructor(model: string) {
    this.model = model;
  }

  protected abstract embedBatch(texts: string[]): Promise<unknown>;

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!Array.isArray(texts) || texts.length === 0) {
      throw new Error(tr("Передайте хотя бы один текст для embeddings."));
    }
    if (texts.some((text) => typeof text !== "string")) {
      throw new Error(tr("Все входы embeddings должны быть строками."));
    }

    const result: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
      const batch = texts.slice(start, start + EMBEDDING_BATCH_SIZE);
      const rawVectors = await this.embedBatch(batch);
      const vectors = validateEmbeddingVectors(
        rawVectors,
        batch.length,
        this.cachedDimensions,
      );
      if (this.cachedDimensions === undefined) {
        this.cachedDimensions = vectors[0].length;
      }
      result.push(...vectors);
    }
    return result;
  }

  async dimensions(): Promise<number> {
    if (this.cachedDimensions !== undefined) return this.cachedDimensions;
    const [vector] = await this.embed(["Vault Audit AI embedding test"]);
    return vector.length;
  }
}
