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

/**
 * Credential shapes that appear *inside* string values (§15).
 *
 * Key-name redaction only catches a secret that arrived as its own field. The
 * ways a credential actually reaches a log line are messier: a provider error
 * message that quotes the request URL, an OAuth redirect carrying
 * `?access_token=`, an `Authorization: Bearer` header echoed back in a 401 body.
 * Each of those is a string value under an innocent key like `message` or `url`,
 * and the key-name pass sees nothing wrong with it.
 *
 * These patterns are recognisable prefixes rather than a general entropy test —
 * a heuristic that scrubbed any long random-looking string would also scrub the
 * UUIDs that every correlation field is made of, and destroy the traceability
 * §15 is asking for.
 */
const VALUE_PATTERNS: readonly RegExp[] = [
  // Query/form parameters that name a credential, e.g. `?access_token=ya29...`.
  /\b(access_token|refresh_token|id_token|client_secret|api_key|apikey|password)=[^&\s"']+/gi,
  // `Authorization: Bearer <token>` and bare `Bearer <token>`.
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  // `Basic <base64>` credentials.
  /\bBasic\s+[A-Za-z0-9+/]{8,}=*/gi,
  // Provider key prefixes: Stripe (live/test secret, restricted, webhook),
  // OpenAI/Anthropic/Deepgram-style `sk-`, Google OAuth refresh tokens, and JWTs.
  /\b(?:sk_live|sk_test|rk_live|rk_test|whsec)_[A-Za-z0-9]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bya29\.[A-Za-z0-9._-]{8,}/g,
  /\b1\/\/[A-Za-z0-9._-]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Credentials embedded in a URL's userinfo, e.g. `postgres://user:pw@host`.
  /\b([a-z][a-z0-9+.-]*):\/\/[^/\s:@]+:[^/\s@]+@/gi,
];

/**
 * Scrub credential shapes out of a string, preserving the surrounding text so
 * the message remains diagnosable.
 */
export function redactValue(value: string): string {
  let out = value;
  for (const pattern of VALUE_PATTERNS) {
    out = out.replace(pattern, (match) => {
      // Keep the part that identifies *what* was redacted where it is a
      // name=value or scheme://user: shape, and drop the credential itself.
      const named = /^([A-Za-z_]+)=/.exec(match);
      if (named) return `${named[1]}=[redacted]`;
      const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(match);
      if (scheme) return `${scheme[1]}://[redacted]@`;
      const prefix = /^(Bearer|Basic)\s/i.exec(match);
      if (prefix) return `${prefix[1]} [redacted]`;
      return "[redacted]";
    });
  }
  return out;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth-limit]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactValue(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactValue(value.message),
      // Stacks are kept — they are the diagnostic §14 wants in logs and never in
      // a response — but a stack frame can quote an argument, so it is scrubbed
      // on the same terms as any other string.
      stack: value.stack ? redactValue(value.stack) : value.stack,
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
  // Messages are literals at almost every call site, but not all — a few
  // interpolate a provider detail — so they go through the same scrub.
  const safeMessage = redactValue(message);
  const toStderr = LEVEL_ORDER[level] >= LEVEL_ORDER.warn;
  const line = prettyFormat()
    ? formatPretty(level, safeMessage, payload)
    : JSON.stringify({
        ts: new Date().toISOString(),
        level,
        msg: safeMessage,
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
