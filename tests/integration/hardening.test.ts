/**
 * Adversarial hardening tests (§23).
 *
 * Everything here needs a real dependency to mean anything. The unit suites cover
 * the pure logic — `redactValue`, `asDatabaseError`, `clientIp`, the env guards —
 * but four of §23's scenarios are properties of Redis or Postgres behaviour rather
 * than of a function:
 *
 *  - **Rate limiting** is a Lua script executing inside Redis. A mocked Redis proves
 *    the wrapper, not the window; and the reason the script exists at all is that the
 *    previous INCR-then-EXPIRE pair could leave a TTL-less key, which is a Redis
 *    state no unit test can produce.
 *  - **Duplicate job execution** depends on BullMQ ignoring a repeated job id, which
 *    is a server-side property of the Redis data structures.
 *  - **Stale lock recovery** depends on a real PX expiry actually elapsing.
 *  - **Input rejection through a route** depends on the whole `handle()` stack — the
 *    session cookie, the origin check, `parseJson`'s ladder and the error mapping —
 *    running in the order production runs them.
 *
 * Every test asserts on the durable state as well as the response, because a
 * rejection that returns 403 while still writing the row is the failure mode worth
 * catching.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChannel,
  createUser,
  hasDatabase,
  jar,
  resetDatabase,
  signIn,
  useDatabase,
  type TestUser,
} from "./setup";

vi.mock("next/headers", () => ({
  cookies: async () => jar,
}));

const suite = hasDatabase ? describe : describe.skip;

/** The origin the harness configures as `APP_URL`; `assertSameOrigin` compares to it. */
const ORIGIN = "http://localhost:3000";

/**
 * A user who has finished onboarding, which `requireOnboarded()` demands before any
 * project or research route will look at the body.
 */
async function onboardedUser(email: string): Promise<TestUser> {
  const { saveStep, complete } = await import("@/lib/onboarding/service");
  const user = await createUser({ email });
  await saveStep(user.id, {
    niche: "Retro computing",
    contentStyle: "documentary",
    voicePreference: "warm-male",
  });
  await complete(user.id);
  return user;
}

interface RouteResult {
  status: number;
  /** Captured because the trace id travels as a header, not in the body. */
  traceId: string | null;
  body: {
    data?: Record<string, unknown>;
    error?: { code?: string; message?: string; details?: Record<string, unknown> };
  };
}

/**
 * POST to a route the way a browser would, with the bytes under the test's control.
 *
 * `body` is a raw string rather than a value to serialise: malformed JSON and an
 * oversized payload are both things that cannot be expressed as an object.
 */
async function post(
  path: string,
  handler: () => Promise<{ POST: (r: never) => Promise<Response> }>,
  options: { body?: string; headers?: Record<string, string> } = {},
): Promise<RouteResult> {
  const { NextRequest } = await import("next/server");
  const { POST } = await handler();

  const headers = new Headers({
    "content-type": "application/json",
    origin: ORIGIN,
    ...options.headers,
  });

  const request = new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    body: options.body ?? "{}",
    headers,
  });

  const response = await POST(request as never);
  return {
    status: response.status,
    traceId: response.headers.get("x-vidxir-trace-id"),
    body: (await response.json()) as RouteResult["body"],
  };
}

const postProjects = (options?: { body?: string; headers?: Record<string, string> }) =>
  post("/api/projects", () => import("@/app/api/projects/route"), options);

suite("API input rejection (integration)", () => {
  useDatabase();

  beforeAll(async () => {
    // The route graph and BullMQ's first Redis connection are both expensive on a
    // cold machine; paid here rather than inside whichever test runs first.
    await import("@/app/api/projects/route");
    await import("@/lib/queue/jobs");
    const { getRedis } = await import("@/lib/queue/redis");
    await getRedis().ping();
  }, 60_000);

  afterAll(async () => {
    const { closeQueues } = await import("@/lib/queue/queues");
    const { closeRedis } = await import("@/lib/queue/redis");
    await closeQueues();
    await closeRedis();
  });

  beforeEach(async () => {
    await resetDatabase();
    jar.clear();
  });

  it("rejects a body that is not valid JSON", async () => {
    const user = await onboardedUser("badjson@vidxir.test");
    await signIn(user);

    const result = await postProjects({ body: '{"channelId": "abc"' });

    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe("validation_failed");
    // The parse error itself is not echoed: a JSON.parse message quotes the input,
    // which is the caller's own bytes reflected back (§14).
    expect(result.body.error?.message).toBe("Request body is not valid JSON.");
  });

  it("rejects a body sent without a JSON content-type", async () => {
    const user = await onboardedUser("noctype@vidxir.test");
    await signIn(user);

    const result = await postProjects({
      body: "channelId=whatever",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    expect(result.status).toBe(400);
    expect(result.body.error?.message).toMatch(/content-type/i);
  });

  it("rejects an oversized body before parsing it", async () => {
    const user = await onboardedUser("oversized@vidxir.test");
    await signIn(user);

    /**
     * 512KB of valid JSON: twice `MAX_JSON_BYTES`. The point is that the limit is
     * enforced on the *bytes*, not by a schema — `title` has a `max(200)`, so a
     * schema-first order would parse half a megabyte before rejecting it, and a
     * larger payload would be a way to spend server CPU with one request (§5).
     */
    const huge = JSON.stringify({
      channelId: "3f2b9c1e-4a7d-4bee-9c2b-0242ac120002",
      title: "x".repeat(512 * 1024),
    });
    expect(huge.length).toBeGreaterThan(256 * 1024);

    const result = await postProjects({ body: huge });

    expect(result.status).toBe(400);
    expect(result.body.error?.message).toBe("Request body is too large.");
  });

  it("rejects a malformed uuid without letting it reach a query", async () => {
    const user = await onboardedUser("baduuid@vidxir.test");
    await signIn(user);

    for (const channelId of [
      "not-a-uuid",
      "00000000-0000-0000-0000-000000000000",
      "3f2b9c1e-4a7d-4bee-9c2b-0242ac120002' OR '1'='1",
      "../../etc/passwd",
    ]) {
      const result = await postProjects({
        body: JSON.stringify({ channelId, title: "Attempt" }),
      });

      expect(result.status, channelId).toBe(400);
      expect(result.body.error?.code, channelId).toBe("validation_failed");
      // Nothing the caller supplied comes back out.
      const serialised = JSON.stringify(result.body);
      expect(serialised).not.toContain("OR '1'='1");
      expect(serialised).not.toContain("etc/passwd");
    }
  });

  it("rejects a cross-origin mutation before authenticating it", async () => {
    const user = await onboardedUser("crossorigin@vidxir.test");
    await signIn(user);
    const channelId = await createChannel(user.id);

    const result = await postProjects({
      body: JSON.stringify({ channelId, title: "Forged by a third party" }),
      headers: { origin: "https://evil.example" },
    });

    expect(result.status).toBe(403);

    // And no project exists, which is the assertion that matters: a CSRF check that
    // returns 403 after doing the work is not a CSRF check.
    const { db } = await import("@/lib/db");
    const { projects } = await import("@/lib/db/schema");
    expect(await db.select().from(projects)).toHaveLength(0);
  });

  it("refuses an unauthenticated mutation", async () => {
    jar.clear();
    const result = await postProjects({
      body: JSON.stringify({ channelId: "3f2b9c1e-4a7d-4bee-9c2b-0242ac120002" }),
    });
    expect(result.status).toBe(401);
  });

  it("refuses a mutation naming another tenant's channel", async () => {
    const owner = await onboardedUser("chanowner@vidxir.test");
    const attacker = await onboardedUser("chanattacker@vidxir.test");
    const victimChannel = await createChannel(owner.id, {
      youtubeChannelId: "UCvictimchannel0000000",
    });

    await signIn(attacker);

    // A real, well-formed, existing id — the whole point. Validation cannot catch
    // this; only the ownership predicate can (§5).
    const result = await postProjects({
      body: JSON.stringify({
        channelId: victimChannel,
        title: "Made on someone else's channel",
      }),
    });

    expect(result.status).toBe(403);
    expect(result.body.error?.code).toBe("forbidden");

    const { db } = await import("@/lib/db");
    const { projects } = await import("@/lib/db/schema");
    expect(await db.select().from(projects)).toHaveLength(0);
  });

  it("does not leak internals through an error response", async () => {
    const user = await onboardedUser("noleak@vidxir.test");
    await signIn(user);

    const result = await postProjects({
      body: JSON.stringify({ channelId: "3f2b9c1e-4a7d-4bee-9c2b-0242ac120002" }),
    });

    // 403: a foreign-looking id is an authorization answer, not a 404 that would
    // confirm whether the row exists.
    expect(result.status).toBe(403);

    const serialised = JSON.stringify(result.body);
    // §14's list, checked against the real response rather than a constructed error.
    for (const forbidden of [
      "select ",
      "SELECT ",
      "postgresql://",
      "DATABASE_URL",
      "SESSION_SECRET",
      "ENCRYPTION_KEY",
      "at Object.",
      "node_modules",
      "C:\\Users",
      "/src/lib/",
    ]) {
      expect(serialised, forbidden).not.toContain(forbidden);
    }
    /**
     * A trace id is still returned — as a header, not in the body — which is how the
     * detail withheld above stays reachable (§15). The operator correlates on this
     * value; the caller learns nothing from it.
     */
    expect(result.traceId).toMatch(/\w/);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

suite("rate limiting against real Redis (integration)", () => {
  useDatabase();

  /** A namespace per test, so one case's counters cannot bleed into another's. */
  let counter = 0;
  function uniqueRule(limit: number, windowSeconds: number) {
    counter += 1;
    return { name: `hardening:test:${counter}`, limit, windowSeconds };
  }

  beforeAll(async () => {
    const { getRedis } = await import("@/lib/queue/redis");
    await getRedis().ping();
  }, 60_000);

  afterAll(async () => {
    const { closeQueues } = await import("@/lib/queue/queues");
    const { closeRedis } = await import("@/lib/queue/redis");
    await closeQueues();
    await closeRedis();
  });

  it("allows exactly the configured number of requests, then refuses", async () => {
    const { consume } = await import("@/lib/api/rate-limit");
    const rule = uniqueRule(3, 60);

    const first = await consume(rule, "subject-a");
    expect(first).toMatchObject({ allowed: true, remaining: 2 });
    expect((await consume(rule, "subject-a")).remaining).toBe(1);
    expect((await consume(rule, "subject-a")).remaining).toBe(0);

    // The fourth is over the limit — off-by-one in either direction is a real bug:
    // one too few refuses a legitimate caller, one too many is a limit that lies.
    const fourth = await consume(rule, "subject-a");
    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
  });

  it("keys separately, so one subject cannot exhaust another's window", async () => {
    const { consume } = await import("@/lib/api/rate-limit");
    const rule = uniqueRule(2, 60);

    await consume(rule, "tenant-one");
    await consume(rule, "tenant-one");
    expect((await consume(rule, "tenant-one")).allowed).toBe(false);

    // A shared key here would mean one noisy account rate-limiting everybody else.
    expect((await consume(rule, "tenant-two")).allowed).toBe(true);
  });

  it("sets a TTL atomically with the first increment", async () => {
    /**
     * The finding this test exists for. `INCR` then `EXPIRE` is two round trips; a
     * process that dies between them leaves a counter with no expiry, and that key
     * never resets — the subject is rate-limited permanently. On `loginEmail` that
     * is an account locked out of its own login by a Redis hiccup, with no way to
     * clear it short of an operator deleting a key by hand.
     */
    const { consume } = await import("@/lib/api/rate-limit");
    const { getRedis } = await import("@/lib/queue/redis");
    const { env } = await import("@/lib/env");

    const rule = uniqueRule(5, 90);
    await consume(rule, "ttl-subject");

    const key = `${env().QUEUE_PREFIX}:ratelimit:${rule.name}:ttl-subject`;
    const ttl = await getRedis().pttl(key);

    // -1 is the failure mode: the key exists with no expiry.
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(90_000);
  });

  it("repairs a counter that somehow has no expiry", async () => {
    /**
     * The other half of the same finding: a key left behind by the *old* code, or by
     * a failover that lost the `PEXPIRE`, is still in Redis after a deploy. The Lua
     * script's `ttl < 0` branch re-applies the window rather than leaving the subject
     * blocked forever, so recovery does not need an operator.
     */
    const { consume } = await import("@/lib/api/rate-limit");
    const { getRedis } = await import("@/lib/queue/redis");
    const { env } = await import("@/lib/env");

    const rule = uniqueRule(10, 60);
    const key = `${env().QUEUE_PREFIX}:ratelimit:${rule.name}:orphan`;

    // Exactly the state the broken sequence produced: a count, no TTL.
    await getRedis().set(key, "4");
    expect(await getRedis().pttl(key)).toBe(-1);

    const result = await consume(rule, "orphan");

    expect(result.allowed).toBe(true);
    expect(await getRedis().pttl(key)).toBeGreaterThan(0);
  });

  it("reports a retry-after that the window will actually honour", async () => {
    const { consume } = await import("@/lib/api/rate-limit");
    const rule = uniqueRule(1, 30);

    await consume(rule, "retry-after");
    const blocked = await consume(rule, "retry-after");

    expect(blocked.allowed).toBe(false);
    // Never 0 — a `Retry-After: 0` invites an immediate retry that is guaranteed to
    // be refused — and never longer than the window it came from.
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(30);
  });

  it("expires the window, so a limit is a delay and not a ban", async () => {
    const { consume } = await import("@/lib/api/rate-limit");
    // A 1s window, which is the shortest thing worth waiting for in a test. The
    // property under test is that the key really does expire in Redis.
    const rule = uniqueRule(1, 1);

    await consume(rule, "expiring");
    expect((await consume(rule, "expiring")).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect((await consume(rule, "expiring")).allowed).toBe(true);
  });

  it("throws RateLimitedError with a retry hint once exhausted", async () => {
    const { enforce } = await import("@/lib/api/rate-limit");
    const rule = uniqueRule(1, 60);

    await enforce(rule, "throwing");
    await expect(enforce(rule, "throwing")).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
    });
  });

  it("does not name the subject or the rule in the client-facing message", async () => {
    // §7: "Rate-limit responses must be consistent and should not leak sensitive
    // information." The key is often an email address on the auth rules.
    const { enforce } = await import("@/lib/api/rate-limit");
    const rule = uniqueRule(1, 60);
    const subject = "victim@example.com";

    await enforce(rule, subject);
    try {
      await enforce(rule, subject);
      throw new Error("expected a rejection");
    } catch (error) {
      const { userMessageOf } = await import("@/lib/errors");
      const message = userMessageOf(error);
      expect(message).not.toContain(subject);
      expect(message).not.toContain(rule.name);
      expect(message).toMatch(/too many requests/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Scheduler locking
// ---------------------------------------------------------------------------

suite("scheduler lock safety (integration)", () => {
  useDatabase();

  let counter = 0;
  const lockName = () => {
    counter += 1;
    return `hardening:lock:${counter}`;
  };

  beforeAll(async () => {
    const { getRedis } = await import("@/lib/queue/redis");
    await getRedis().ping();
  }, 60_000);

  afterAll(async () => {
    const { closeQueues } = await import("@/lib/queue/queues");
    const { closeRedis } = await import("@/lib/queue/redis");
    await closeQueues();
    await closeRedis();
  });

  it("lets only one holder in at a time", async () => {
    const { acquireLock } = await import("@/lib/queue/lock");
    const name = lockName();

    const first = await acquireLock(name, { ttlMs: 10_000 });
    expect(first).not.toBeNull();

    // The second replica's scheduler tick. Null means "skip", which is what stops
    // two instances from spending YouTube quota on the same pass (§11).
    expect(await acquireLock(name, { ttlMs: 10_000 })).toBeNull();

    await first?.release();
  });

  it("hands the lock to the next caller after a release", async () => {
    const { acquireLock } = await import("@/lib/queue/lock");
    const name = lockName();

    const first = await acquireLock(name, { ttlMs: 10_000 });
    await first?.release();

    const second = await acquireLock(name, { ttlMs: 10_000 });
    // A release that did not actually free the key would stall the schedule for a
    // whole TTL after every successful pass.
    expect(second).not.toBeNull();
    await second?.release();
  });

  it("recovers a stale lock whose holder died", async () => {
    /**
     * §11's stale-lock requirement. A scheduler killed mid-pass — SIGKILL, an OOM,
     * a container eviction — never runs its `finally`, so the key survives it. The
     * TTL is the only thing that frees it, and if it did not the task would stop
     * running until an operator noticed.
     *
     * A short TTL with the heartbeat disabled (`renewMs` past the TTL) reproduces
     * exactly that: a holder that will never renew.
     */
    const { acquireLock, lockHeld } = await import("@/lib/queue/lock");
    const name = lockName();

    const dead = await acquireLock(name, { ttlMs: 600, renewMs: 60_000 });
    expect(dead).not.toBeNull();
    expect(await lockHeld(name)).toBe(true);

    // Still held immediately after: recovery must not be instant, or the lock would
    // not be excluding anything.
    expect(await acquireLock(name, { ttlMs: 600 })).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 900));

    const recovered = await acquireLock(name, { ttlMs: 5_000 });
    expect(recovered).not.toBeNull();
    await recovered?.release();
  });

  it("does not let a stale holder release the new holder's lock", async () => {
    /**
     * The subtle failure the owner token prevents. Process A takes the lock, stalls
     * past the TTL, B takes it, then A finally reaches its `finally` and releases —
     * releasing *B's* lock, so C gets in while B is still working. That is a lock
     * that silently stops excluding, which is worse than no lock because nothing
     * logs it.
     */
    const { acquireLock, lockHeld } = await import("@/lib/queue/lock");
    const name = lockName();

    const stalled = await acquireLock(name, { ttlMs: 500, renewMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 800));

    const successor = await acquireLock(name, { ttlMs: 10_000 });
    expect(successor).not.toBeNull();
    expect(successor?.owner).not.toBe(stalled?.owner);

    // A's late release: a no-op, because the stored owner no longer matches.
    await stalled?.release();

    expect(await lockHeld(name)).toBe(true);
    expect(await acquireLock(name, { ttlMs: 1_000 })).toBeNull();

    await successor?.release();
  });

  it("frees the lock when the guarded task throws", async () => {
    // §11: "a failed job does not permanently block the schedule."
    const { withLock, lockHeld } = await import("@/lib/queue/lock");
    const name = lockName();

    await expect(
      withLock(
        name,
        async () => {
          throw new Error("task exploded");
        },
        { ttlMs: 30_000 },
      ),
    ).rejects.toThrow("task exploded");

    expect(await lockHeld(name)).toBe(false);
  });

  it("reports that it skipped rather than that it did nothing", async () => {
    const { acquireLock, withLock } = await import("@/lib/queue/lock");
    const name = lockName();

    const holder = await acquireLock(name, { ttlMs: 10_000 });
    let ran = false;

    const outcome = await withLock(name, async () => {
      ran = true;
    });

    // The distinction matters for diagnosis: "another replica has it" and "there was
    // nothing to do" look identical in a log otherwise.
    expect(outcome.ran).toBe(false);
    expect(ran).toBe(false);

    await holder?.release();
  });
});

// ---------------------------------------------------------------------------
// Job enqueue idempotency
// ---------------------------------------------------------------------------

suite("job enqueue safety (integration)", () => {
  useDatabase();

  beforeAll(async () => {
    await import("@/lib/queue/jobs");
    const { getRedis } = await import("@/lib/queue/redis");
    await getRedis().ping();
  }, 60_000);

  afterAll(async () => {
    // Messages enqueued here are never consumed — no worker runs in this suite — so
    // the queues are drained rather than left for a developer's worker to choke on.
    const { getQueue, closeQueues } = await import("@/lib/queue/queues");
    const { closeRedis } = await import("@/lib/queue/redis");
    await getQueue("maintenance").obliterate({ force: true });
    await closeQueues();
    await closeRedis();
  });

  beforeEach(resetDatabase);

  it("uses the jobs row id as the BullMQ job id", async () => {
    /**
     * §10's "duplicate job execution" guard, and it is this identity that provides
     * it: BullMQ refuses to add a job whose id already exists, so a re-push of the
     * same row cannot produce a second run. Any drift between the two ids silently
     * removes that protection, which is why it is asserted rather than assumed.
     */
    const { enqueue } = await import("@/lib/queue/jobs");
    const { getQueue } = await import("@/lib/queue/queues");
    const user = await createUser({ email: "jobid@vidxir.test" });

    const job = await enqueue({
      queue: "maintenance",
      name: "hardening-probe",
      userId: user.id,
      payload: { probe: true },
    });

    const inRedis = await getQueue("maintenance").getJob(job.id);
    expect(inRedis).toBeDefined();
    expect(inRedis?.id).toBe(job.id);

    // And the row records the same id, so a log line, the API and Redis all agree.
    const { db } = await import("@/lib/db");
    const { jobs } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row?.queueJobId).toBe(job.id);
  });

  it("ignores a re-push of the same job id rather than running it twice", async () => {
    const { enqueue } = await import("@/lib/queue/jobs");
    const { getQueue } = await import("@/lib/queue/queues");
    const user = await createUser({ email: "repush@vidxir.test" });

    const job = await enqueue({
      queue: "maintenance",
      name: "hardening-probe",
      userId: user.id,
    });

    const queue = getQueue("maintenance");
    const before = await queue.getJobCountByTypes("waiting", "delayed", "active");

    // The retried push: what a crashed-and-restarted enqueue path would do. BullMQ
    // deduplicates on the id, so the count must not move.
    await queue.add(
      "hardening-probe",
      { jobId: job.id },
      { jobId: job.id, attempts: 3 },
    );

    const after = await queue.getJobCountByTypes("waiting", "delayed", "active");
    expect(after).toBe(before);
  });

  it("writes the durable row before the Redis push", async () => {
    /**
     * The ordering that makes a job recoverable. If Redis took the message first and
     * the row write failed, there would be a job running with nothing to report
     * against — and a job the UI cannot see is §42's "jobs do not silently
     * disappear" inverted. Row-first means the worst case is a row with no message,
     * which is visible and re-pushable.
     */
    const { enqueue } = await import("@/lib/queue/jobs");
    const user = await createUser({ email: "ordering@vidxir.test" });

    const job = await enqueue({
      queue: "maintenance",
      name: "hardening-probe",
      userId: user.id,
    });

    const { db } = await import("@/lib/db");
    const { jobs } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));

    expect(row).toBeDefined();
    expect(row?.status).toBe("queued");
    expect(row?.userId).toBe(user.id);
  });

  it("keeps no credential in the job payload", async () => {
    // §15/§34: a payload is stored in Postgres *and* in Redis, and it is logged on
    // failure. It is the last place a token should be.
    const { enqueue } = await import("@/lib/queue/jobs");
    const user = await createUser({ email: "payload@vidxir.test" });
    const channelId = await createChannel(user.id);

    const job = await enqueue({
      queue: "maintenance",
      name: "hardening-probe",
      userId: user.id,
      channelId,
      payload: { channelId },
    });

    const { db } = await import("@/lib/db");
    const { jobs } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));

    const serialised = JSON.stringify(row?.payload ?? {});
    expect(serialised).not.toContain("test-access-token");
    expect(serialised).not.toContain("test-refresh-token");
    expect(serialised).not.toMatch(/accessToken|refreshToken|Enc"/);
  });
});

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

suite("health and readiness (integration)", () => {
  useDatabase();

  beforeAll(async () => {
    await import("@/lib/health");
    const { getRedis } = await import("@/lib/queue/redis");
    await getRedis().ping();
  }, 60_000);

  afterAll(async () => {
    const { closeQueues } = await import("@/lib/queue/queues");
    const { closeRedis } = await import("@/lib/queue/redis");
    await closeQueues();
    await closeRedis();
  });

  it("probes both hard dependencies against the real services", async () => {
    const { readiness, resetReadinessCache } = await import("@/lib/health");
    resetReadinessCache();

    const report = await readiness("full");

    const byName = new Map(report.checks.map((check) => [check.name, check]));
    // Genuinely probed, not assumed: a real `select 1` and a real PING, both of
    // which pass here because docker-compose is up.
    expect(byName.get("database")?.status).toBe("ok");
    expect(byName.get("coordination")?.status).toBe("ok");

    /**
     * The overall verdict is deliberately *not* asserted as ready.
     *
     * This environment has no `GOOGLE_CLIENT_ID`, and `youtube` is one of the four
     * non-optional capabilities, so `not_ready` is the correct answer — an instance
     * that cannot reach YouTube cannot serve Vidxir AI's core workflow. Asserting
     * `ready` here would have been asserting that readiness ignores configuration,
     * which is the opposite of what §16 asks for.
     */
    expect(report.status).toBe("not_ready");
    expect(byName.get("configuration")?.status).toBe("failed");
    // And it names the variable, not its value, so an operator knows what to set.
    expect(byName.get("configuration")?.detail).toContain("GOOGLE_CLIENT_ID");
  });

  it("does not let an optional provider make the instance unready", async () => {
    /**
     * §16: "Do not make optional providers cause the entire application to report
     * unhealthy." Voice, visuals, music, transcription and billing are all `mock` in
     * this environment — five unconfigured providers — and none of them appears in
     * the configuration check. Only the non-optional set can block readiness.
     */
    const { readiness, resetReadinessCache } = await import("@/lib/health");
    const { providerStatuses, blockingMisconfigurations } = await import(
      "@/lib/providers/config"
    );
    resetReadinessCache();

    const optionalUnconfigured = providerStatuses().filter(
      (status) => status.optional && status.state !== "ready",
    );
    // Guards the test itself: with nothing optional unconfigured it would pass
    // vacuously.
    expect(optionalUnconfigured.length).toBeGreaterThan(0);

    const blocking = blockingMisconfigurations().map((status) => status.capability);
    for (const status of optionalUnconfigured) {
      expect(blocking, status.capability).not.toContain(status.capability);
    }

    const detail =
      (await readiness("full")).checks.find((c) => c.name === "configuration")
        ?.detail ?? "";
    for (const status of optionalUnconfigured) {
      expect(detail, status.capability).not.toContain(status.capability);
    }
  });

  it("states the deployment posture, so a probe can catch a mode mistake", async () => {
    const { readiness, resetReadinessCache } = await import("@/lib/health");
    resetReadinessCache();

    const report = await readiness("web");

    // The harness runs with mock providers, and the report says so rather than
    // reporting a healthy production instance (§18).
    expect(report.mode_flags.mockProviders).toBe(true);
    expect(report.mode_flags.production).toBe(false);
  });

  it("does not put a secret or a connection string in the report", async () => {
    const { readiness, resetReadinessCache } = await import("@/lib/health");
    resetReadinessCache();

    const serialised = JSON.stringify(await readiness("full"));

    // §16: the health endpoint is unauthenticated, so its body is public.
    for (const forbidden of [
      "postgresql://",
      "redis://",
      process.env["ENCRYPTION_KEY"] ?? "unset-encryption-key",
      process.env["SESSION_SECRET"] ?? "unset-session-secret",
      "vidxirminio",
    ]) {
      expect(serialised, forbidden.slice(0, 12)).not.toContain(forbidden);
    }
  });

  it("collapses a burst of probes onto one dependency check", async () => {
    /**
     * The bound on an unauthenticated endpoint that costs a Postgres round trip and
     * a Redis PING per call (§5). Asserted by identity: within the TTL every caller
     * must receive the *same* object, which is only true if one probe ran.
     */
    const { readiness, resetReadinessCache } = await import("@/lib/health");
    resetReadinessCache();

    const reports = await Promise.all(
      Array.from({ length: 8 }, () => readiness("full")),
    );

    const first = reports[0];
    for (const report of reports) expect(report).toBe(first);
  });

  it("keeps liveness independent of every dependency", async () => {
    // §16: liveness answers "is this process alive", so it must not fail because
    // Postgres is down — an orchestrator would restart a healthy instance.
    const { liveness } = await import("@/lib/health");
    const report = liveness();

    expect(report.status).toBe("ok");
    expect(JSON.stringify(report)).not.toContain("postgres");
  });
});

// ---------------------------------------------------------------------------
// Background entrypoints
// ---------------------------------------------------------------------------

/**
 * The worker and scheduler must actually start (§10, §11, §22).
 *
 * These exist because a green test suite hid this twice. `vitest.config.ts` aliases
 * `server-only` to a stub so tests can import marked modules — which means a test
 * importing the scheduler proves nothing about `npm run scheduler`, where the real
 * `server-only` throws on import. Phase 10 found the scheduler had never started in
 * any deployment for exactly that reason: it imported `pruneSessions` from the
 * marked `lib/auth/session`, so the process died at its first import, before its
 * logger existed, taking session pruning, channel-stats refresh, analytics ingestion
 * and every automation tick with it.
 *
 * So these tests deliberately do NOT import the entrypoints. They spawn them as real
 * `tsx` processes, with no alias, and assert on what the process actually does. That
 * is the only configuration in which the question means anything.
 */
suite("legacy PostgreSQL/BullMQ background entrypoints", () => {
  /**
   * Start an entrypoint, capture output until it logs `ready`, then SIGTERM it.
   *
   * Resolves with everything it wrote plus its exit code, so a test can assert both
   * that the expected line appeared and that nothing crashed on the way there.
   */
  async function boot(
    entrypoint: string,
    ready: RegExp,
  ): Promise<{ output: string; code: number | null; sawReady: boolean }> {
    const { spawn } = await import("node:child_process");
    const { join } = await import("node:path");

    return await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), entrypoint],
        {
          cwd: process.cwd(),
          // No vitest, and therefore no `server-only` alias: this is the module
          // graph `npm run worker` and `npm run scheduler` actually resolve.
          env: { ...process.env, LOG_LEVEL: "debug" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let output = "";
      let sawReady = false;
      let settled = false;

      const collect = (chunk: Buffer): void => {
        output += chunk.toString();
        if (!sawReady && ready.test(output)) {
          sawReady = true;
          // It got where it needed to get. Stop it through the signal a deploy
          // would use, so the graceful path is exercised rather than a kill.
          child.kill("SIGTERM");
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);

      const finish = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ output, code, sawReady });
      };

      // Generous: a cold `tsx` start compiles the whole graph. Expiring is a
      // failure the assertions below will report, not a flake to be papered over.
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(null);
      }, 90_000);

      child.on("exit", (code) => finish(code));
      child.on("error", () => finish(null));
    });
  }

  it("starts the scheduler and registers every task", async () => {
    const result = await boot("src/scheduler/index.ts", /scheduler starting/);

    // The specific failure this test was written for. Asserted by name because the
    // symptom — a process that exits silently — is otherwise indistinguishable from
    // a dozen other startup problems.
    expect(result.output).not.toContain(
      "This module cannot be imported from a Client Component module",
    );
    expect(result.sawReady, `scheduler never started:\n${result.output}`).toBe(true);

    // All four tasks, because losing one silently is the actual risk: the process
    // would look healthy while a whole responsibility had gone missing.
    for (const task of [
      "prune-sessions",
      "refresh-channel-stats",
      "automation",
      "ingest-analytics",
    ]) {
      expect(result.output).toContain(task);
    }
  }, 120_000);

  it("starts the worker and listens on every registered queue", async () => {
    const result = await boot("src/worker/index.ts", /worker listening/);

    expect(result.output).not.toContain(
      "This module cannot be imported from a Client Component module",
    );
    expect(result.sawReady, `worker never started:\n${result.output}`).toBe(true);
    // §10: a worker with nothing registered consumes nothing and reports healthy.
    expect(result.output).not.toContain("worker has nothing to do");
  }, 120_000);

  it("checks its dependencies before consuming a queue", async () => {
    /**
     * The preflight (§16, §22). Without it the worker starts against an unreachable
     * Postgres and discovers it one job at a time, each failure burning an attempt —
     * so a one-minute outage arrives as a batch of permanently-failed work someone
     * has to find and requeue by hand.
     */
    const result = await boot("src/worker/index.ts", /worker listening/);

    expect(result.output).toMatch(/worker preflight (ok|not ready|failed)/);
    // Ordering is the point: a check that runs after the first job is not a
    // preflight. Both lines are present, so their indices are comparable.
    expect(result.output.indexOf("worker preflight")).toBeLessThan(
      result.output.indexOf("worker listening"),
    );
    // And with the dependencies up, it must be the affirmative verdict — otherwise
    // this assertion would pass on a preflight that always reported failure.
    expect(result.output).toContain("worker preflight ok");
  }, 120_000);

  it("keeps session pruning importable from a plain Node process", async () => {
    /**
     * The fix, tested at its boundary rather than through its caller.
     *
     * `pruneSessions` moved to `lib/auth/session-maintenance` precisely so a
     * non-request runtime could reach it, and `lib/auth/session` re-exports it for
     * compatibility. This asserts the module stays clean — a future edit adding a
     * `next/headers` import, or the marker, would silently kill the scheduler again,
     * and under vitest's alias nothing else would notice.
     */
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(process.cwd(), "src", "lib", "auth", "session-maintenance.ts"),
      "utf8",
    );

    // Matched as import statements, not as substrings: the module's docblock names
    // `next/headers` while explaining why it must not import it, and a substring
    // check would fail on the explanation rather than on a real regression.
    const imports = [...source.matchAll(/^\s*import\s[^\n]*$/gm)].map((m) => m[0]);
    for (const forbidden of ["server-only", "next/headers", "next/server"]) {
      expect(
        imports.filter((line) => line.includes(forbidden)),
        `session-maintenance must not import ${forbidden}`,
      ).toEqual([]);
    }

    // And the scheduler reaches it directly, not through the marked module.
    const scheduler = readFileSync(
      join(process.cwd(), "src", "scheduler", "tasks.ts"),
      "utf8",
    );
    expect(scheduler).toContain("@/lib/auth/session-maintenance");
    expect(scheduler).not.toMatch(/from "@\/lib\/auth\/session"/);
  });
});
