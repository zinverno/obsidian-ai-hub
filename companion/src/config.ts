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

export interface CompanionConfig {
  host: string;
  port: number;
  token: string;
  dataDir: string;
  allowRemoteBind: boolean;
  logLevel: LogLevel;
  bodyLimitBytes: number;
  mcp: McpConfig;
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
  return {
    host,
    port,
    token,
    dataDir: resolve(dataDirRaw),
    allowRemoteBind,
    logLevel: level as LogLevel,
    bodyLimitBytes: 16 * 1024 * 1024,
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
