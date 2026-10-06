/**
 * Prove the automation and publish paths work in a real Node process (§14, §19).
 *
 * `scripts/verify-worker.ts` exists because Phase 5 learned the hard way that a
 * green Vitest run can hide a runtime defect: every shared module carried
 * `import "server-only"`, the config aliased it to a stub, and 541 tests passed
 * against a worker that could not boot. Phase 7 hit the same class of defect from
 * the other direction — `dueChannels` interpolated a `Date` into a raw `sql`
 * template, which postgres.js rejects at Bind, so the scheduler's very first query
 * threw on every tick. That one *did* surface in the integration suite, but only
 * because the suite reaches a real database; a mocked `db` would have returned rows
 * and the scheduler would have been broken in production with a full green board.
 *
 * So this script runs the same code the scheduler process runs, with no test
 * framework, no aliases, and no mocked modules:
 *
 *   1. the process starts and `.env.local` loads
 *   2. Postgres answers and the automation/publish tables exist
 *   3. `dueChannels` executes — the query whose parameter binding broke
 *   4. `nextSlot` resolves a zoned cadence, including across a DST boundary
 *   5. the OAuth scope set is sufficient for upload + thumbnail, and a legacy
 *      grant is correctly reported as needing re-authorisation
 *   6. the publish path's §40 guard is reported honestly
 *   7. the `publish` queue exists in BullMQ and accepts a connection
 *
 * Read-only apart from step 7's connection: it creates no user, no channel, no
 * project and no job, so it is safe to run against a database with real rows.
 *
 *   npx tsx scripts/verify-automation.ts
 *
 * §17: prints no credential values, no access tokens and no refresh tokens —
 * configuration is reported as PRESENT/ABSENT and scopes by name only.
 * §9: performs no YouTube upload. A real upload would put a test video on a real
 * channel, which this script has no authority to do.
 *
 * Its own queue prefix, so it cannot consume a developer's jobs. Exits non-zero on
 * the first failure.
 */
import "@/lib/load-env";

const PREFIX = "vidxir-verify";
process.env["QUEUE_PREFIX"] = PREFIX;

const TOTAL_STEPS = 7;
let step = 0;

function ok(message: string): void {
  step += 1;
  console.log(`  ${step}. OK  ${message}`);
}

function detail(message: string): void {
  console.log(`        ${message}`);
}

async function main(): Promise<void> {
  console.log(`\nautomation + publish verification (queue prefix ${PREFIX})\n`);

  // ---- 1. process + environment ------------------------------------------
  const { env, realPublishBlocked, usingMockProviders } = await import("@/lib/env");
  const e = env();
  ok(
    `environment loaded (NODE_ENV=${e.NODE_ENV}, ` +
      `mockProviders=${String(usingMockProviders())}, ` +
      `blockRealPublish=${String(realPublishBlocked())})`,
  );

  // ---- 2. schema ---------------------------------------------------------
  const { db, rawSql, closeDb } = await import("@/lib/db");
  const {
    automationSettings,
    publishJobs,
    publishedVideos,
  } = await import("@/lib/db/schema");

  const [version] = await rawSql()`select version()`;
  const banner = String(version?.["version"] ?? "").split(",")[0];

  /**
   * A real query against each table Phase 7 depends on. `select version()` would
   * pass against an empty database; the scheduler needs the migrations applied.
   */
  await db.select({ id: automationSettings.channelId }).from(automationSettings).limit(1);
  await db.select({ id: publishJobs.id }).from(publishJobs).limit(1);
  await db.select({ id: publishedVideos.id }).from(publishedVideos).limit(1);
  ok(
    `${banner} answered — automation_settings, publish_jobs and ` +
      `published_videos all present`,
  );

  // ---- 3. the scheduler's eligibility query ------------------------------
  /**
   * The exact call `runAutomationTick` makes first. It is listed as its own step
   * because it is the one that was broken: a `Date` bound through a raw `sql`
   * template throws before Postgres sees the statement, so this fails identically
   * whether the table is empty or full — which is what makes it a real check rather
   * than a data-dependent one.
   */
  const { dueChannels } = await import("@/lib/automation/service");
  const due = await dueChannels(new Date());
  ok(`dueChannels() executed — ${due.length} channel(s) currently due`);
  if (due.length > 0) {
    // Ids only. Nothing here identifies a person, and no token is read.
    detail(
      `due channelIds: ${due.map((c) => c.channelId.slice(0, 8)).join(", ")}`,
    );
  }

  // ---- 4. cadence arithmetic ---------------------------------------------
  const { nextSlot } = await import("@/lib/automation/cadence");
  const cadence = {
    publishDays: [1],
    publishTimes: ["18:00"],
    timezone: "Europe/London",
  };
  // Monday 2026-03-23 is GMT; the next Monday slot is 2026-03-30, by which time
  // London is on BST, so 18:00 local is 17:00Z rather than 18:00Z.
  const spring = nextSlot(cadence, new Date("2026-03-23T18:00:00Z"));
  if (spring?.toISOString() !== "2026-03-30T17:00:00.000Z") {
    throw new Error(
      `cadence resolved a DST boundary to ${String(spring?.toISOString())}, ` +
        `expected 2026-03-30T17:00:00.000Z`,
    );
  }
  // And the same wall clock before the transition.
  const winter = nextSlot(cadence, new Date("2026-03-16T18:00:00Z"));
  if (winter?.toISOString() !== "2026-03-23T18:00:00.000Z") {
    throw new Error(
      `cadence resolved a GMT slot to ${String(winter?.toISOString())}, ` +
        `expected 2026-03-23T18:00:00.000Z`,
    );
  }
  ok(
    "cadence resolved 18:00 Europe/London on both sides of the spring transition " +
      "(18:00Z in GMT, 17:00Z in BST)",
  );

  // ---- 5. OAuth scopes ---------------------------------------------------
  const {
    YOUTUBE_SCOPES,
    isYouTubeConfigured,
    missingRequiredScopes,
    youtubeMissingEnvVars,
  } = await import("@/lib/providers/youtube");

  /**
   * §8: does Phase 7 need a new scope? Asked of the code rather than assumed.
   * `youtube.upload` uploads the video and `youtube` (read/write) is what
   * `thumbnails.set` and `videos.update` require, so a grant carrying both is
   * sufficient and no new consent scope is introduced.
   */
  const fullGrant = YOUTUBE_SCOPES.join(" ");
  const stillMissing = missingRequiredScopes(fullGrant);
  if (stillMissing.length > 0) {
    throw new Error(
      `the requested scope set is insufficient — missing ${stillMissing.join(", ")}`,
    );
  }

  /**
   * And the legacy case: a channel authorised before Phase 7 may hold only
   * `youtube.upload`. That must be *detected*, not assumed away — the publish
   * service turns this into a ReauthRequiredError that routes the user through the
   * existing reconnect flow rather than failing mid-upload.
   */
  const legacyGrant = "https://www.googleapis.com/auth/youtube.upload";
  const legacyMissing = missingRequiredScopes(legacyGrant);
  if (legacyMissing.length === 0) {
    throw new Error(
      "a pre-Phase-7 grant holding only youtube.upload was reported as sufficient; " +
        "such a channel cannot set a thumbnail and must be sent back to consent",
    );
  }

  // Names only — never a client id, secret or token value.
  ok(
    `OAuth scopes sufficient for upload + thumbnail; requested: ` +
      `${YOUTUBE_SCOPES.map((s) => s.split("/auth/")[1]).join(", ")}`,
  );
  detail(
    `legacy upload-only grant correctly reported as missing: ` +
      `${legacyMissing.map((s) => s.split("/auth/")[1]).join(", ")}`,
  );
  detail(
    `Google OAuth client credentials: ` +
      (isYouTubeConfigured()
        ? "PRESENT (values not read or printed)"
        : `ABSENT (${youtubeMissingEnvVars().join(", ")})`),
  );

  // ---- 6. the publish guard ----------------------------------------------
  /**
   * §40/§9 stated as a fact rather than glossed. With `VIDXIR_BLOCK_REAL_PUBLISH`
   * set, `uploadVideo` throws `PublishBlockedError` before a byte leaves the
   * machine, so no local run of this script can upload — which is also why a real
   * end-to-end YouTube confirmation cannot be demonstrated here. The guard is
   * verified by *reading* it; deliberately not by attempting an upload against
   * someone's channel.
   */
  const { PublishBlockedError } = await import("@/lib/errors");
  const blocked = realPublishBlocked();
  const guard = new PublishBlockedError();
  if (guard.retryable) {
    throw new Error("the dev-mode publish guard is marked retryable; it must not be");
  }
  ok(
    blocked
      ? `real publishing is BLOCKED by VIDXIR_BLOCK_REAL_PUBLISH — uploadVideo() and ` +
          `setThumbnail() throw ${guard.code} before any network call, so no ` +
          `end-to-end YouTube upload is verifiable in this environment`
      : `real publishing is ENABLED — uploadVideo() will reach youtube.com; ` +
          `${guard.code} is non-retryable when the guard is on`,
  );

  // ---- 7. the publish queue ---------------------------------------------
  const { getQueue, closeQueues } = await import("@/lib/queue/queues");
  const { CONCURRENCY } = await import("@/worker/registry");
  const queue = getQueue("publish");
  // Resolves only once the connection is usable, so a dead Redis fails here rather
  // than deferring the error into the first real publish.
  await queue.waitUntilReady();
  ok(
    `BullMQ connected — queue "${queue.name}" ready at concurrency ` +
      `${CONCURRENCY.publish} (serialised, so one project cannot upload twice at once)`,
  );

  // Nothing was enqueued, but the prefix is this script's own, so clearing it
  // cannot touch a developer's queue.
  await queue.obliterate({ force: true });
  await closeQueues();
  const { closeRedis } = await import("@/lib/queue/redis");
  await closeRedis();
  await closeDb();

  console.log(
    `\n${step}/${TOTAL_STEPS} checks passed — the automation engine's queries, ` +
      `cadence maths, scope requirements and publish queue all work under real Node.` +
      (blocked
        ? `\nNot verified: an actual YouTube upload. VIDXIR_BLOCK_REAL_PUBLISH ` +
          `prevents it, and §9 forbids uploading test content to an unknown channel.`
        : "") +
      "\n",
  );
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
