import type { SemanticDescriptor } from "../protocol/types.js";
import { semanticSearchUnavailable } from "./errors.js";

function required(value: string): string {
  const result = value.trim();
  if (!result) throw semanticSearchUnavailable();
  return result;
}

export function normalizeDescriptorBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(required(value));
  } catch {
    throw semanticSearchUnavailable();
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw semanticSearchUnavailable();
  }
  url.search = "";
  url.hash = "";
  let pathname = url.pathname.replace(/\/+$/u, "");
  if (pathname === "/") pathname = "";
  return `${url.protocol}//${url.host}${pathname}`;
}

export function buildDescriptorEmbeddingSpaceId(descriptor: SemanticDescriptor): string {
  if (!Number.isSafeInteger(descriptor.dimensions) || descriptor.dimensions <= 0) {
    throw semanticSearchUnavailable();
  }
  const encode = (value: string): string => encodeURIComponent(value);
  return [
    "embedding-space:v1",
    `provider=${encode(required(descriptor.providerId))}`,
    `model=${encode(required(descriptor.model))}`,
    `endpoint=${encode(normalizeDescriptorBaseUrl(descriptor.baseUrl))}`,
    `dimensions=${descriptor.dimensions}`,
  ].join("|");
}

export function assertCompatibleDescriptor(descriptor: SemanticDescriptor): void {
  if (
    descriptor.normalized !== true ||
    descriptor.baseUrl !== normalizeDescriptorBaseUrl(descriptor.baseUrl) ||
    descriptor.embeddingSpaceId !== buildDescriptorEmbeddingSpaceId(descriptor) ||
    !["openrouter", "openai-compatible", "ollama"].includes(descriptor.providerId)
  ) {
    throw semanticSearchUnavailable();
  }
}
