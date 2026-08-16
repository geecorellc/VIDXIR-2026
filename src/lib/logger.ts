/**
 * Structured logging (§41).
 *
 * Every log line carries the identifiers needed to reconstruct one video's
 * journey: traceId, userId, channelId, projectId, jobId, stage, provider,
 * status, durationMs. `child()` binds context once so call sites stay readable.
 *
 * Secrets are redacted by key name before serialisation — a logger that prints
 * an access token is a credential leak, and OAuth tokens pass through these
 * code paths constantly.
 */
import { randomUUID } from "node:crypto";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export interface LogContext {
  traceId?: string;
  userId?: string;
  channelId?: string;
  projectId?: string;
  jobId?: string;
  stage?: string;
  provider?: string;
  status?: string;
  durationMs?: number;
  component?: string;
  [key: string]: unknown;
}

/** Keys whose values are never printed, matched case-insensitively. */
const REDACT_PATTERN =
  /(password|secret|token|apikey|api_key|authorization|cookie|credential|refresh|access_key)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth-limit]";
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      // Preserve provider error codes attached by our own error classes.
      ...("code" in value ? { code: (value as { code?: unknown }).code } : {}),
    };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_PATTERN.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Log configuration is read from raw `process.env` rather than `lib/env` so the
 * logger works before (and during) environment validation failures.
 */
function configuredLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL;
  return raw && raw in LEVEL_ORDER ? (raw as LogLevel) : "info";
}

function prettyFormat(): boolean {
  return process.env.LOG_FORMAT === "pretty";
}

/** ASCII escape (0x1B), built at runtime to keep this source plain ASCII. */
const ESC = String.fromCharCode(27);

const ANSI = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[90m`,
} as const;

const LEVEL_COLOR: Record<LogLevel, string> = {
  trace: `${ESC}[90m`,
  debug: `${ESC}[36m`,
  info: `${ESC}[32m`,
  warn: `${ESC}[33m`,
  error: `${ESC}[31m`,
};

export interface Logger {
  trace(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** Returns a logger with additional bound context. */
  child(context: LogContext): Logger;
  /** The bound context, for propagating traceId into job payloads. */
  readonly context: LogContext;
}

function emit(level: LogLevel, message: string, context: LogContext): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel()]) return;

  const payload = redact(context) as Record<string, unknown>;
  const toStderr = LEVEL_ORDER[level] >= LEVEL_ORDER.warn;
  const line = prettyFormat()
    ? formatPretty(level, message, payload)
    : JSON.stringify({
        ts: new Date().toISOString(),
        level,
        msg: message,
        ...payload,
      });

  if (toStderr) process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

function formatPretty(
  level: LogLevel,
  message: string,
  payload: Record<string, unknown>,
): string {
  const time = new Date().toISOString().slice(11, 23);
  const tag = `${LEVEL_COLOR[level]}${level.toUpperCase().padEnd(5)}${ANSI.reset}`;
  const extras = Object.entries(payload)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${ANSI.dim}${k}=${ANSI.reset}${stringify(v)}`)
    .join(" ");
  return `${ANSI.dim}${time}${ANSI.reset} ${tag} ${message}${extras ? " " + extras : ""}`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function makeLogger(bound: LogContext): Logger {
  return {
    context: bound,
    trace: (m, c) => emit("trace", m, { ...bound, ...c }),
    debug: (m, c) => emit("debug", m, { ...bound, ...c }),
    info: (m, c) => emit("info", m, { ...bound, ...c }),
    warn: (m, c) => emit("warn", m, { ...bound, ...c }),
    error: (m, c) => emit("error", m, { ...bound, ...c }),
    child: (c) => makeLogger({ ...bound, ...c }),
  };
}

/** Root logger. Prefer `logger.child({...})` at the top of each operation. */
export const logger: Logger = makeLogger({});

/** Fresh correlation id for a request, job chain or pipeline run. */
export function newTraceId(): string {
  return randomUUID();
}

/**
 * Time an operation and log its outcome with a duration. Errors are logged and
 * rethrown — this measures, it does not swallow.
 */
export async function timed<T>(
  log: Logger,
  message: string,
  fn: () => Promise<T>,
  context: LogContext = {},
): Promise<T> {
  const start = process.hrtime.bigint();
  const ms = () => Number((process.hrtime.bigint() - start) / 1_000_000n);
  try {
    const result = await fn();
    log.info(message, { ...context, status: "ok", durationMs: ms() });
    return result;
  } catch (error) {
    log.error(message, {
      ...context,
      status: "error",
      durationMs: ms(),
      error,
    });
    throw error;
  }
}
