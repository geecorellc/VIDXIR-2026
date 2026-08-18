/**
 * The automation engine (§19, §34, and Phase 7's §13 automation list).
 *
 * The property under test is **idempotency**, and it is worth being precise about
 * why a mock cannot establish it. The scheduler's claim is a compare-and-swap in
 * Postgres:
 *
 *     UPDATE automation_settings SET next_run_at = ?, last_run_at = ?
 *      WHERE channel_id = ? AND next_run_at IS NOT DISTINCT FROM <observed>
 *
 * Whether exactly one of two racing callers gets a row back is a property of that
 * statement executing against a real database under READ COMMITTED. A mocked `db`
 * would return whatever the test author decided, which is the same as asserting the
 * conclusion. So these tests run the real query, and the duplicate-prevention cases
 * below run ticks *concurrently* rather than in sequence — sequential calls would
 * pass even with no CAS at all, because the first would have committed
 * `next_run_at` before the second read it.
 *
 * The failure mode this guards against is not a wasted cycle: it is two projects,
 * two script generations and two rendered videos billed against one publish slot.
 *
 * Real here: Postgres, the migrations, `dueChannels`, `claimSlot`, the in-flight and
 * active-job guards, plan enforcement, idea selection, `createProject`, and the
 * state transition `startScriptGeneration` performs. Mocked: `enqueue`, the single
 * function that pushes to Redis — so the suite needs no running worker. Stated
 * plainly so the report can be honest: **these tests do not prove a BullMQ message
 * was consumed.** They prove the engine decides correctly and claims exactly once.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChannel,
  createUser,
  hasDatabase,
  resetDatabase,
  setTier,
  useDatabase,
} from "./setup";

/**
 * The queue boundary, and only it.
 *
 * `startScriptGeneration` stays real: whether the script job is even *reached* is
 * half of what the engine decides, and the SCRIPT_GENERATING transition it performs
 * is what the in-flight guard reads on the next tick. The mock still writes a real
 * `jobs` row, because `hasActiveJob` reads that table and the "script already
 * running" guard is one of the cases below — returning a bare id would make that
 * guard untestable.
 */
const enqueue = vi.hoisted(() => vi.fn());

vi.mock("@/lib/queue/jobs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queue/jobs")>();
  return { ...actual, enqueue };
});

const suite = hasDatabase ? describe : describe.skip;

suite("automation engine (integration)", () => {
  useDatabase();

  afterAll(async () => {
    // Nothing here should have opened a queue, since `enqueue` is mocked. Closing
    // anyway, so a future test that does reach Redis cannot leave the run hanging.
    const { closeQueues } = await import("@/lib/queue/queues");
    const { closeRedis } = await import("@/lib/queue/redis");
    await closeQueues();
    await closeRedis();
  });

  beforeEach(async () => {
    await resetDatabase();
    enqueue.mockReset();
    enqueue.mockImplementation(async (input: Record<string, unknown>) => {
      const { db } = await import("@/lib/db");
      const { jobs } = await import("@/lib/db/schema");
      const [row] = await db
        .insert(jobs)
        .values({
          userId: input["userId"] as string,
          channelId: (input["channelId"] as string | null) ?? null,
          projectId: (input["projectId"] as string | null) ?? null,
          queue: input["queue"] as "pipeline",
          name: input["name"] as string,
          status: "queued",
          payload: (input["payload"] as Record<string, unknown>) ?? {},
        })
        .returning({ id: jobs.id });
      if (!row) throw new Error("Failed to insert stub job row");
      return { id: row.id, queue: input["queue"], name: input["name"], status: "queued" };
    });
  });

  // -------------------------------------------------------------------------
  // Fixture
  // -------------------------------------------------------------------------

  interface AutomationOptions {
    enabled?: boolean;
    publishDays?: number[];
    publishTimes?: string[];
    timezone?: string;
    /** Omit for null — "never computed", which `dueChannels` treats as due. */
    nextRunAt?: Date | null;
  }

  interface ChannelOptions {
    /** Tally scores, highest wins. `null` stands for scoring never having finished. */
    ideaScores?: Array<number | null>;
    disconnected?: boolean;
    reauthRequired?: boolean;
  }

  /**
   * A user with one channel, automation on and due, and scored ideas to choose
   * from — the state a real channel is in when the scheduler wakes up.
   *
   * The default cadence is every day at four times, so "is it due?" is decided by
   * `nextRunAt` alone and no test is sensitive to the weekday it runs on.
   */
  async function channel(
    email: string,
    automation: AutomationOptions = {},
    options: ChannelOptions = {},
  ) {
    const { db } = await import("@/lib/db");
    const { automationSettings, channels, ideas } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");

    const user = await createUser({ email });
    const channelId = await createChannel(user.id);

    if (options.disconnected) {
      await db
        .update(channels)
        .set({ disconnectedAt: new Date() })
        .where(eq(channels.id, channelId));
    }
    if (options.reauthRequired) {
      await db
        .update(channels)
        .set({ reauthRequiredAt: new Date() })
        .where(eq(channels.id, channelId));
    }

    await db.insert(automationSettings).values({
      channelId,
      userId: user.id,
      enabled: automation.enabled ?? true,
      level: "autopilot",
      publishDays: automation.publishDays ?? [0, 1, 2, 3, 4, 5, 6],
      publishTimes: automation.publishTimes ?? ["00:00", "06:00", "12:00", "18:00"],
      timezone: automation.timezone ?? "UTC",
      nextRunAt: automation.nextRunAt ?? null,
    });

    const scores = options.ideaScores ?? [42.5, 88.25, 61];
    const seeded: Array<{ id: string; score: number | null }> = [];
    for (const score of scores) {
      const [row] = await db
        .insert(ideas)
        .values({
          userId: user.id,
          channelId,
          title: `Idea scoring ${score ?? "nothing"}`,
          state: "new",
          tallyScore: score,
        })
        .returning({ id: ideas.id });
      if (!row) throw new Error("Failed to insert test idea");
      seeded.push({ id: row.id, score });
    }

    return { user, channelId, ideas: seeded };
  }

  async function projectsFor(userId: string) {
    const { db } = await import("@/lib/db");
    const { projects } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    return db.select().from(projects).where(eq(projects.userId, userId));
  }

  async function settingsFor(channelId: string) {
    const { db } = await import("@/lib/db");
    const { automationSettings } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(automationSettings)
      .where(eq(automationSettings.channelId, channelId));
    const row = rows[0];
    if (!row) throw new Error("Automation settings row missing");
    return row;
  }

  /** Close every job for a user, so `hasActiveJob` is not the guard under test. */
  async function finishJobs(userId: string) {
    const { db } = await import("@/lib/db");
    const { jobs } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(jobs).set({ status: "succeeded" }).where(eq(jobs.userId, userId));
  }

  /** Use up a starter plan's monthly video allowance. */
  async function exhaustAllowance(userId: string) {
    const { db } = await import("@/lib/db");
    const { usageCounters } = await import("@/lib/db/schema");
    const { currentPeriod } = await import("@/lib/projects/service");
    await setTier(userId, "starter");
    await db
      .insert(usageCounters)
      .values({ userId, period: currentPeriod(), videosStarted: 4 });
  }

  // -------------------------------------------------------------------------
  // Eligibility
  // -------------------------------------------------------------------------

  describe("choosing which channels run", () => {
    it("starts a video for a due channel and advances its cadence", async () => {
      const { user, channelId } = await channel("due@tally.test");
      const now = new Date("2026-03-02T12:00:00Z");

      const { runAutomationTick } = await import("@/lib/automation/service");
      const result = await runAutomationTick(now);

      expect(result).toEqual({ considered: 1, started: 1, skipped: 0, failed: 0 });

      const created = await projectsFor(user.id);
      expect(created).toHaveLength(1);
      expect(created[0]!.channelId).toBe(channelId);
      // `origin` is what distinguishes an automated video from a hand-started one
      // everywhere downstream.
      expect(created[0]!.origin).toBe("automation");
      // Queued, not merely created: the pipeline is genuinely moving (§42).
      expect(created[0]!.status).toBe("SCRIPT_GENERATING");
      expect(enqueue).toHaveBeenCalledTimes(1);

      const settings = await settingsFor(channelId);
      expect(settings.lastRunAt?.getTime()).toBe(now.getTime());
      // Strictly forward, or the same slot would be claimed again next tick.
      expect(settings.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());
      expect(settings.nextRunAt!.toISOString()).toBe("2026-03-02T18:00:00.000Z");
    }, 120_000);

    it("ignores a channel whose automation is switched off", async () => {
      const { user, channelId } = await channel("off@tally.test", { enabled: false });

      const { runAutomationTick } = await import("@/lib/automation/service");
      const result = await runAutomationTick(new Date("2026-03-02T12:00:00Z"));

      expect(result.considered).toBe(0);
      expect(await projectsFor(user.id)).toHaveLength(0);
      // Not claimed either: a disabled channel's cadence must not drift forward
      // while it is off, or re-enabling it would look like it had already run.
      expect((await settingsFor(channelId)).lastRunAt).toBeNull();
    }, 120_000);

    it("ignores a channel that is not due yet", async () => {
      const { user } = await channel("early@tally.test", {
        nextRunAt: new Date("2026-03-02T18:00:00Z"),
      });

      const { runAutomationTick } = await import("@/lib/automation/service");
      // An hour before the slot.
      const result = await runAutomationTick(new Date("2026-03-02T17:00:00Z"));

      expect(result.considered).toBe(0);
      expect(await projectsFor(user.id)).toHaveLength(0);
    }, 120_000);

    it("skips a channel that needs reconnecting rather than spending on it", async () => {
      /**
       * The channel cannot publish until the user reconnects it, so generating a
       * script, a voiceover and a render would spend real provider budget on a video
       * with nowhere to go.
       */
      const { user } = await channel("reauth@tally.test", {}, { reauthRequired: true });

      const { runAutomationTick } = await import("@/lib/automation/service");
      const result = await runAutomationTick(new Date("2026-03-02T12:00:00Z"));

      expect(result.considered).toBe(0);
      expect(await projectsFor(user.id)).toHaveLength(0);
    }, 120_000);

    it("skips a disconnected channel", async () => {
      const { user } = await channel("gone@tally.test", {}, { disconnected: true });

      const { runAutomationTick } = await import("@/lib/automation/service");
      const result = await runAutomationTick(new Date("2026-03-02T12:00:00Z"));

      expect(result.considered).toBe(0);
      expect(await projectsFor(user.id)).toHaveLength(0);
    }, 120_000);

    it("does not claim a slot for a cadence that can never fire", async () => {
      /**
       * Enabled with no publish days. There is no next slot to advance to, so
       * claiming would write null and leave the channel permanently due — logging on
       * every tick for ever. It is reported as a skip and left alone instead.
       */
      const { user, channelId } = await channel("empty@tally.test", { publishDays: [] });

      const { runAutomationTick } = await import("@/lib/automation/service");
      const result = await runAutomationTick(new Date("2026-03-02T12:00:00Z"));

      expect(result).toEqual({ considered: 1, started: 0, skipped: 1, failed: 0 });
      expect(await projectsFor(user.id)).toHaveLength(0);
      expect((await settingsFor(channelId)).lastRunAt).toBeNull();
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  // Idea selection
  // -------------------------------------------------------------------------

  describe("choosing what to make", () => {
    it("picks the highest-scoring idea, not the newest", async () => {
      const { user, ideas: seeded } = await channel(
        "score@tally.test",
        {},
        // 88.25 is seeded second, so recency ordering would pick 61.
        { ideaScores: [42.5, 88.25, 61] },
      );
      const best = seeded.find((idea) => idea.score === 88.25)!;

      const { runAutomationTick } = await import("@/lib/automation/service");
      await runAutomationTick(new Date("2026-03-02T12:00:00Z"));

      const created = await projectsFor(user.id);
      expect(created).toHaveLength(1);
      // The whole point of the scoring engine: automation acts on the Tally
      // Opportunity Score.
      expect(created[0]!.ideaId).toBe(best.id);
      expect(created[0]!.title).toBe("Idea scoring 88.25");

      // And the idea is consumed, so the next slot cannot remake the same video.
      const { db } = await import("@/lib/db");
      const { ideas } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const rows = await db
        .select({ state: ideas.state })
        .from(ideas)
        .where(eq(ideas.id, best.id));
      expect(rows[0]!.state).toBe("used");
    }, 120_000);

    it("will not make a video from an idea the scorer never judged", async () => {
      /**
       * An unscored idea means scoring did not complete. Sorting it last would still
       * pick it once the scored ones ran out, producing a video from something the
       * system never judged, so it is excluded outright.
       */
      const { user, channelId } = await channel(
        "unscored@tally.test",
        {},
        { ideaScores: [null, null] },
      );

      const { runAutomationTick } = await import("@/lib/automation/service");
      const result = await runAutomationTick(new Date("2026-03-02T12:00:00Z"));

      expect(result).toEqual({ considered: 1, started: 0, skipped: 1, failed: 0 });
      expect(await projectsFor(user.id)).toHaveLength(0);
      /**
       * The slot *was* claimed here, unlike the empty-cadence case: the cadence is
       * valid, so the channel waits for its next slot — by which time research may
       * have finished — rather than retrying on every tick.
       */
      expect((await settingsFor(channelId)).nextRunAt!.toISOString()).toBe(
        "2026-03-02T18:00:00.000Z",
      );
    }, 120_000);

    it("skips a channel with no ideas at all without failing the pass", async () => {
      const { user } = await channel("noideas@tally.test", {}, { ideaScores: [] });

      const { runAutomationTick } = await import("@/lib/automation/service");
      const result = await runAutomationTick(new Date("2026-03-02T12:00:00Z"));

      // A new channel legitimately has nothing yet. Not an error.
      expect(result).toEqual({ considered: 1, started: 0, skipped: 1, failed: 0 });
      expect(await projectsFor(user.id)).toHaveLength(0);
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  // Duplicate prevention — the reason this file exists
  // -------------------------------------------------------------------------

  describe("no duplicate videos", () => {
    it("claims once when two schedulers hold the same candidate", async () => {
      /**
       * The CAS itself, pinned deterministically.
       *
       * Two `runForChannel` calls given *identical* candidates — both already past
       * the eligibility read, both holding `nextRunAt: null` — which is precisely the
       * state two overlapping scheduler instances are in. There is no earlier filter
       * left to save them: the only thing that can stop the second is the
       * compare-and-swap, so this case cannot pass without one.
       */
      const { user, channelId } = await channel("cas@tally.test");
      const candidate = {
        channelId,
        userId: user.id,
        level: "autopilot" as const,
        publishDays: [0, 1, 2, 3, 4, 5, 6],
        publishTimes: ["00:00", "06:00", "12:00", "18:00"],
        timezone: "UTC",
        videosPerWeek: 3,
        autoPublish: false,
        requireApproval: true,
        nextRunAt: null,
        lastRunAt: null,
      };
      const now = new Date("2026-03-02T12:00:00Z");

      const { runForChannel } = await import("@/lib/automation/service");
      const [first, second] = await Promise.all([
        runForChannel({ ...candidate }, now),
        runForChannel({ ...candidate }, now),
      ]);

      // Exactly one winner. Which call wins is undefined; that only one does is not.
      const started = [first, second].filter((outcome) => outcome.started);
      const lost = [first, second].filter((outcome) => !outcome.started);
      expect(started).toHaveLength(1);
      expect(lost).toHaveLength(1);
      // And the loser lost *to the claim*, not to some later guard that happened to
      // fire — that distinction is the whole point of the case.
      expect(lost[0]!.reason).toBe("slot_taken");

      // The assertion that actually matters — one project, one script job, one
      // video's worth of provider spend.
      expect(await projectsFor(user.id)).toHaveLength(1);
      expect(enqueue).toHaveBeenCalledTimes(1);
    }, 120_000);

    it("starts one video when two ticks run concurrently", async () => {
      /**
       * The same race one level up, through the whole tick.
       *
       * Two loser paths are legitimate here and which one occurs is timing: the
       * second tick either reaches the CAS and is refused, or its `dueChannels` read
       * lands after the winner committed `next_run_at` and it never sees the channel
       * at all (`considered: 0`). Both prevent the duplicate, so the invariant is
       * asserted on the outcome rather than on the mechanism — the case above is
       * where the CAS is pinned deliberately.
       */
      const { user } = await channel("race@tally.test");
      const now = new Date("2026-03-02T12:00:00Z");

      const { runAutomationTick } = await import("@/lib/automation/service");
      const results = await Promise.all([
        runAutomationTick(now),
        runAutomationTick(now),
      ]);

      expect(results.reduce((total, r) => total + r.started, 0)).toBe(1);
      expect(results.reduce((total, r) => total + r.failed, 0)).toBe(0);
      // Nothing was silently dropped: every channel a tick considered was either
      // started or skipped.
      for (const result of results) {
        expect(result.started + result.skipped).toBe(result.considered);
      }

      expect(await projectsFor(user.id)).toHaveLength(1);
      expect(enqueue).toHaveBeenCalledTimes(1);
    }, 120_000);

    it("claims once when four schedulers pile up", async () => {
      // A wider race. The CAS is either correct or it is not, but four callers
      // contending on one row makes a lucky pass much less likely than two.
      const { user, channelId } = await channel("cas4@tally.test");
      const candidate = {
        channelId,
        userId: user.id,
        level: "autopilot" as const,
        publishDays: [0, 1, 2, 3, 4, 5, 6],
        publishTimes: ["00:00", "06:00", "12:00", "18:00"],
        timezone: "UTC",
        videosPerWeek: 3,
        autoPublish: false,
        requireApproval: true,
        nextRunAt: null,
        lastRunAt: null,
      };
      const now = new Date("2026-03-02T12:00:00Z");

      const { runForChannel } = await import("@/lib/automation/service");
      const outcomes = await Promise.all(
        Array.from({ length: 4 }, () => runForChannel({ ...candidate }, now)),
      );

      expect(outcomes.filter((outcome) => outcome.started)).toHaveLength(1);
      expect(
        outcomes.filter((outcome) => outcome.reason === "slot_taken"),
      ).toHaveLength(3);
      expect(await projectsFor(user.id)).toHaveLength(1);
      expect(enqueue).toHaveBeenCalledTimes(1);
    }, 120_000);

    it("does not start a second video while the first is still in progress", async () => {
      /**
       * The case the CAS cannot catch: this slot was claimed legitimately, hours
       * after the previous one, and that video is still rendering. Two concurrent
       * pipelines on one channel would race on `hasActiveJob` at every stage.
       */
      const { user, channelId } = await channel("inflight@tally.test");

      const { runAutomationTick } = await import("@/lib/automation/service");
      await runAutomationTick(new Date("2026-03-02T12:00:00Z"));
      expect(await projectsFor(user.id)).toHaveLength(1);

      // Close the script job, so the in-flight *project* check is what refuses
      // rather than `hasActiveJob`.
      await finishJobs(user.id);

      // The next slot arrives; the first video is still at SCRIPT_GENERATING.
      const result = await runAutomationTick(new Date("2026-03-02T18:00:00Z"));

      expect(result).toEqual({ considered: 1, started: 0, skipped: 1, failed: 0 });
      expect(await projectsFor(user.id)).toHaveLength(1);
      // The slot still moved on, so the channel is not stuck retrying.
      expect((await settingsFor(channelId)).nextRunAt!.getTime()).toBeGreaterThan(
        new Date("2026-03-02T18:00:00Z").getTime(),
      );
    }, 120_000);

    it("resumes automation once the previous video is published", async () => {
      /**
       * The other half of the in-flight rule: it must not be permanent. A channel
       * whose video reached a terminal state is free to start the next one, or
       * automation would stop for good after exactly one video.
       */
      const { user } = await channel("resume@tally.test");

      const { runAutomationTick } = await import("@/lib/automation/service");
      await runAutomationTick(new Date("2026-03-02T12:00:00Z"));
      const [first] = await projectsFor(user.id);

      // The status is set directly: walking the whole pipeline is the publish
      // suite's job, and what this case needs is only the terminal status.
      const { db } = await import("@/lib/db");
      const { projects } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      await db
        .update(projects)
        .set({ status: "PUBLISHED" })
        .where(eq(projects.id, first!.id));
      await finishJobs(user.id);

      const result = await runAutomationTick(new Date("2026-03-02T18:00:00Z"));

      expect(result.started).toBe(1);
      expect(await projectsFor(user.id)).toHaveLength(2);
    }, 120_000);

    it("does not start a video while a script job is already queued", async () => {
      /**
       * A queued `jobs` row with no project in an in-flight state — the shape a crash
       * between `createProject` and its transition leaves behind. The project check
       * misses it; `hasActiveJob` is the second line.
       */
      const { user, channelId } = await channel("scriptjob@tally.test");

      const { db } = await import("@/lib/db");
      const { jobs } = await import("@/lib/db/schema");
      const { SCRIPT_JOB_NAME } = await import("@/lib/scripts/service");
      await db.insert(jobs).values({
        userId: user.id,
        channelId,
        queue: "pipeline",
        name: SCRIPT_JOB_NAME,
        status: "queued",
      });

      const { runAutomationTick } = await import("@/lib/automation/service");
      const result = await runAutomationTick(new Date("2026-03-02T12:00:00Z"));

      expect(result).toEqual({ considered: 1, started: 0, skipped: 1, failed: 0 });
      expect(await projectsFor(user.id)).toHaveLength(0);
      expect(enqueue).not.toHaveBeenCalled();
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  // Limits, failures, and the cadence itself
  // -------------------------------------------------------------------------

  describe("limits and failures", () => {
    it("stops at the plan's monthly video allowance", async () => {
      /**
       * Starter allows four videos a month. The fifth must not start — automation
       * spending past a user's plan is a billing problem, not a feature — and it is
       * a skip rather than a failure, because waiting for the month to roll over is
       * the correct outcome, not an error to alarm an operator with.
       */
      const { user } = await channel("limit@tally.test");
      await exhaustAllowance(user.id);

      const { runAutomationTick } = await import("@/lib/automation/service");
      const result = await runAutomationTick(new Date("2026-03-02T12:00:00Z"));

      expect(result).toEqual({ considered: 1, started: 0, skipped: 1, failed: 0 });
      expect(await projectsFor(user.id)).toHaveLength(0);
      expect(enqueue).not.toHaveBeenCalled();
    }, 120_000);

    it("keeps going for other channels when one fails", async () => {
      /**
       * One channel's failure must not end the pass. Without isolation a single user
       * with a broken configuration would silently stop automation for every other
       * tenant on the instance.
       */
      const broken = await channel("broken@tally.test");
      const healthy = await channel("healthy@tally.test");

      const working = enqueue.getMockImplementation()!;
      enqueue.mockImplementation(async (input: Record<string, unknown>) => {
        if (input["userId"] === broken.user.id) throw new Error("queue unreachable");
        return working(input);
      });

      const { runAutomationTick } = await import("@/lib/automation/service");
      const result = await runAutomationTick(new Date("2026-03-02T12:00:00Z"));

      expect(result.considered).toBe(2);
      expect(result.started).toBe(1);
      expect(result.failed).toBe(1);
      // Both channels were attempted, whichever order they came back in.
      expect(enqueue).toHaveBeenCalledTimes(2);

      // The healthy tenant got its video...
      expect(await projectsFor(healthy.user.id)).toHaveLength(1);
      // ...and the broken one has a FAILED project it can see and retry, rather
      // than a silently missing video (§30).
      const brokenProjects = await projectsFor(broken.user.id);
      expect(brokenProjects).toHaveLength(1);
      expect(brokenProjects[0]!.status).toBe("FAILED");
    }, 120_000);

    it("advances the cadence across a DST boundary using the channel's zone", async () => {
      /**
       * The cadence is a wall clock, not an offset. A channel publishing at 18:00
       * London time must still publish at 18:00 after the clocks change, which is a
       * different instant — the reason `next_run_at` is recomputed against the zone
       * on every claim instead of being incremented by a fixed interval.
       */
      const { channelId } = await channel("dst@tally.test", {
        publishDays: [1],
        publishTimes: ["18:00"],
        timezone: "Europe/London",
      });

      const { runAutomationTick } = await import("@/lib/automation/service");
      // Monday 2026-03-23, still GMT. The next Monday slot is 2026-03-30, by which
      // time London is on BST: 17:00Z, not 18:00Z.
      const result = await runAutomationTick(new Date("2026-03-23T18:00:00Z"));

      expect(result.started).toBe(1);
      expect((await settingsFor(channelId)).nextRunAt!.toISOString()).toBe(
        "2026-03-30T17:00:00.000Z",
      );
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  // Tenant isolation (§34)
  // -------------------------------------------------------------------------

  describe("tenant isolation", () => {
    it("makes each channel's video from that tenant's own ideas", async () => {
      /**
       * Two tenants due in the same pass. An idea query missing its `userId`
       * predicate would happily build tenant A's video from tenant B's research — a
       * leak of another customer's content strategy, and the single highest-scoring
       * row in the table would win for everyone.
       */
      const a = await channel("tenant-a@tally.test", {}, { ideaScores: [10] });
      const b = await channel("tenant-b@tally.test", {}, { ideaScores: [99] });

      const { runAutomationTick } = await import("@/lib/automation/service");
      const result = await runAutomationTick(new Date("2026-03-02T12:00:00Z"));
      expect(result.started).toBe(2);

      const aProjects = await projectsFor(a.user.id);
      const bProjects = await projectsFor(b.user.id);
      expect(aProjects).toHaveLength(1);
      expect(bProjects).toHaveLength(1);

      // A took its own 10, not B's 99.
      expect(aProjects[0]!.ideaId).toBe(a.ideas[0]!.id);
      expect(aProjects[0]!.channelId).toBe(a.channelId);
      expect(bProjects[0]!.ideaId).toBe(b.ideas[0]!.id);
      expect(bProjects[0]!.channelId).toBe(b.channelId);
    }, 120_000);

    it("does not let one tenant's exhausted plan block another's automation", async () => {
      const limited = await channel("limited@tally.test");
      const fine = await channel("fine@tally.test");
      await exhaustAllowance(limited.user.id);

      const { runAutomationTick } = await import("@/lib/automation/service");
      const result = await runAutomationTick(new Date("2026-03-02T12:00:00Z"));

      expect(result.considered).toBe(2);
      expect(result.started).toBe(1);
      expect(await projectsFor(limited.user.id)).toHaveLength(0);
      expect(await projectsFor(fine.user.id)).toHaveLength(1);
    }, 120_000);

    it("will not claim a slot for a channel belonging to another user", async () => {
      /**
       * `runForChannel` takes a candidate object, and its `userId` is carried into
       * the CAS predicate. A candidate whose ids are crossed — the shape a bug or a
       * tampered queue payload would produce — claims nothing and starts nothing,
       * for either tenant.
       */
      const owner = await channel("claim-owner@tally.test");
      const other = await createUser({ email: "claim-other@tally.test" });

      const { runForChannel } = await import("@/lib/automation/service");
      const outcome = await runForChannel(
        {
          channelId: owner.channelId,
          // The wrong tenant for this channel.
          userId: other.id,
          level: "autopilot",
          publishDays: [0, 1, 2, 3, 4, 5, 6],
          publishTimes: ["12:00"],
          timezone: "UTC",
          videosPerWeek: 3,
          autoPublish: false,
          requireApproval: true,
          nextRunAt: null,
          lastRunAt: null,
        },
        new Date("2026-03-02T11:00:00Z"),
      );

      expect(outcome.started).toBe(false);
      expect(outcome.reason).toBe("slot_taken");
      expect(await projectsFor(other.id)).toHaveLength(0);
      expect(await projectsFor(owner.user.id)).toHaveLength(0);
      // And the owner's schedule was not touched on the way past.
      expect((await settingsFor(owner.channelId)).lastRunAt).toBeNull();
    }, 120_000);
  });
});
