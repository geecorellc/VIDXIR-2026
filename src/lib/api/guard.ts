/**
 * API guards (§34, §36).
 *
 * Every authenticated route begins with `requireUser()` or `requireOnboarded()`.
 * Every route that reads or writes a user-owned row goes through one of the
 * `require*Access` helpers, which re-query with `userId` in the predicate — so
 * tenant isolation is a property of the query, not of remembering to check.
 *
 * `handle()` wraps a route body: it assigns a trace id, catches AppErrors into
 * their declared status codes, and logs unknown failures without leaking them.
 */
import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { channels, projects } from "@/lib/db/schema";
import {
  AppError,
  ForbiddenError,
  UnauthenticatedError,
  ValidationError,
  isAppError,
  userMessageOf,
} from "@/lib/errors";
import { logger, newTraceId, type Logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { getSession, type SessionUser } from "@/lib/auth/session";

export interface RequestContext {
  user: SessionUser;
  traceId: string;
  log: Logger;
}

/** Require a valid session. Throws UnauthenticatedError otherwise. */
export async function requireUser(): Promise<RequestContext> {
  const session = await getSession({ refresh: true });
  if (!session) throw new UnauthenticatedError();
  const traceId = newTraceId();
  return {
    user: session.user,
    traceId,
    log: logger.child({ traceId, userId: session.user.id }),
  };
}

/**
 * Require a session that has completed onboarding. Routes that operate on
 * channels/projects need the user's niche and connected channel to exist.
 */
export async function requireOnboarded(): Promise<RequestContext> {
  const ctx = await requireUser();
  if (!ctx.user.onboardedAt) {
    throw new ForbiddenError("Finish onboarding before using this feature.");
  }
  return ctx;
}

/**
 * The user's authoritative plan tier, read from the database (§23).
 *
 * Re-exported from `plans/enforce` rather than implemented here, so the scheduler
 * — which cannot import this `server-only` module — resolves a tier the same way a
 * request does.
 */
export { currentTier } from "@/lib/plans/enforce";

// ---------------------------------------------------------------------------
// Resource access — always re-queried with the tenant predicate
// ---------------------------------------------------------------------------

export interface ChannelAccess {
  id: string;
  userId: string;
  youtubeChannelId: string;
  title: string;
  reauthRequiredAt: Date | null;
}

/** Load a channel the user owns, or throw. Never leaks existence (§34). */
export async function requireChannelAccess(
  userId: string,
  channelId: string,
): Promise<ChannelAccess> {
  assertUuid(channelId, "channelId");
  const rows = await db
    .select({
      id: channels.id,
      userId: channels.userId,
      youtubeChannelId: channels.youtubeChannelId,
      title: channels.title,
      reauthRequiredAt: channels.reauthRequiredAt,
    })
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.userId, userId)))
    .limit(1);

  const row = rows[0];
  // 403 rather than 404 for a foreign id: a 404/403 split would reveal which
  // channel ids exist.
  if (!row) throw new ForbiddenError("Channel not found or not accessible.");
  return row;
}

export interface ProjectAccess {
  id: string;
  userId: string;
  /**
   * Null for a project created from a pasted YouTube link (Phase 11 §4).
   *
   * Widened from `string`, which is why every route that needs a channel now has
   * to say so. That is the intended consequence: the type makes "this endpoint
   * requires a connected channel" explicit at each call site instead of assuming
   * it, and publishing is the case where the assumption mattered.
   */
  channelId: string | null;
  title: string;
  status: (typeof projects.status.enumValues)[number];
}

/**
 * Load a project and insist it has a channel.
 *
 * For the endpoints where a channel is genuinely required — publishing, YouTube
 * metadata, anything acting on a real channel. Ownership of the channel is already
 * implied: the project is the user's and `projects.channelId` was validated
 * against `requireChannelAccess` when it was set.
 */
export async function requireProjectChannel(
  userId: string,
  projectId: string,
): Promise<ProjectAccess & { channelId: string }> {
  const project = await requireProjectAccess(userId, projectId);
  if (!project.channelId) {
    throw new ValidationError(
      "This project is not linked to a YouTube channel. Connect a channel and " +
        "assign it to this project first.",
      { field: "channelId" },
    );
  }
  return { ...project, channelId: project.channelId };
}

/** Load a project the user owns, or throw. */
export async function requireProjectAccess(
  userId: string,
  projectId: string,
): Promise<ProjectAccess> {
  assertUuid(projectId, "projectId");
  const rows = await db
    .select({
      id: projects.id,
      userId: projects.userId,
      channelId: projects.channelId,
      title: projects.title,
      status: projects.status,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);

  const row = rows[0];
  if (!row) throw new ForbiddenError("Project not found or not accessible.");
  return row;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validate a path parameter before it reaches the database. */
export function assertUuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) {
    throw new ValidationError(`Invalid ${field}.`, { field });
  }
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

/** Largest JSON body accepted. Generous for metadata, far below abuse size. */
const MAX_JSON_BYTES = 256 * 1024;

/**
 * Parse and validate a JSON body against a Zod schema. Rejects oversized
 * bodies and malformed JSON with 400s rather than letting them become 500s.
 */
export async function parseJson<T extends z.ZodTypeAny>(
  request: NextRequest,
  schema: T,
): Promise<z.infer<T>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new ValidationError("Expected content-type: application/json.");
  }

  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > MAX_JSON_BYTES) {
    throw new ValidationError("Request body is too large.");
  }

  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) {
    throw new ValidationError("Request body is too large.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ValidationError("Request body is not valid JSON.");
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError("Some fields are invalid.", {
      fields: result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  return result.data;
}

/** Validate query-string parameters. */
export function parseQuery<T extends z.ZodTypeAny>(
  request: NextRequest,
  schema: T,
): z.infer<T> {
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new ValidationError("Some query parameters are invalid.", {
      fields: result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

/**
 * Origin-based CSRF defence for state-changing requests (§34).
 *
 * The session cookie is SameSite=Lax, which already blocks cross-site POSTs from
 * forms; this is the second layer, and it catches same-site-but-wrong-origin
 * cases. Checking Origin/Sec-Fetch-Site avoids a token round-trip while still
 * rejecting classic CSRF.
 */
export function assertSameOrigin(request: NextRequest): void {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

  const site = request.headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return;

  const origin = request.headers.get("origin");
  if (origin) {
    const expected = new URL(request.nextUrl.origin);
    try {
      const actual = new URL(origin);
      if (actual.host === expected.host && actual.protocol === expected.protocol) {
        return;
      }
    } catch {
      // fall through to rejection
    }
  }

  throw new ForbiddenError("Cross-origin request rejected.");
}

// ---------------------------------------------------------------------------
// Route wrapper
// ---------------------------------------------------------------------------

export interface JsonSuccess<T> {
  data: T;
}

/** Per-request context handed to the wrapped handler. */
export interface HandlerContext {
  /**
   * The id already on every log line for this request, and returned as
   * `x-vidxir-trace-id`.
   *
   * Handlers that enqueue work pass it to `enqueue()` so a job's logs join up
   * with the request that created it — §41 asks for one traceable identifier
   * across the whole journey, and the trace has to cross the queue boundary to
   * be worth anything.
   */
  traceId: string;
}

/**
 * Wrap a route handler. Converts AppError to its declared status, logs unknown
 * errors with the trace id, and returns a generic message for anything
 * unexpected so internals never reach the client.
 */
export async function handle<T>(
  request: NextRequest,
  fn: (context: HandlerContext) => Promise<T | NextResponse>,
): Promise<NextResponse> {
  const traceId = newTraceId();
  const log = logger.child({
    traceId,
    component: "api",
    method: request.method,
    path: request.nextUrl.pathname,
  });

  try {
    assertSameOrigin(request);
    const result = await fn({ traceId });
    if (result instanceof NextResponse) {
      result.headers.set("x-vidxir-trace-id", traceId);
      return result;
    }
    return NextResponse.json(
      { data: result } satisfies JsonSuccess<T>,
      { headers: { "x-vidxir-trace-id": traceId } },
    );
  } catch (error) {
    if (isAppError(error)) {
      // Expected, classified failures log at warn: they are outcomes, not bugs.
      log.warn("request failed", {
        // LogContext.status is the operation outcome, so the HTTP code goes in
        // its own field rather than being coerced into it.
        status: "error",
        httpStatus: error.status,
        errorCode: error.code,
        error,
      });
      const response = NextResponse.json(error.toResponseBody(), {
        status: error.status,
        headers: { "x-vidxir-trace-id": traceId },
      });
      if (error.retryAfterSeconds) {
        response.headers.set("retry-after", String(error.retryAfterSeconds));
      }
      return response;
    }

    log.error("unhandled request error", { error });
    return NextResponse.json(
      {
        error: {
          code: "internal_error",
          message: userMessageOf(error),
          details: { traceId },
        },
      },
      { status: 500, headers: { "x-vidxir-trace-id": traceId } },
    );
  }
}

/**
 * Client IP for rate-limit keying, read from the right end of the proxy chain.
 *
 * `X-Forwarded-For` is a list a client can pre-populate. A proxy *appends* the
 * peer it saw, so the leftmost entry is whatever the caller typed and the
 * rightmost entries are the ones our own infrastructure added. Taking the left
 * entry — as this did previously — means an attacker rotates a header value and
 * every IP-keyed rule (`authIp`, guarding login and signup) becomes free.
 *
 * `TRUSTED_PROXY_HOPS` says how many entries on the right were added by
 * infrastructure we control. At 0, the header is not consulted at all: there is
 * no proxy, so anything in it was fabricated. At N, we index N from the right,
 * which is the last hop the client could not have written.
 *
 * A request with a shorter chain than configured falls back to `unknown` rather
 * than to a client-controlled entry: sharing one bucket degrades the limit, while
 * trusting a forged entry removes it.
 */
export function clientIp(request: NextRequest): string {
  const hops = env().TRUSTED_PROXY_HOPS;
  if (hops <= 0) return "direct";

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const chain = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const candidate = chain[chain.length - hops];
    if (candidate) return candidate;
  }

  // Single-proxy setups (nginx, and Vercel's own edge) set this to the peer they
  // saw, and unlike XFF it is not a list a client can extend.
  if (hops === 1) {
    const real = request.headers.get("x-real-ip")?.trim();
    if (real) return real;
  }

  return "unknown";
}

export { AppError };
