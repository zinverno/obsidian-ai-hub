import { isIP } from "node:net";
import { resolve } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface McpConfig {
  enabled: boolean;
  token: string;
  vaultId: string;
  embeddingApiKey: string;
  embeddingTimeoutMs: number;
  bodyLimitBytes: number;
  allowedHosts?: string[];
}

export interface QdrantConfig {
  enabled: boolean;
  url: string;
  apiKey: string;
  timeoutMs: number;
  collectionPrefix: string;
  allowInsecureRemoteHttp: boolean;
}

export interface CompanionConfig {
  host: string;
  port: number;
  token: string;
  dataDir: string;
  allowRemoteBind: boolean;
  logLevel: LogLevel;
  bodyLimitBytes: number;
  mcp: McpConfig;
  qdrant?: QdrantConfig;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function booleanValue(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ConfigurationError(`${name} must be true or false.`);
}

function validHostname(host: string): boolean {
  if (host === "localhost" || isIP(host)) return true;
  if (host.length > 253 || host.includes("..")) return false;
  return host.split(".").every((label) =>
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label),
  );
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const raw = value?.trim() || String(fallback);
  if (!/^\d+$/u.test(raw)) {
    throw new ConfigurationError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigurationError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function validVaultId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

export function isLoopbackHost(host: string): boolean {
  if (host.toLowerCase() === "localhost" || host === "::1") return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  return false;
}

export function loadQdrantConfig(environment: NodeJS.ProcessEnv): QdrantConfig {
  const enabled = booleanValue(environment.QDRANT_ENABLED, false, "QDRANT_ENABLED");
  const allowInsecureRemoteHttp = booleanValue(
    environment.QDRANT_ALLOW_INSECURE_REMOTE_HTTP, false, "QDRANT_ALLOW_INSECURE_REMOTE_HTTP",
  );
  let url: URL;
  try {
    url = new URL(environment.QDRANT_URL?.trim() || "http://127.0.0.1:6333");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error();
    }
  } catch {
    throw new ConfigurationError("QDRANT_URL must be an HTTP(S) URL without credentials, query, or fragment.");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname.replace(/^\[|\]$/gu, "")) && !allowInsecureRemoteHttp) {
    throw new ConfigurationError("Non-loopback QDRANT_URL HTTP requires QDRANT_ALLOW_INSECURE_REMOTE_HTTP=true.");
  }
  const collectionPrefix = environment.QDRANT_COLLECTION_PREFIX?.trim() || "vault_audit";
  if (!/^[a-zA-Z0-9_]{1,32}$/u.test(collectionPrefix)) {
    throw new ConfigurationError("QDRANT_COLLECTION_PREFIX must contain 1 to 32 letters, digits, or underscores.");
  }
  const apiKey = environment.QDRANT_API_KEY?.trim() ?? "";
  if (!/^[\x20-\x7E]*$/u.test(apiKey)) throw new ConfigurationError("QDRANT_API_KEY must contain printable ASCII characters.");
  return {
    enabled, url: url.toString().replace(/\/$/u, ""),
    apiKey,
    timeoutMs: positiveInteger(environment.QDRANT_TIMEOUT_MS, 5000, "QDRANT_TIMEOUT_MS", 100, 120_000),
    collectionPrefix, allowInsecureRemoteHttp,
  };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): CompanionConfig {
  const host = environment.HOST?.trim() || "127.0.0.1";
  if (!validHostname(host)) throw new ConfigurationError("HOST must be a valid IP address or hostname.");
  const port = positiveInteger(environment.PORT, 27_124, "PORT", 1, 65_535);
  const token = environment.COMPANION_TOKEN?.trim() ?? "";
  if (!token) throw new ConfigurationError("COMPANION_TOKEN must be a non-empty secret.");
  const allowRemoteBind = booleanValue(environment.ALLOW_REMOTE_BIND, false, "ALLOW_REMOTE_BIND");
  if (!isLoopbackHost(host) && !allowRemoteBind) {
    throw new ConfigurationError("Non-loopback HOST requires ALLOW_REMOTE_BIND=true.");
  }
  const dataDirRaw = environment.DATA_DIR?.trim() || "./data";
  if (dataDirRaw.includes("\0")) throw new ConfigurationError("DATA_DIR is invalid.");
  const level = environment.LOG_LEVEL?.trim() || "info";
  if (!(["debug", "info", "warn", "error"] as const).includes(level as LogLevel)) {
    throw new ConfigurationError("LOG_LEVEL must be debug, info, warn, or error.");
  }
  const mcpEnabled = booleanValue(environment.MCP_ENABLED, false, "MCP_ENABLED");
  const mcpToken = environment.MCP_TOKEN?.trim() ?? "";
  const mcpVaultId = environment.MCP_VAULT_ID?.trim().toLowerCase() ?? "";
  if (mcpEnabled && !mcpToken) {
    throw new ConfigurationError("MCP_TOKEN must be a non-empty secret when MCP_ENABLED=true.");
  }
  if (mcpEnabled && !mcpVaultId) {
    throw new ConfigurationError("MCP_VAULT_ID is required when MCP_ENABLED=true.");
  }
  if (mcpVaultId && !validVaultId(mcpVaultId)) {
    throw new ConfigurationError("MCP_VAULT_ID must be a UUID.");
  }
  if (mcpToken && mcpToken === token) {
    throw new ConfigurationError("MCP_TOKEN must differ from COMPANION_TOKEN to preserve privilege separation.");
  }
  const allowedHosts = environment.MCP_ALLOWED_HOSTS?.split(",").map((value) => value.trim()).filter(Boolean)
    ?? ["localhost", "127.0.0.1", "[::1]", host.includes(":") ? `[${host}]` : host];
  if (allowedHosts.length === 0 || allowedHosts.some((value) => !validHostname(value.replace(/^\[|\]$/gu, "")))) {
    throw new ConfigurationError("MCP_ALLOWED_HOSTS must contain explicit hostnames or IP addresses, without schemes or ports.");
  }
  const qdrant = loadQdrantConfig(environment);
  if (qdrant.enabled && !mcpVaultId) throw new ConfigurationError("MCP_VAULT_ID is required when QDRANT_ENABLED=true.");
  return {
    host,
    port,
    token,
    dataDir: resolve(dataDirRaw),
    allowRemoteBind,
    logLevel: level as LogLevel,
    bodyLimitBytes: 16 * 1024 * 1024,
    qdrant,
    mcp: {
      enabled: mcpEnabled,
      token: mcpToken,
      vaultId: mcpVaultId,
      embeddingApiKey: environment.MCP_EMBEDDING_API_KEY?.trim() ?? "",
      embeddingTimeoutMs: positiveInteger(
        environment.MCP_EMBEDDING_TIMEOUT_MS,
        30_000,
        "MCP_EMBEDDING_TIMEOUT_MS",
        500,
        120_000,
      ),
      bodyLimitBytes: 1024 * 1024,
      allowedHosts,
    },
  };
}
