/**
 * POST /api/billing/webhook — Stripe's delivery endpoint (§24, §32, §34).
 *
 * This route is deliberately **not** wrapped in `handle()`. Two of that wrapper's
 * behaviours are wrong here:
 *
 *  - `assertSameOrigin` rejects requests with no `Origin` and no same-origin
 *    `Sec-Fetch-Site`. Stripe is a server, not a browser: it sends neither, so
 *    every delivery would be refused. The signature replaces CSRF protection
 *    entirely, and does it better — CSRF defends against a browser being tricked
 *    into sending a request, whereas the HMAC proves the request came from Stripe
 *    at all.
 *  - `handle` wraps the result in `{ data }`. Stripe only reads the status code,
 *    and the body is for a human tailing logs.
 *
 * There is no session on this request. Authentication *is* the signature, which is
 * why `verifyEvent` runs before the body is parsed or trusted for anything.
 *
 * Status codes are chosen for Stripe's retry behaviour, not for tidiness:
 *
 *  - **200** — verified and processed, *including* duplicates, stale deliveries and
 *    event types Tally does not use. Those are successful outcomes; a non-2xx would
 *    make Stripe redeliver an event that will never be applied, and repeated
 *    failures eventually disable the endpoint.
 *  - **403** — signature verification failed. Stripe does not retry 4xx, which is
 *    right: a body that fails the HMAC will never start passing it.
 *  - **503** — the webhook secret is not configured. Retryable, and an operator
 *    setting the variable fixes the backlog.
 *  - **500** — the event verified but processing threw (a database outage, say).
 *    Stripe retries with backoff for up to three days, so a real payment is not
 *    lost to a transient failure.
 *
 * Nothing here logs the request body, the signature header, or any part of the
 * secret.
 */
import { NextResponse, type NextRequest } from "next/server";
import { isAppError } from "@/lib/errors";
import { logger, newTraceId } from "@/lib/logger";
import { processEvent, verifyEvent } from "@/lib/billing/webhook";

/**
 * Node runtime, not edge: signature verification needs `crypto` and the handler
 * reaches Postgres.
 */
export const runtime = "nodejs";

/**
 * Largest body accepted. Stripe events are a few kilobytes; the largest documented
 * payloads are well under this. A cap matters because this endpoint is
 * unauthenticated until the HMAC is checked, and the HMAC cannot be checked without
 * first reading the body.
 */
const MAX_BODY_BYTES = 1024 * 1024;

export async function POST(request: NextRequest) {
  const traceId = newTraceId();
  const log = logger.child({
    traceId,
    component: "api",
    path: "/api/billing/webhook",
  });

  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > MAX_BODY_BYTES) {
    return json({ error: "Payload too large." }, 413, traceId);
  }

  /**
   * The **raw** body, read as text and never parsed before verification. Stripe
   * signs the exact bytes it sent, so a `request.json()` round trip through
   * `JSON.stringify` would produce different bytes and fail the HMAC on every
   * legitimate delivery.
   */
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return json({ error: "Could not read request body." }, 400, traceId);
  }

  if (rawBody.length > MAX_BODY_BYTES) {
    return json({ error: "Payload too large." }, 413, traceId);
  }

  const signature = request.headers.get("stripe-signature");

  try {
    const event = verifyEvent(rawBody, signature);
    const outcome = await processEvent(event);

    log.info("webhook processed", {
      eventType: outcome.eventType,
      applied: outcome.applied,
      skipReason: outcome.skipReason,
      ...(outcome.userId ? { userId: outcome.userId } : {}),
    });

    return json(
      {
        received: true,
        applied: outcome.applied,
        skipReason: outcome.skipReason,
      },
      200,
      traceId,
    );
  } catch (error) {
    if (isAppError(error)) {
      /**
       * `ForbiddenError` (403, bad signature) and `NotConfiguredError` (503, no
       * secret) both arrive here with the right status already attached. Logged at
       * warn with the code only — the body that failed verification is exactly the
       * thing not to write into logs.
       */
      log.warn("webhook rejected", {
        status: "error",
        httpStatus: error.status,
        errorCode: error.code,
      });
      return json({ error: error.code }, error.status, traceId);
    }

    // Unexpected: the event was genuine and processing failed. 500 so Stripe
    // retries, and the full error is logged for the operator.
    log.error("webhook processing failed", { error });
    return json({ error: "internal_error" }, 500, traceId);
  }
}

function json(
  body: Record<string, unknown>,
  status: number,
  traceId: string,
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "x-tally-trace-id": traceId },
  });
}
