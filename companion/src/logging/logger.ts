import type { LogLevel } from "../config.js";

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function redact(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    let result = value.replace(/Bearer\s+[^\s"']+/giu, "Bearer [REDACTED]");
    for (const secret of secrets) {
      if (secret) result = result.split(secret).join("[REDACTED]");
    }
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = /authorization|token|api.?key|secret/iu.test(key)
        ? "[REDACTED]"
        : redact(item, secrets);
    }
    return output;
  }
  return value;
}

export function createLogger(level: LogLevel, secrets: readonly string[] = []): Logger {
  const threshold = LEVELS[level];
  const write = (candidate: LogLevel, message: string, context?: Record<string, unknown>): void => {
    if (LEVELS[candidate] < threshold) return;
    const entry: Record<string, unknown> = {
      time: new Date().toISOString(),
      level: candidate,
      message: redact(message, secrets),
    };
    if (context) entry.context = redact(context, secrets);
    process[candidate === "debug" ? "stdout" : candidate === "info" ? "stdout" : "stderr"].write(`${JSON.stringify(entry)}\n`);
  };
  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
  };
}
