/**
 * Provider call accounting (§41).
 *
 * Every outbound call to a paid or quota-limited API writes one row to
 * `api_usage`. Two things depend on it:
 *
 *  - Cost control. §40 asks that development mode cannot "spend excessive
 *    credits"; you cannot enforce a budget you do not measure.
 *  - Diagnosis. When YouTube starts returning 403 quotaExceeded, the question is
 *    always "which operation burned the quota, for which user" — and that is a
 *    query, not a log grep.
 *
 * Recording never fails the caller. A provider call that succeeded but whose
 * accounting row could not be written is a bookkeeping problem, not a user-facing
 * one, so the error is logged and swallowed.
 */
import "server-only";
import { db } from "@/lib/db";
import { apiUsage } from "@/lib/db/schema";
import { errorCodeOf, isAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

const log = logger.child({ component: "provider-usage" });

export interface UsageContext {
  provider: string;
  operation: string;
  userId?: string | null;
  projectId?: string | null;
  jobId?: string | null;
  traceId?: string | null;
  model?: string | null;
}

export interface UsageMeasurement {
  /** Provider-specific units: tokens, characters, seconds, quota units. */
  quantity?: number | null;
  unit?: string | null;
  estimatedCostCents?: number | null;
  httpStatus?: number | null;
}

/**
 * Run `fn`, timing it, and record the outcome.
 *
 * The measurement is derived from the result so a caller does not have to
 * duplicate the call site: `measure` receives whatever `fn` returned.
 */
export async function withUsage<T>(
  context: UsageContext,
  fn: () => Promise<T>,
  measure?: (result: T) => UsageMeasurement,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    await record(context, {
      ok: true,
      durationMs: Date.now() - startedAt,
      ...(measure ? measure(result) : {}),
    });
    return result;
  } catch (error) {
    await record(context, {
      ok: false,
      durationMs: Date.now() - startedAt,
      errorCode: errorCodeOf(error),
      httpStatus: isAppError(error) ? error.status : null,
    });
    throw error;
  }
}

interface RecordInput extends UsageMeasurement {
  ok: boolean;
  durationMs: number;
  errorCode?: string | null;
}

async function record(context: UsageContext, input: RecordInput): Promise<void> {
  try {
    await db.insert(apiUsage).values({
      userId: context.userId ?? null,
      projectId: context.projectId ?? null,
      jobId: context.jobId ?? null,
      provider: context.provider,
      operation: context.operation,
      model: context.model ?? null,
      quantity: input.quantity ?? null,
      unit: input.unit ?? null,
      estimatedCostCents: input.estimatedCostCents ?? null,
      httpStatus: input.httpStatus ?? null,
      ok: input.ok,
      errorCode: input.errorCode ?? null,
      durationMs: input.durationMs,
      traceId: context.traceId ?? null,
    });
  } catch (error) {
    log.warn("failed to record provider usage", {
      provider: context.provider,
      operation: context.operation,
      error,
    });
  }
}
