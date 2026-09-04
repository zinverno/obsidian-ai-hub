import { requestUrl } from "obsidian";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import {
  COMPANION_PROTOCOL_HEADER,
  COMPANION_PROTOCOL_VERSION,
} from "./types";
import type {
  CompanionReconciliationPlan,
  CompanionServerStatus,
  CompanionSettings,
  CompanionSyncBatch,
  CompanionSyncBatchResult,
} from "./types";
import { isLocalCompanionEndpoint } from "./settings";

export type CompanionClientErrorCode =
  | "CONFIGURATION_ERROR"
  | "AUTH_REQUIRED"
  | "PROTOCOL_VERSION_MISMATCH"
  | "DESCRIPTOR_MISMATCH"
  | "STALE_GENERATION"
  | "INVALID_RESPONSE"
  | "TIMEOUT"
  | "ABORTED"
  | "UNREACHABLE"
  | "SERVER_ERROR";

export class CompanionClientError extends Error {
  constructor(readonly code: CompanionClientErrorCode, readonly status = 0) {
    super(`Companion request failed (${code}).`);
    this.name = code === "TIMEOUT" ? "TimeoutError" : "CompanionClientError";
  }
}

export type CompanionRequest = (request: RequestUrlParam | string) => Promise<RequestUrlResponse>;

function endpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CompanionClientError("CONFIGURATION_ERROR");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new CompanionClientError("CONFIGURATION_ERROR");
  }
  if (!isLocalCompanionEndpoint(url.toString()) && url.protocol !== "https:") {
    throw new CompanionClientError("CONFIGURATION_ERROR");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function errorCode(status: number, body: unknown): CompanionClientErrorCode {
  const code = body && typeof body === "object" && "error" in body &&
    body.error && typeof body.error === "object" && "code" in body.error
    ? (body.error as { code?: unknown }).code
    : undefined;
  if (status === 401) return "AUTH_REQUIRED";
  if (code === "PROTOCOL_VERSION_MISMATCH") return "PROTOCOL_VERSION_MISMATCH";
  if (code === "DESCRIPTOR_MISMATCH") return "DESCRIPTOR_MISMATCH";
  if (code === "STALE_GENERATION") return "STALE_GENERATION";
  return status >= 500 ? "SERVER_ERROR" : "INVALID_RESPONSE";
}

export class CompanionClient {
  private readonly baseUrl: string;

  constructor(
    private readonly settings: CompanionSettings,
    private readonly performRequest: CompanionRequest = requestUrl,
  ) {
    this.baseUrl = endpoint(settings.endpoint);
    if (!settings.token.trim() || !Number.isSafeInteger(settings.timeoutMs) || settings.timeoutMs < 500) {
      throw new CompanionClientError("CONFIGURATION_ERROR");
    }
  }

  status(signal?: AbortSignal): Promise<CompanionServerStatus> {
    return this.request("/v1/status", "GET", undefined, signal);
  }

  plan(vaultId: string, snapshot: CompanionSnapshotLike, signal?: AbortSignal): Promise<CompanionReconciliationPlan> {
    return this.request(`/v1/vaults/${encodeURIComponent(vaultId)}/reconcile/plan`, "POST", {
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      generation: snapshot.generation,
      descriptor: snapshot.descriptor,
      notes: snapshot.notes.map((note) => ({
        path: note.path,
        contentHash: note.contentHash,
        chunks: note.chunks.map((chunk) => ({ chunkId: chunk.chunkId, contentHash: chunk.contentHash })),
      })),
    }, signal);
  }

  applyBatch(vaultId: string, batch: CompanionSyncBatch, signal?: AbortSignal): Promise<CompanionSyncBatchResult> {
    return this.request(`/v1/vaults/${encodeURIComponent(vaultId)}/sync/batch`, "POST", batch, signal);
  }

  private async request<T>(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new CompanionClientError("ABORTED");
    let timer = 0;
    let abortListener: (() => void) | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = window.setTimeout(() => reject(new CompanionClientError("TIMEOUT")), this.settings.timeoutMs);
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(new CompanionClientError("ABORTED"));
      signal?.addEventListener("abort", abortListener, { once: true });
    });
    let response: RequestUrlResponse;
    try {
      const request = this.performRequest({
        url: `${this.baseUrl}${path}`,
        method,
        contentType: "application/json",
        headers: {
          Authorization: `Bearer ${this.settings.token}`,
          [COMPANION_PROTOCOL_HEADER]: String(COMPANION_PROTOCOL_VERSION),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        throw: false,
      }).catch(() => {
        throw new CompanionClientError("UNREACHABLE");
      });
      response = await Promise.race([request, timeout, aborted]);
    } finally {
      window.clearTimeout(timer);
      if (abortListener) signal?.removeEventListener("abort", abortListener);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text) as unknown;
    } catch {
      throw new CompanionClientError("INVALID_RESPONSE", response.status);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new CompanionClientError(errorCode(response.status, parsed), response.status);
    }
    if (!parsed || typeof parsed !== "object" || (parsed as { protocolVersion?: unknown }).protocolVersion !== COMPANION_PROTOCOL_VERSION) {
      throw new CompanionClientError("PROTOCOL_VERSION_MISMATCH", response.status);
    }
    return parsed as T;
  }
}

interface CompanionSnapshotLike {
  generation: number;
  descriptor: CompanionSyncBatch["descriptor"];
  notes: Array<{
    path: string;
    contentHash: string;
    chunks: Array<{ chunkId: string; contentHash: string }>;
  }>;
}
