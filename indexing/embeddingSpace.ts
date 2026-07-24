import { IndexingValidationError } from "./errors";
import type { EmbeddingSpaceDescriptor } from "./types";

function requiredComponent(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new IndexingValidationError(
      `Embedding space ${label} must be a non-empty string.`,
    );
  }
  return value.trim();
}

export function normalizeEmbeddingBaseUrl(value: string): string {
  const raw = requiredComponent(value, "baseUrl");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IndexingValidationError(
      "Embedding space baseUrl must be a valid HTTP(S) URL.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new IndexingValidationError(
      "Embedding space baseUrl must use HTTP or HTTPS.",
    );
  }
  if (url.username || url.password) {
    throw new IndexingValidationError(
      "Embedding space baseUrl must not contain credentials.",
    );
  }

  url.search = "";
  url.hash = "";
  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname === "/") pathname = "";
  return `${url.protocol}//${url.host}${pathname}`;
}

export function buildEmbeddingSpaceId(
  descriptor: EmbeddingSpaceDescriptor,
): string {
  const providerId = requiredComponent(descriptor?.providerId, "providerId");
  const model = requiredComponent(descriptor?.model, "model");
  if (
    !Number.isSafeInteger(descriptor?.dimensions) ||
    descriptor.dimensions <= 0
  ) {
    throw new IndexingValidationError(
      "Embedding space dimensions must be a positive safe integer.",
    );
  }
  const endpoint = normalizeEmbeddingBaseUrl(descriptor.baseUrl);
  const encode = (value: string): string => encodeURIComponent(value);
  return [
    "embedding-space:v1",
    `provider=${encode(providerId)}`,
    `model=${encode(model)}`,
    `endpoint=${encode(endpoint)}`,
    `dimensions=${descriptor.dimensions}`,
  ].join("|");
}
