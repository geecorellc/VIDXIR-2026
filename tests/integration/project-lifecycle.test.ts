/**
 * Project lifecycle integration tests (§39, §20, §42).
 *
 * §39 asks for coverage of "job state transitions" and "retry logic", and §20
 * says the state machine must be persisted server-side. That is what these
 * assert: not that `canTransition()` returns the right boolean — the unit tests
 * in `state-machine.test.ts` already pin that — but that the row in Postgres
 * actually moves, that the audit trail is written in the same transaction, and
 * that a concurrent writer cannot make it skip a state.
 *
 * The load-bearing group is the last one: PUBLISHED must be unreachable except
 * from PUBLISHING, because §42 says "Do NOT show 'Published' unless YouTube
 * actually confirmed publication".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChannel,
  createUser,
  hasDatabase,
  jar,
  resetDatabase,
  useDatabase,
} from "./setup";

vi.mock("next/headers", () => ({
  cookies: async () => jar,
}));

const suite = hasDatabase ? describe : describe.skip;

/**
 * The §46 MVP path as project statuses, from IDEA through to a confirmed publish.
 * Written out longhand rather than derived from TRANSITIONS, so that a change to
 * the state machine has to be a deliberate change to the product flow too.
 */
const HAPPY_PATH = [
  "SCRIPT_GENERATING",
  "SCRIPT_READY",
  "ASSETS_GENERATING",
  "ASSETS_READY",
  "RENDERING",
  "VIDEO_READY",
  "THUMBNAIL_GENERATING",
  "READY_TO_PUBLISH",
  "PUBLISHING",
  "PUBLISHED",
] as const;

suite("project lifecycle (integration)", () => {
  useDatabase();
  beforeEach(resetDatabase);

  async function newProject(email: string) {
    const { createProject } = await import("@/lib/projects/service");
    const user = await createUser({ email });
    const channelId = await createChannel(user.id);
    const project = await createProject({
      userId: user.id,
      channelId,
      title: "Lifecycle project",
    });
    return { user, channelId, project };
  }

  /** Walk to a target status through the declared happy path. */
  async function advanceTo(
    userId: string,
    projectId: string,
    target: (typeof HAPPY_PATH)[number],
  ): Promise<void> {
    const { transition } = await import("@/lib/projects/service");
    for (const status of HAPPY_PATH.slice(0, HAPPY_PATH.indexOf(target) + 1)) {
      await transition(userId, projectId, status);
    }
  }

  describe("creation", () => {
    it("starts in IDEA with a trace id and an opening audit event", async () => {
      const { listEvents } = await import("@/lib/projects/service");
      const { project, user } = await newProject("create@tally.test");

      expect(project.status).toBe("IDEA");
      expect(project.progress).toBe(0);
      // §41: every project carries an id that ties its logs together.
      expect(project.traceId).toBeTruthy();

      const events = await listEvents(user.id, project.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ fromStatus: null, toStatus: "IDEA" });
    });

    it("increments the month's usage counter in the same transaction", async () => {
      const { db } = await import("@/lib/db");
      const { usageCounters } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const { createProject, currentPeriod } = await import(
        "@/lib/projects/service"
      );

      const { user, channelId } = await newProject("counter@tally.test");
      await createProject({ userId: user.id, channelId, title: "Second" });

      const [counter] = await db
        .select({
          period: usageCounters.period,
          started: usageCounters.videosStarted,
        })
        .from(usageCounters)
        .where(eq(usageCounters.userId, user.id));

      // Two projects, one counter row for this month.
      expect(counter).toEqual({ period: currentPeriod(), started: 2 });
    });
  });

  describe("transitions", () => {
    it("walks the whole MVP path and persists every step", async () => {
      const { listEvents, transition } = await import("@/lib/projects/service");
      const { user, project } = await newProject("walk@tally.test");

      for (const next of HAPPY_PATH) {
        const current = await transition(user.id, project.id, next);
        expect(current.status).toBe(next);
      }

      // The audit trail is the IDEA event plus one per transition. `listEvents`
      // returns newest-first because that is the order the UI reads a feed in.
      const events = await listEvents(user.id, project.id);
      expect(events.map((e) => e.toStatus).reverse()).toEqual([
        "IDEA",
        ...HAPPY_PATH,
      ]);
    });

    it("refuses to skip stages", async () => {
      const { getProject, transition } = await import("@/lib/projects/service");
      const { user, project } = await newProject("skip@tally.test");

      await expect(
        transition(user.id, project.id, "RENDERING"),
      ).rejects.toMatchObject({ code: "invalid_state_transition" });

      // Nothing written on a refused transition.
      const after = await getProject(user.id, project.id);
      expect(after.status).toBe("IDEA");
    });

    it("records the stage and message on the event row", async () => {
      const { listEvents, transition } = await import("@/lib/projects/service");
      const { user, project } = await newProject("stage@tally.test");

      await transition(user.id, project.id, "SCRIPT_GENERATING", {
        stage: "SCRIPT",
        message: "Drafting from the selected idea",
      });

      // Newest first, so the transition just made is at index 0.
      const events = await listEvents(user.id, project.id);
      expect(events[0]).toMatchObject({
        fromStatus: "IDEA",
        toStatus: "SCRIPT_GENERATING",
        stage: "SCRIPT",
        message: "Drafting from the selected idea",
      });
    });

    it("accepts a no-op re-assertion so a duplicated job delivery is not an error", async () => {
      const { transition } = await import("@/lib/projects/service");
      const { user, project } = await newProject("idempotent@tally.test");

      await transition(user.id, project.id, "SCRIPT_GENERATING");
      // A worker that receives the same message twice must not fail the project.
      await expect(
        transition(user.id, project.id, "SCRIPT_GENERATING"),
      ).resolves.toMatchObject({ status: "SCRIPT_GENERATING" });
    });

    it("loses the race rather than double-applying a concurrent transition", async () => {
      const { getProject, transition } = await import("@/lib/projects/service");
      const { user, project } = await newProject("race@tally.test");
      await transition(user.id, project.id, "SCRIPT_GENERATING");
      await transition(user.id, project.id, "SCRIPT_READY");

      // Both read SCRIPT_READY, and both destinations are legal from there. The
      // optimistic status guard in the UPDATE means exactly one can win.
      const outcomes = await Promise.allSettled([
        transition(user.id, project.id, "ASSETS_GENERATING"),
        transition(user.id, project.id, "SCRIPT_GENERATING"),
      ]);

      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);

      const after = await getProject(user.id, project.id);
      expect(["ASSETS_GENERATING", "SCRIPT_GENERATING"]).toContain(after.status);
    });
  });

  describe("failure and retry", () => {
    it("stores the failing stage, code and message so the UI never sticks on 'Generating'", async () => {
      const { failProject, transition } = await import("@/lib/projects/service");
      const { user, project } = await newProject("fail@tally.test");

      await advanceTo(user.id, project.id, "SCRIPT_READY");
      await transition(user.id, project.id, "ASSETS_GENERATING", {
        stage: "VOICEOVER",
      });

      const failed = await failProject(user.id, project.id, {
        code: "provider_error",
        message: "ElevenLabs returned 503",
        stage: "VOICEOVER",
      });

      // §30/§37: the user has to be told what broke and where.
      expect(failed.status).toBe("FAILED");
      expect(failed.failedStage).toBe("VOICEOVER");
      expect(failed.errorCode).toBe("provider_error");
      expect(failed.errorMessage).toBe("ElevenLabs returned 503");
      expect(failed.failedAt).toBeInstanceOf(Date);
    });

    it("clears the previous error and counts the attempt on retry", async () => {
      const { failProject, transition } = await import("@/lib/projects/service");
      const { user, project } = await newProject("retry@tally.test");

      await advanceTo(user.id, project.id, "ASSETS_GENERATING");
      await failProject(user.id, project.id, {
        code: "provider_error",
        message: "Transient failure",
        stage: "VISUALS",
      });

      const retried = await transition(
        user.id,
        project.id,
        "ASSETS_GENERATING",
        { incrementRetry: true, message: "Retrying after failure" },
      );

      expect(retried.status).toBe("ASSETS_GENERATING");
      expect(retried.retryCount).toBe(1);
      // A resolved error must not keep showing next to live progress.
      expect(retried.errorCode).toBeNull();
      expect(retried.errorMessage).toBeNull();
      expect(retried.failedStage).toBeNull();
      expect(retried.failedAt).toBeNull();
    });

    it("keeps the failure in the audit trail after a successful retry", async () => {
      const { failProject, listEvents, transition } = await import(
        "@/lib/projects/service"
      );
      const { user, project } = await newProject("audit@tally.test");

      await transition(user.id, project.id, "SCRIPT_GENERATING");
      await failProject(user.id, project.id, {
        code: "provider_error",
        message: "Broke once",
      });
      await transition(user.id, project.id, "SCRIPT_GENERATING", {
        incrementRetry: true,
      });

      // Clearing the error columns must not erase the history of it happening.
      const statuses = (await listEvents(user.id, project.id))
        .map((e) => e.toStatus)
        .reverse();
      expect(statuses).toEqual([
        "IDEA",
        "SCRIPT_GENERATING",
        "FAILED",
        "SCRIPT_GENERATING",
      ]);
    });

    it("can fail from any stage that does real work", async () => {
      const { failProject, transition } = await import("@/lib/projects/service");

      for (const stop of [
        "SCRIPT_GENERATING",
        "ASSETS_GENERATING",
        "RENDERING",
        "PUBLISHING",
      ] as const) {
        const { user, project } = await newProject(`anyfail-${stop}@tally.test`);
        for (const status of HAPPY_PATH.slice(0, HAPPY_PATH.indexOf(stop) + 1)) {
          await transition(user.id, project.id, status);
        }
        await expect(
          failProject(user.id, project.id, {
            code: "provider_error",
            message: `Failed during ${stop}`,
          }),
        ).resolves.toMatchObject({ status: "FAILED" });
      }
    });
  });

  describe("PUBLISHED is only reachable from a confirmed upload (§42)", () => {
    it("cannot jump to PUBLISHED from READY_TO_PUBLISH", async () => {
      const { getProject, transition } = await import("@/lib/projects/service");
      const { user, project } = await newProject("publish@tally.test");

      await advanceTo(user.id, project.id, "READY_TO_PUBLISH");
      expect((await getProject(user.id, project.id)).status).toBe(
        "READY_TO_PUBLISH",
      );

      // Marking a video published without going through the upload attempt is
      // exactly the lie §42 forbids.
      await expect(
        transition(user.id, project.id, "PUBLISHED"),
      ).rejects.toMatchObject({ code: "invalid_state_transition" });
    });

    it("lets a failed upload go to FAILED but not quietly back to ready", async () => {
      const { transition } = await import("@/lib/projects/service");
      const { user, project } = await newProject("upload-fail@tally.test");

      await advanceTo(user.id, project.id, "PUBLISHING");

      // A failed upload must surface as a failure, not revert to "ready" as
      // though the attempt never happened.
      await expect(
        transition(user.id, project.id, "READY_TO_PUBLISH"),
      ).rejects.toMatchObject({ code: "invalid_state_transition" });

      await expect(
        transition(user.id, project.id, "FAILED", {
          error: { code: "youtube_upload_failed", message: "Quota exceeded" },
        }),
      ).resolves.toMatchObject({ status: "FAILED" });
    });

    it("allows an explicit retry of the upload from FAILED", async () => {
      const { failProject, transition } = await import("@/lib/projects/service");
      const { user, project } = await newProject("upload-retry@tally.test");

      await advanceTo(user.id, project.id, "PUBLISHING");
      await failProject(user.id, project.id, {
        code: "youtube_upload_failed",
        message: "Quota exceeded",
      });

      // Retry is deliberate and recorded, not automatic and invisible.
      const retried = await transition(user.id, project.id, "PUBLISHING", {
        incrementRetry: true,
      });
      expect(retried.status).toBe("PUBLISHING");
      expect(retried.retryCount).toBe(1);
    });

    it("treats PUBLISHED as terminal", async () => {
      const { transition } = await import("@/lib/projects/service");
      const { user, project } = await newProject("terminal@tally.test");

      await advanceTo(user.id, project.id, "PUBLISHED");

      await expect(
        transition(user.id, project.id, "RENDERING"),
      ).rejects.toMatchObject({ code: "invalid_state_transition" });
      await expect(
        transition(user.id, project.id, "FAILED"),
      ).rejects.toMatchObject({ code: "invalid_state_transition" });
    });
  });

  describe("scheduling", () => {
    it("can schedule and unschedule without touching PUBLISHED", async () => {
      const { transition } = await import("@/lib/projects/service");
      const { user, project } = await newProject("schedule@tally.test");

      await advanceTo(user.id, project.id, "READY_TO_PUBLISH");
      await expect(
        transition(user.id, project.id, "SCHEDULED"),
      ).resolves.toMatchObject({ status: "SCHEDULED" });

      // §18 lists Scheduled as a real state a user can back out of.
      await expect(
        transition(user.id, project.id, "READY_TO_PUBLISH"),
      ).resolves.toMatchObject({ status: "READY_TO_PUBLISH" });

      await transition(user.id, project.id, "SCHEDULED");
      await expect(
        transition(user.id, project.id, "PUBLISHED"),
      ).rejects.toMatchObject({ code: "invalid_state_transition" });
    });
  });

  describe("progress", () => {
    it("derives progress from finished stages rather than from elapsed time", async () => {
      const { deriveProgress } = await import("@/lib/projects/service");

      expect(deriveProgress([])).toBe(0);
      const partial = deriveProgress(["SCRIPT", "SCENE_PLAN"]);
      const more = deriveProgress(["SCRIPT", "SCENE_PLAN", "VOICEOVER"]);

      expect(partial).toBeGreaterThan(0);
      expect(partial).toBeLessThan(100);
      // Monotonic: finishing more work can never reduce reported progress.
      expect(more).toBeGreaterThan(partial);
    });

    it("persists progress and clamps out-of-range values", async () => {
      const { getProject, setProgress } = await import("@/lib/projects/service");
      const { user, project } = await newProject("progress@tally.test");

      await setProgress(user.id, project.id, 42.6);
      expect((await getProject(user.id, project.id)).progress).toBe(43);

      await setProgress(user.id, project.id, 500);
      expect((await getProject(user.id, project.id)).progress).toBe(100);

      await setProgress(user.id, project.id, -20);
      expect((await getProject(user.id, project.id)).progress).toBe(0);
    });

    it("reports sidebar reach from the persisted status, not from client state", async () => {
      const { reachOf } = await import("@/lib/projects/service");
      const { user, project } = await newProject("reach@tally.test");

      expect(await reachOf(user.id)).toBe("idea");

      await advanceTo(user.id, project.id, "SCRIPT_READY");
      expect(await reachOf(user.id)).toBe("script");

      await advanceTo(user.id, project.id, "VIDEO_READY");
      expect(await reachOf(user.id)).toBe("video");
    });

    it("reports no reach once the active project is published", async () => {
      const { reachOf } = await import("@/lib/projects/service");
      const { user, project } = await newProject("published-reach@tally.test");

      await advanceTo(user.id, project.id, "PUBLISHED");
      // `getActiveProject` excludes PUBLISHED, so the studio starts clean for
      // the next video rather than parking on a finished one.
      expect(await reachOf(user.id)).toBe("none");
    });
  });
});
