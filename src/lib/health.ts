/**
 * Liveness and readiness (§16).
 *
 * Two questions that get conflated and must not be, because an orchestrator does
 * different things with the answers:
 *
 *  - **Liveness** — "is this process alive?" A failing liveness probe gets the
 *    container *killed and replaced*. So it must check nothing external. If it
 *    consulted Postgres, a database blip would restart every replica in the fleet
 *    simultaneously — turning a recoverable dependency outage into a thundering
 *    restart loop that outlives the original fault.
 *
 *  - **Readiness** — "can this instance safely serve traffic right now?" A failing
 *    readiness probe gets the instance *removed from the load balancer* and put
 *    back when it recovers. So it checks exactly the dependencies a request needs,
 *    and nothing more.
 *
 * The "nothing more" is the part §16 is emphatic about: optional providers must
 * not make the application report unhealthy. Tally works perfectly well with no
 * ElevenLabs key — the Voiceover step reports `not_configured`, which is a
 * designed product state, not an outage. Draining traffic for it would take the
 * whole app down to protect a feature the operator chose not to enable. So the
 * provider contribution to readiness is exactly `blockingMisconfigurations()`,
 * the non-optional set, which the provider registry already computes.
 *
 * Modes exist because the three processes need different answers. The web tier
 * cannot serve a request without Postgres. The worker cannot do work without
 * Redis *and* Postgres. A readiness endpoint that demanded both from every
 * process would report the web tier unready during a queue outage, even though
 * every page still renders.
 *
 * Nothing here returns a connection string, a credential, an env var value, or a
 * hostname. The output is: names of capabilities, names of unset variables, a
 * boolean per dependency, and a duration. That is enough for an operator to know
 * where to look and not enough to be worth exfiltrating.
 *
 * No `server-only` marker, deliberately. This module imports nothing from Next,
 * and the marker's runtime export throws unconditionally — so carrying it meant
 * the `worker` mode above existed but was unreachable from the one process that
 * needed it: `src/worker/index.ts` is a plain `tsx` process and could not import
 * this file to check its own dependencies before consuming a queue. The
 * client-bundle boundary this file still needs is enforced by
 * `no-restricted-imports` in `eslint.config.mjs`, which applies to both runtimes.
 */
import { pingDb } from "@/lib/db";
import { env, isProduction, realPublishBlocked, usingMockProviders } from "@/lib/env";
import { asDatabaseError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { blockingMisconfigurations } from "@/lib/providers/config";
import { getRedis } from "@/lib/queue/redis";

const log = logger.child({ component: "health" });

/** Which dependencies this process genuinely requires. */
export type ReadinessMode = "web" | "worker" | "full";

export type CheckStatus = "ok" | "degraded" | "failed" | "skipped";

export interface DependencyCheck {
  name: "database" | "redis" | "configuration";
  status: CheckStatus;
  durationMs: number;
  /**
   * Operator-facing summary. Fixed strings and capability/variable *names* only —
   * never an error message from a driver, which can quote a connection string.
   */
  detail?: string;
}

export interface LivenessReport {
  status: "ok";
  uptimeSeconds: number;
}

export interface ReadinessReport {
  status: "ready" | "not_ready";
  mode: ReadinessMode;
  checks: DependencyCheck[];
  /** Deployment posture, so a probe can catch a mode mistake (§18). */
  mode_flags: {
    production: boolean;
    mockProviders: boolean;
    publishBlocked: boolean;
  };
}

/**
 * How long a dependency probe may take before it counts as failed.
 *
 * Shorter than any sensible probe interval: a readiness check that hangs is
 * indistinguishable to the orchestrator from one that fails, but it holds a
 * connection and a request slot while doing it.
 */
const PROBE_TIMEOUT_MS = 3_000;

async function withTimeout<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} probe timed out`)),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Liveness. Intentionally trivial — if this function runs, the answer is yes.
 *
 * Uptime is included because it is the one field that makes a liveness probe
 * useful in a log: a value that keeps resetting is a crash loop, which reads very
 * differently from a process that is merely unready.
 */
export function liveness(): LivenessReport {
  return { status: "ok", uptimeSeconds: Math.round(process.uptime()) };
}

async function checkDatabase(): Promise<DependencyCheck> {
  const start = Date.now();
  try {
    await withTimeout(() => pingDb(), "database");
    return { name: "database", status: "ok", durationMs: Date.now() - start };
  } catch (error) {
    // The classified error goes to the log (which redacts); the response gets a
    // fixed string. A postgres.js failure message can contain the DSN.
    const classified = asDatabaseError("readiness probe", error);
    log.error("readiness: database unreachable", {
      error: classified,
      errorCode: classified.code,
    });
    return {
      name: "database",
      status: "failed",
      durationMs: Date.now() - start,
      detail: "Postgres did not answer a health query.",
    };
  }
}

async function checkRedis(): Promise<DependencyCheck> {
  const start = Date.now();
  try {
    const pong = await withTimeout(() => getRedis().ping(), "redis");
    if (pong !== "PONG") {
      return {
        name: "redis",
        status: "failed",
        durationMs: Date.now() - start,
        detail: "Redis answered unexpectedly.",
      };
    }
    return { name: "redis", status: "ok", durationMs: Date.now() - start };
  } catch (error) {
    log.error("readiness: redis unreachable", { error });
    return {
      name: "redis",
      status: "failed",
      durationMs: Date.now() - start,
      detail: "Redis did not answer PING.",
    };
  }
}

/**
 * Configuration readiness — non-optional capabilities only.
 *
 * Reports capability and variable *names*. `blockingMisconfigurations()` already
 * returns exactly the non-optional-and-unconfigured set, so the optional-provider
 * rule is enforced by construction rather than by a filter that could drift.
 */
function checkConfiguration(): DependencyCheck {
  const start = Date.now();
  const blocking = blockingMisconfigurations();
  if (blocking.length === 0) {
    return { name: "configuration", status: "ok", durationMs: Date.now() - start };
  }
  return {
    name: "configuration",
    status: "failed",
    durationMs: Date.now() - start,
    detail:
      `Required capabilities are not configured: ` +
      blocking
        .map((c) => `${c.capability} (missing ${c.missingEnvVars.join(", ") || "prerequisites"})`)
        .join("; "),
  };
}

/**
 * Readiness for the given mode.
 *
 * Redis is checked in `web` mode too, but as `degraded` rather than `failed`. The
 * web tier's dependence on Redis is real but partial: the rate limiter fails open
 * by design, so pages still render and requests still succeed. Draining a replica
 * that can still serve every page would make a partial degradation total. The
 * worker's dependence is absolute — no Redis, no jobs — so there it is `failed`.
 *
 * Verdicts are memoised for a second and concurrent callers share one probe; see
 * the note on `CACHE_TTL_MS` for why that is the bound rather than the limiter.
 */
export async function readiness(mode: ReadinessMode = "web"): Promise<ReadinessReport> {
  const cached = cachedReport(mode);
  if (cached) return cached;

  const inFlight = pending.get(mode);
  if (inFlight) return inFlight;

  const run = probe(mode).finally(() => pending.delete(mode));
  pending.set(mode, run);
  return run;
}

/**
 * How long a verdict may be reused.
 *
 * `/api/ready` is unauthenticated — a probe cannot log in — so anyone can ask, and
 * each ask otherwise costs a Postgres round trip and a Redis PING. That is a
 * cheap-to-send, not-free-to-serve endpoint pointed at the two dependencies the
 * application cannot lose, which is precisely the shape worth bounding (§5).
 *
 * The bound is a cache rather than the rate limiter, for two reasons. The limiter
 * lives in Redis, so it would add a third dependency call to the probe and fail
 * open exactly when Redis is the thing being reported on. And a 429 to an
 * orchestrator is not a readiness answer — most read the status code and would
 * drain the instance for being asked too often.
 *
 * One second is far below any real probe interval (5–10s), so a genuine probe is
 * never served a stale verdict, while a flood collapses onto one dependency check
 * per second. `pending` additionally collapses a concurrent burst onto a single
 * in-flight probe rather than one per request.
 */
const CACHE_TTL_MS = 1_000;

interface CacheEntry {
  at: number;
  report: ReadinessReport;
}

const cache = new Map<ReadinessMode, CacheEntry>();
const pending = new Map<ReadinessMode, Promise<ReadinessReport>>();

function cachedReport(mode: ReadinessMode): ReadinessReport | null {
  const entry = cache.get(mode);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(mode);
    return null;
  }
  return entry.report;
}

async function probe(mode: ReadinessMode): Promise<ReadinessReport> {
  const report = await runChecks(mode);
  cache.set(mode, { at: Date.now(), report });
  return report;
}

/** Test seam: drop memoised verdicts so a probe re-runs immediately. */
export function resetReadinessCache(): void {
  cache.clear();
  pending.clear();
}

async function runChecks(mode: ReadinessMode): Promise<ReadinessReport> {
  const needsRedisHard = mode === "worker" || mode === "full";

  const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);
  const configuration = checkConfiguration();

  const redisCheck: DependencyCheck =
    redis.status === "failed" && !needsRedisHard
      ? {
          ...redis,
          status: "degraded",
          detail:
            "Redis did not answer PING. Rate limiting is failing open and " +
            "background work is not being queued; page serving is unaffected.",
        }
      : redis;

  const checks = [database, redisCheck, configuration];

  // Only a hard failure drains traffic. `degraded` is reported and served.
  const ready = checks.every((c) => c.status !== "failed");

  return {
    status: ready ? "ready" : "not_ready",
    mode,
    checks,
    mode_flags: {
      production: isProduction(),
      mockProviders: usingMockProviders(),
      publishBlocked: realPublishBlocked(),
    },
  };
}

/**
 * Whether the readiness endpoint may report configuration and mode detail.
 *
 * The detail is names, not values, and an orchestrator's probe cannot
 * authenticate — so it is exposed unconditionally in development and behind a
 * shared token in production, where the endpoint is reachable from the internet.
 * When no token is set in production the endpoint still answers ready/not_ready,
 * because a probe that cannot get a verdict is worse than one that gets a terse
 * verdict; it just omits the breakdown.
 */
export function probeTokenMatches(provided: string | null): boolean {
  const expected = env().HEALTH_PROBE_TOKEN;
  if (!expected) return !isProduction();
  if (!provided) return false;
  // Length-prefixed comparison rather than `===`: this is a shared secret, and a
  // timing-distinguishable compare on a secret is the habit worth not forming.
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
