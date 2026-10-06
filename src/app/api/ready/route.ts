/**
 * GET /api/ready — readiness (§16, §22).
 *
 * "Can this instance safely serve production traffic?" A failure here removes the
 * instance from the load balancer and puts it back on recovery — unlike
 * `/api/health`, which kills the container. So this one does check dependencies,
 * and checks only the ones a request genuinely needs: Postgres, Redis (soft in web
 * mode, since the rate limiter fails open and pages still render), and the
 * *non-optional* provider capabilities. An unconfigured optional provider is a
 * product state, not an outage, and must never drain traffic.
 *
 * `mode` selects which dependency set applies, so a worker or scheduler
 * supervisor can ask the question its process actually cares about.
 *
 * 503 on `not_ready` rather than 200-with-a-body: every orchestrator reads the
 * status code, and most read nothing else.
 *
 * Unauthenticated, because a probe cannot log in. What that exposes is bounded on
 * purpose: with no token, the response is the verdict plus per-dependency
 * booleans. The capability and variable *names* — still not values — appear only
 * for a caller presenting `HEALTH_PROBE_TOKEN`, or in development. No connection
 * string, credential, env var value or internal hostname is reachable through this
 * route in any mode.
 *
 * Being unauthenticated it is also cheap to flood, so the *cost* is bounded in
 * `readiness()` by a one-second memo rather than by the Redis rate limiter — see
 * the note on `CACHE_TTL_MS` for why a 429 would be the wrong answer to give an
 * orchestrator.
 */
import { NextResponse, type NextRequest } from "next/server";
import { probeTokenMatches, readiness, type ReadinessMode } from "@/lib/health";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const MODES: readonly ReadinessMode[] = ["web", "worker", "full"];

function requestedMode(request: NextRequest): ReadinessMode {
  const raw = request.nextUrl.searchParams.get("mode");
  // An unrecognised value falls back to `web` rather than 400ing: a probe URL
  // typo should not read as an outage.
  return MODES.includes(raw as ReadinessMode) ? (raw as ReadinessMode) : "web";
}

export async function GET(request: NextRequest) {
  const mode = requestedMode(request);

  let report;
  try {
    report = await readiness(mode);
  } catch (error) {
    /**
     * Reaching here means the *probe itself* failed — in practice, `env()`
     * throwing because configuration is invalid, which happens before any
     * dependency is contacted.
     *
     * That is emphatically not-ready, and the message must not be echoed: an env
     * validation error names the variables that failed, and while `lib/env` does
     * not print values, this is not the place to depend on that.
     */
    logger.error("readiness probe failed", { component: "health", error });
    return NextResponse.json(
      { status: "not_ready", mode, checks: [], reason: "configuration_invalid" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const detailed = probeTokenMatches(request.headers.get("x-vidxir-probe-token"));

  const body = detailed
    ? report
    : {
        status: report.status,
        mode: report.mode,
        // Names and booleans only; the `detail` strings and the mode flags are
        // held back for an authenticated probe.
        checks: report.checks.map((c) => ({ name: c.name, status: c.status })),
      };

  return NextResponse.json(body, {
    status: report.status === "ready" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
