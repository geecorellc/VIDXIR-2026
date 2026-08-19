/**
 * Error taxonomy (§30).
 *
 * Every failure mode the spec enumerates maps to a class here. Two properties
 * matter to callers:
 *   - `code`: a stable string persisted on jobs/projects and shown in the UI,
 *     so a user sees "YouTube rejected the upload" rather than a stack trace.
 *   - `retryable`: whether a worker should schedule another attempt. Retrying a
 *     403 forever burns quota; not retrying a 429 loses work.
 *
 * `NotConfiguredError` is the load-bearing one for §42/§48: a missing credential
 * produces a distinct, user-visible configuration state — never a silent
 * fallback that pretends the work succeeded.
 */

export type ErrorCode =
  | "validation_failed"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "plan_limit_reached"
  | "feature_not_in_plan"
  | "provider_not_configured"
  | "provider_auth_failed"
  | "provider_out_of_credit"
  | "provider_rate_limited"
  | "provider_timeout"
  | "provider_scope_missing"
  | "provider_failed"
  | "oauth_token_expired"
  | "oauth_reauth_required"
  | "youtube_upload_failed"
  | "render_failed"
  | "voice_generation_failed"
  | "transcription_failed"
  | "asset_missing"
  | "storage_failed"
  | "quality_check_failed"
  | "publish_blocked_dev_mode"
  | "invalid_state_transition"
  | "internal_error";

export interface AppErrorOptions {
  code: ErrorCode;
  message: string;
  /** HTTP status used when this surfaces through an API route. */
  status?: number;
  retryable?: boolean;
  /** Safe-to-display extra context. Never put credentials in here. */
  details?: Record<string, unknown>;
  cause?: unknown;
  /** Seconds to wait before retrying, when the provider told us. */
  retryAfterSeconds?: number;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;

  constructor(options: AppErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.status = options.status ?? 500;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  /** Body shape returned by API routes. Deliberately minimal. */
  toResponseBody(): {
    error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
  } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Request-level errors
// ---------------------------------------------------------------------------

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: "validation_failed", message, status: 400, details });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = "You must be signed in.") {
    super({ code: "unauthenticated", message, status: 401 });
  }
}

/**
 * Used for both "not your resource" and, deliberately, for missing resources
 * that belong to another tenant — leaking existence is an isolation leak (§34).
 */
export class ForbiddenError extends AppError {
  constructor(message = "You do not have access to this resource.") {
    super({ code: "forbidden", message, status: 403 });
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found.") {
    super({ code: "not_found", message, status: 404 });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: "conflict", message, status: 409, details });
  }
}

export class RateLimitedError extends AppError {
  constructor(retryAfterSeconds: number, message = "Too many requests.") {
    super({
      code: "rate_limited",
      message,
      status: 429,
      retryable: true,
      retryAfterSeconds,
      details: { retryAfterSeconds },
    });
  }
}

// ---------------------------------------------------------------------------
// Plan enforcement (§23)
// ---------------------------------------------------------------------------

export class PlanLimitError extends AppError {
  constructor(
    message: string,
    details: { limit: number | null; used: number; tier: string; resource: string },
  ) {
    super({ code: "plan_limit_reached", message, status: 402, details });
  }
}

export class FeatureNotInPlanError extends AppError {
  constructor(feature: string, tier: string) {
    super({
      code: "feature_not_in_plan",
      message: `Your ${tier} plan does not include this feature.`,
      status: 402,
      details: { feature, tier },
    });
  }
}

// ---------------------------------------------------------------------------
// Provider errors (§30, §42, §48)
// ---------------------------------------------------------------------------

/**
 * Thrown when a provider has no credentials. This is NOT a failure of the
 * feature — it is a configuration state, and the UI renders it as such with the
 * exact env var the operator needs to set.
 */
export class NotConfiguredError extends AppError {
  readonly provider: string;
  readonly missingEnvVars: string[];

  constructor(provider: string, missingEnvVars: string[], hint?: string) {
    super({
      code: "provider_not_configured",
      message:
        `${provider} is not configured. ` +
        `Set ${missingEnvVars.join(", ")} to enable it.` +
        (hint ? ` ${hint}` : ""),
      status: 503,
      retryable: false,
      details: { provider, missingEnvVars, hint },
    });
    this.provider = provider;
    this.missingEnvVars = missingEnvVars;
  }
}

export class ProviderAuthError extends AppError {
  constructor(provider: string, message?: string, cause?: unknown) {
    super({
      code: "provider_auth_failed",
      message:
        message ??
        `${provider} rejected our credentials. The API key may be invalid or revoked.`,
      status: 502,
      retryable: false,
      details: { provider },
      cause,
    });
  }
}

/**
 * The provider account has no credit or has hit a spend cap.
 *
 * Distinct from `ProviderAuthError` because the key is valid and the fix is
 * different — the operator has to top up an account, not rotate a credential.
 * Distinct from `ProviderRateLimitError` because waiting will not help. Treated
 * like a configuration problem in the UI for exactly that reason: it is a state
 * an operator resolves, not an error a user can retry past.
 */
export class ProviderOutOfCreditError extends AppError {
  readonly provider: string;

  constructor(provider: string, cause?: unknown) {
    super({
      code: "provider_out_of_credit",
      message:
        `${provider} rejected the request because the account is out of ` +
        `credit. Top up the ${provider} account to resume generation.`,
      status: 402,
      // Never retried: a queue of attempts against an empty balance is just a
      // queue of identical failures.
      retryable: false,
      details: { provider },
      cause,
    });
    this.provider = provider;
  }
}

export class ProviderRateLimitError extends AppError {
  constructor(provider: string, retryAfterSeconds = 60, cause?: unknown) {
    super({
      code: "provider_rate_limited",
      message: `${provider} rate limit reached. Retrying shortly.`,
      status: 503,
      retryable: true,
      retryAfterSeconds,
      details: { provider, retryAfterSeconds },
      cause,
    });
  }
}

/**
 * The credential is valid but the grant does not cover this call.
 *
 * Separate from `ProviderAuthError` (the credential is bad), from
 * `ProviderRateLimitError` (waiting helps) and from `ReauthRequiredError` (the
 * token is dead). Here the token works fine for everything else — only this
 * *operation* is outside what the user authorised, so the fix is a re-consent
 * with an additional scope, and retrying is pointless.
 *
 * Added in Phase 9 for revenue: without it, a channel authorised without
 * `yt-analytics-monetary.readonly` returns a 403 that looks like a quota error,
 * and the analytics job would retry it indefinitely instead of reporting the
 * permission state the dashboard needs to show.
 */
export class ProviderScopeError extends AppError {
  readonly provider: string;

  constructor(provider: string, message?: string, cause?: unknown) {
    super({
      code: "provider_scope_missing",
      message:
        message ??
        `${provider} refused this request because the connected account has not ` +
          `granted the required permission.`,
      status: 403,
      // Never retried: the grant will not change on its own.
      retryable: false,
      details: { provider },
      cause,
    });
    this.provider = provider;
  }
}

export class ProviderTimeoutError extends AppError {
  constructor(provider: string, timeoutMs: number, cause?: unknown) {
    super({
      code: "provider_timeout",
      message: `${provider} did not respond within ${Math.round(timeoutMs / 1000)}s.`,
      status: 504,
      retryable: true,
      details: { provider, timeoutMs },
      cause,
    });
  }
}

export class ProviderError extends AppError {
  constructor(
    provider: string,
    message: string,
    options: {
      retryable?: boolean;
      status?: number;
      cause?: unknown;
      /**
       * Extra diagnostic context (a stop reason, an upstream status). Merged
       * after `provider` so a caller cannot accidentally rename the field the
       * logs key on.
       */
      details?: Record<string, unknown>;
    } = {},
  ) {
    super({
      code: "provider_failed",
      message: `${provider}: ${message}`,
      status: options.status ?? 502,
      retryable: options.retryable ?? true,
      details: { ...options.details, provider },
      cause: options.cause,
    });
  }
}

// ---------------------------------------------------------------------------
// OAuth / YouTube (§6, §30)
// ---------------------------------------------------------------------------

export class OAuthTokenExpiredError extends AppError {
  constructor(channelId: string) {
    super({
      code: "oauth_token_expired",
      message: "The YouTube access token expired and is being refreshed.",
      status: 503,
      retryable: true,
      details: { channelId },
    });
  }
}

/** Refresh failed — only the user can fix this by reconnecting the channel. */
export class ReauthRequiredError extends AppError {
  constructor(channelId: string, reason?: string) {
    super({
      code: "oauth_reauth_required",
      message:
        "YouTube access for this channel has expired. Reconnect the channel to continue.",
      status: 401,
      retryable: false,
      details: { channelId, reason },
    });
  }
}

export class YouTubeUploadError extends AppError {
  constructor(message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super({
      code: "youtube_upload_failed",
      message: `YouTube upload failed: ${message}`,
      status: 502,
      retryable: options.retryable ?? true,
      cause: options.cause,
    });
  }
}

// ---------------------------------------------------------------------------
// Pipeline stage failures (§10, §30)
// ---------------------------------------------------------------------------

export class RenderError extends AppError {
  constructor(message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super({
      code: "render_failed",
      message: `Render failed: ${message}`,
      status: 502,
      retryable: options.retryable ?? true,
      cause: options.cause,
    });
  }
}

export class VoiceGenerationError extends AppError {
  constructor(message: string, cause?: unknown) {
    super({
      code: "voice_generation_failed",
      message: `Voiceover generation failed: ${message}`,
      status: 502,
      retryable: true,
      cause,
    });
  }
}

export class TranscriptionError extends AppError {
  constructor(message: string, cause?: unknown) {
    super({
      code: "transcription_failed",
      message: `Caption generation failed: ${message}`,
      status: 502,
      retryable: true,
      cause,
    });
  }
}

export class AssetMissingError extends AppError {
  constructor(what: string) {
    super({
      code: "asset_missing",
      message: `Required asset is missing: ${what}`,
      status: 409,
      retryable: false,
      details: { what },
    });
  }
}

export class StorageError extends AppError {
  constructor(message: string, cause?: unknown) {
    super({
      code: "storage_failed",
      message: `Storage operation failed: ${message}`,
      status: 502,
      retryable: true,
      cause,
    });
  }
}

export class QualityCheckFailedError extends AppError {
  constructor(findings: Array<{ code: string; message: string }>) {
    super({
      code: "quality_check_failed",
      message:
        "Pre-publish checks did not pass. Resolve the findings before publishing.",
      status: 409,
      retryable: false,
      details: { findings },
    });
  }
}

/** §40 — dev mode refused a real publish. Not a bug; a guard rail. */
export class PublishBlockedError extends AppError {
  constructor() {
    super({
      code: "publish_blocked_dev_mode",
      message:
        "Publishing is blocked because TALLY_BLOCK_REAL_PUBLISH is enabled. " +
        "Disable it to publish to a real YouTube channel.",
      status: 409,
      retryable: false,
    });
  }
}

export class InvalidStateTransitionError extends AppError {
  constructor(from: string, to: string) {
    super({
      code: "invalid_state_transition",
      message: `Cannot move a project from ${from} to ${to}.`,
      status: 409,
      retryable: false,
      details: { from, to },
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Whether a worker should retry after this error. Unknown errors are retried. */
export function isRetryable(error: unknown): boolean {
  if (isAppError(error)) return error.retryable;
  return true;
}

export function errorCodeOf(error: unknown): ErrorCode {
  return isAppError(error) ? error.code : "internal_error";
}

/**
 * A message safe to show a user. Unknown errors are deliberately generic — an
 * upstream exception string can contain URLs with embedded credentials.
 */
export function userMessageOf(error: unknown): string {
  if (isAppError(error)) return error.message;
  return "Something went wrong. The error has been logged.";
}

/**
 * Codes that stop work until an operator changes something, rather than until a
 * user retries. Both map to the `blocked_not_configured` job status.
 */
const BLOCKING_CODES: readonly string[] = [
  "provider_not_configured",
  "provider_out_of_credit",
];

/** True when this code means "an operator must act", not "try again". */
export function isBlockingCode(code: string | null | undefined): boolean {
  return code !== null && code !== undefined && BLOCKING_CODES.includes(code);
}

/**
 * Headline for a `blocked_not_configured` status.
 *
 * One status, two causes, and the difference is the whole point of the message:
 * a missing key is fixed by setting an environment variable, an empty balance by
 * paying a provider. Telling someone with a valid key to "add credentials" sends
 * them to check something that is already correct.
 *
 * Lives here, beside the codes, because both the Research screen and the video
 * stage list render this state and a second copy would drift.
 */
export function blockedReasonLabel(
  errorCode: string | null | undefined,
  provider?: string | null,
): string {
  const who = provider ?? "A provider";
  if (errorCode === "provider_out_of_credit") {
    return `${who} is out of credit`;
  }
  return provider ? `${who} is not configured` : "A provider is not configured";
}
