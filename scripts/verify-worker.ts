/**
 * Prove the standalone worker actually runs (§10, §31, §42).
 *
 * The unit tests drive the harness with a fake job, which proves the retry
 * decision but not that this process can *boot*: for a long time it could not.
 * Every shared module carried `import "server-only"` — a bundler directive whose
 * Node implementation throws unconditionally — so `npx tsx src/worker/index.ts`
 * died on the first provider import. Vitest aliased the marker to a stub, so 541
 * tests passed green against a worker that could not start. Nothing in the suite
 * could have caught it, because the suite was the thing hiding it.
 *
 * So this checks the boot path end to end, in a real Node process, with no
 * aliases:
 *
 *   1. the process starts and `.env.local` is loaded
 *   2. BullMQ connects to Redis
 *   3. the database answers a query
 *   4. the provider layer imports and reports its configuration
 *   5. a job enqueued through the real `enqueue()` is consumed by a real `Worker`
 *      and its `jobs` row reaches a terminal state
 *
 * Step 5 uses a `maintenance` job with a deterministic local handler rather than
 * a pipeline stage: the point is the transport and the row transitions, and a real
 * render would spend provider credits to prove something the pipeline tests
 * already cover.
 *
 *   npx tsx scripts/verify-worker.ts
 *
 * Its own queue prefix, so a run cannot consume a developer's jobs or leave
 * messages behind for one. Exits non-zero on the first failure.
 */
import "@/lib/load-env";

const PREFIX = "vidxir-verify";
process.env["QUEUE_PREFIX"] = PREFIX;

let step = 0;

function ok(message: string): void {
  step += 1;
  console.log(`  ${step}. OK  ${message}`);
}

async function main(): Promise<void> {
  console.log(`\nworker boot verification (queue prefix ${PREFIX})\n`);

  // ---- 1. process + environment ------------------------------------------
  const { env } = await import("@/lib/env");
  const e = env();
  ok(
    `environment loaded (NODE_ENV=${e.NODE_ENV}, mocks=${String(
      e.VIDXIR_USE_MOCK_PROVIDERS,
    )})`,
  );

  // ---- 2. BullMQ / Redis --------------------------------------------------
  const { getQueue, closeQueues } = await import("@/lib/queue/queues");
  const queue = getQueue("maintenance");
  // `waitUntilReady` resolves only once the connection is usable, so this fails
  // loudly rather than deferring the error into the first enqueue.
  await queue.waitUntilReady();
  ok(`BullMQ connected to Redis (queue ${queue.name})`);

  // ---- 3. database -------------------------------------------------------
  const { rawSql, closeDb } = await import("@/lib/db");
  const [version] = await rawSql()`select version()`;
  const banner = String(version?.["version"] ?? "").split(",")[0];
  const { jobs } = await import("@/lib/db/schema");
  const { db } = await import("@/lib/db");
  // A schema-aware query too: `select version()` would pass against an empty
  // database, and the worker needs the migrations to have run.
  await db.select({ id: jobs.id }).from(jobs).limit(1);
  ok(`database answered (${banner}), jobs table present`);

  // ---- 4. provider layer -------------------------------------------------
  const { providerStatuses } = await import("@/lib/providers/config");
  const statuses = providerStatuses();
  const ready = statuses.filter((c) => c.state === "ready").length;
  const mock = statuses.filter((c) => c.state === "mock").length;
  ok(
    `provider layer imported — ${ready} ready, ${mock} mock, ` +
      `${statuses.length - ready - mock} not configured\n` +
      statuses
        .map(
          (c) =>
            `        ${c.capability.padEnd(14)} ${c.state.padEnd(15)} ${c.provider}` +
            (c.missingEnvVars.length > 0
              ? ` (missing ${c.missingEnvVars.join(", ")})`
              : ""),
        )
        .join("\n"),
  );

  // ---- 5. a real job, through Redis, by a real Worker --------------------
  const { Worker } = await import("bullmq");
  const { workerConnection } = await import("@/lib/queue/redis");
  const { workerQueueOptions } = await import("@/lib/queue/queues");
  const { runJob } = await import("@/worker/runner");
  const { enqueue, getJob } = await import("@/lib/queue/jobs");
  const { users, subscriptions } = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");

  /**
   * A user row, because `jobs.user_id` is a foreign key — the schema will not let
   * a job exist without an owner, which is the tenant-isolation invariant working
   * as intended. Reused across runs and left behind deliberately: it is a
   * recognisable local fixture, not a real account (the password hash is not a
   * valid scrypt digest, so it cannot be signed into).
   */
  const email = "worker-verify@vidxir.local";
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  let userId = existing[0]?.id;
  if (!userId) {
    const inserted = await db
      .insert(users)
      .values({
        email,
        // The schema keeps a normalised copy for the uniqueness index; the real
        // signup path lowercases it, so this does too.
        emailNormalized: email.toLowerCase(),
        name: "Worker Verification",
        passwordHash: "not-a-loginable-hash",
      })
      .returning({ id: users.id });
    userId = inserted[0]?.id;
    if (!userId) throw new Error("could not create the verification user");
    await db.insert(subscriptions).values({ userId, tier: "starter", status: "active" });
  }

  const marker = `verify-${process.pid}`;
  let handled: string | null = null;

  const worker = new Worker(
    "maintenance",
    async (job) =>
      (
        await runJob(
          "maintenance",
          {
            // Deterministic, local, no provider calls: it echoes the payload back
            // so the assertion below can prove *this* message was the one run.
            "verify-echo": async ({ payload }) => {
              handled = String(payload["marker"]);
              return { echoed: payload["marker"] };
            },
          },
          job,
        )
      ).result,
    {
      connection: workerConnection(),
      concurrency: 1,
      ...workerQueueOptions(),
    },
  );

  await worker.waitUntilReady();

  const enqueued = await enqueue({
    queue: "maintenance",
    name: "verify-echo",
    userId,
    payload: { marker },
    maxAttempts: 1,
  });

  // Poll the row rather than the BullMQ event, because the row is what the
  // product reads (§45) — that is the transition worth proving.
  const deadline = Date.now() + 30_000;
  let view = await getJob(userId, enqueued.id);
  while (view && view.status !== "succeeded" && view.status !== "failed") {
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 250));
    view = await getJob(userId, enqueued.id);
  }

  await worker.close();

  if (!view) throw new Error("the job row disappeared");
  if (view.status !== "succeeded") {
    throw new Error(
      `job ended ${view.status}: ${view.error ?? "(no message)"} [${
        view.errorCode ?? "no code"
      }]`,
    );
  }
  if (handled !== marker) {
    throw new Error(`handler ran with the wrong payload: ${String(handled)}`);
  }
  ok(
    `job ${enqueued.id} enqueued, consumed and recorded ` +
      `succeeded at ${view.progress}%`,
  );

  // Leave no messages behind for a developer's worker.
  await queue.obliterate({ force: true });
  await closeQueues();
  const { closeRedis } = await import("@/lib/queue/redis");
  await closeRedis();
  await closeDb();

  console.log(`\n${step}/5 checks passed — the standalone worker runs.\n`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(
      `\n  FAIL at step ${step + 1}: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\n`,
    );
    process.exit(1);
  },
);
