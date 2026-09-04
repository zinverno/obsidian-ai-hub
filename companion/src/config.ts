import { isIP } from "node:net";
import { resolve } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface CompanionConfig {
  host: string;
  port: number;
  token: string;
  dataDir: string;
  allowRemoteBind: boolean;
  logLevel: LogLevel;
  bodyLimitBytes: number;
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

export function isLoopbackHost(host: string): boolean {
  if (host.toLowerCase() === "localhost" || host === "::1") return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  return false;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): CompanionConfig {
  const host = environment.HOST?.trim() || "127.0.0.1";
  if (!validHostname(host)) throw new ConfigurationError("HOST must be a valid IP address or hostname.");
  const rawPort = environment.PORT?.trim() || "27124";
  if (!/^\d+$/u.test(rawPort)) throw new ConfigurationError("PORT must be an integer from 1 to 65535.");
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigurationError("PORT must be an integer from 1 to 65535.");
  }
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
  return {
    host,
    port,
    token,
    dataDir: resolve(dataDirRaw),
    allowRemoteBind,
    logLevel: level as LogLevel,
    bodyLimitBytes: 16 * 1024 * 1024,
  };
}
