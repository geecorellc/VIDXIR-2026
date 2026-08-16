/**
 * Script and metadata pipeline integration tests (§9, §17, §20, §39, §42).
 *
 * What these prove that the unit tests cannot:
 *
 *  - **Generation persists and the project moves.** §45's question is what should
 *    survive a closed browser; for this stage the answer is a `script_versions`
 *    row and a project at SCRIPT_READY. That is a claim about Postgres, not about a
 *    return value.
 *  - **Versions are append-only.** Regenerating writes v2 and repoints the active
 *    pointer; v1 is still readable and can be reactivated. "Versioning" that only
 *    increments a number would pass a unit test and lose the user's preferred draft.
 *  - **Approval does not survive a change.** Approving v1 and then generating v2
 *    must clear the approval, or a regenerated script reaches the video builder
 *    with a human sign-off it never received (§42).
 *  - **A failure is recorded, not swallowed.** A provider error leaves the project
 *    FAILED with the real reason, never stuck at SCRIPT_GENERATING (§30).
 *  - **Metadata respects a hand edit.** §17's promise — which the Publish panel
 *    displays as text — is that regenerating will not overwrite an edit. That is
 *    enforced server-side here.
 *  - **Chapter offsets come from the video when the video exists.** The word-count
 *    estimate is a fallback; real scene timings supersede it (§42).
 *  - **The worker takes its authority from the job row, not the Redis payload.** A
 *    payload naming a different project is refused before a token is spent (§34).
 *  - **Tenant isolation holds** on every new path, tested with a valid id
 *    belonging to somebody else.
 *
 * Only the AI provider is mocked, and only at `lib/providers/ai`, because these
 * tests must not spend real credits (§40). Everything below that seam — the
 * brief assembly, the schema validation, the transaction, the version numbering,
 * the state machine, the ownership predicates — is the real code.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

const ai = vi.hoisted(() => ({ generateJson: vi.fn() }));

vi.mock("@/lib/providers/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/ai")>();
  return { ...actual, generateJson: ai.generateJson };
});

const suite = hasDatabase ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A draft that satisfies `ScriptDraftSchema`, with a title override hook. */
function scriptDraft(title = "Why cheap sensors beat the expensive ones") {
  return {
    title,
    titleIdeas: ["The six pound sensor test"],
    hook: "Every review tests the flagship. Nobody has tested the cheap one.",
    introduction:
      "So I bought twelve of the cheapest sensors sold and wired the hallway.",
    sections: [
      {
        heading: "The claim",
        body: "Budget sensors are said to fail within weeks of installation.",
        talkingPoints: ["Cheap tier is dismissed"],
        transition: "So I measured it.",
      },
      {
        heading: "The test",
        body: "Twelve sensors, three weeks, one hallway, logged every trigger.",
        talkingPoints: ["Twelve units", "Three weeks"],
        transition: "Here is what happened.",
      },
      {
        heading: "The result",
        body: "Two failed in the first week. The other ten never missed a trigger.",
        talkingPoints: ["Two failures"],
      },
    ],
    conclusion: "For anything non-critical the cheap tier is entirely fine.",
    cta: "The parts list is linked below if you want to copy this setup.",
    storyStructure: "claim → test → result → recommendation",
    references: [{ label: "Manufacturer datasheet" }],
  };
}

function metadataDraft() {
  return {
    title: "Why cheap sensors beat the expensive ones",
    description:
      "A three-week test of the budget smart home tier nobody reviews, with the measured failure rate and what it means for a first setup.",
    tags: ["budget smart home", "cheap sensors", "home automation"],
    hashtags: ["smarthome"],
    chapterLabels: ["The opening", "The claim", "The test", "The result"],
    categoryId: "28",
  };
}

suite("scripts and metadata (integration)", () => {
  useDatabase();

  /**
   * Warm the modules before the first test needs them.
   *
   * `enqueue()` opens BullMQ's Redis connection on first use, and the script
   * modules reach the `googleapis` barrel through the research signals query.
   * Together that is tens of seconds cold on Windows — enough to exhaust the 30s
   * per-test budget for whichever test runs first while every later one finishes
   * in about a second. Paying it in a hook with its own 60s budget beats raising
   * the global timeout, which would mask a genuine hang.
   */
  beforeAll(async () => {
    await import("@/lib/scripts/service");
    await import("@/lib/metadata/service");
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
    ai.generateJson.mockReset();
  });

  /** A user with a channel, settings, a brand kit and an IDEA-stage project. */
  async function fixture(email: string) {
    const { db } = await import("@/lib/db");
    const { brandKits, channelSettings } = await import("@/lib/db/schema");
    const { createProject } = await import("@/lib/projects/service");

    const user = await createUser({ email });
    const channelId = await createChannel(user.id);

    await db.insert(channelSettings).values({
      channelId,
      userId: user.id,
      niche: "home automation",
      targetAudience: "renters setting up a first smart home",
      contentLanguage: "en-GB",
      preferredLengthSeconds: 480,
      keywords: ["smart home", "sensors"],
    });

    await db.insert(brandKits).values({
      channelId,
      userId: user.id,
      brandName: "Wired Cottage",
      defaultCta: "Grab the parts list",
    });

    const project = await createProject({
      userId: user.id,
      channelId,
      title: "Budget smart home sensors",
    });

    return { user, channelId, project };
  }

  /**
   * Run the worker's half of a generation, including the job bookkeeping the
   * harness in `worker/index.ts` does around a handler.
   *
   * Closing the job row out matters to more than tidiness: `hasActiveJob` reads
   * it, so a run left `queued` would make every regeneration in this file fail
   * with a spurious conflict — and the test would then be asserting on the
   * fixture rather than on the code.
   */
  async function generate(
    userId: string,
    projectId: string,
    jobId: string,
    feedback?: string,
  ) {
    const { executeScriptGeneration } = await import("@/lib/scripts/service");
    const { markJobFailed, markJobSucceeded } = await import("@/lib/queue/jobs");

    try {
      const result = await executeScriptGeneration({
        userId,
        projectId,
        jobId,
        feedback: feedback ?? null,
        traceId: "test-trace",
      });
      await markJobSucceeded(jobId, { version: result.version });
      return result;
    } catch (error) {
      await markJobFailed(jobId, error);
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  describe("startScriptGeneration", () => {
    it("queues a job and moves the project to SCRIPT_GENERATING", async () => {
      const { project, user } = await fixture("start@tally.test");
      const { startScriptGeneration } = await import("@/lib/scripts/service");
      const { getProject } = await import("@/lib/projects/service");

      const { jobId, nextVersion } = await startScriptGeneration({
        userId: user.id,
        projectId: project.id,
        tier: "starter",
      });

      expect(nextVersion).toBe(1);

      const after = await getProject(user.id, project.id);
      expect(after.status).toBe("SCRIPT_GENERATING");
      expect(after.currentStage).toBe("SCRIPT");

      const { db } = await import("@/lib/db");
      const { jobs } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));

      // The job row is what the UI polls, so it has to carry the queue, the
      // stage and the project even before the worker picks it up.
      expect(job?.queue).toBe("pipeline");
      expect(job?.name).toBe("script-generate");
      expect(job?.stage).toBe("SCRIPT");
      expect(job?.projectId).toBe(project.id);
      expect(job?.status).toBe("queued");
    });

    it("refuses a second run while one is in flight", async () => {
      const { project, user } = await fixture("dup@tally.test");
      const { startScriptGeneration } = await import("@/lib/scripts/service");

      await startScriptGeneration({
        userId: user.id,
        projectId: project.id,
        tier: "starter",
      });

      // A second run would spend a second set of tokens producing the draft the
      // first is already producing, and both would race for version 1.
      await expect(
        startScriptGeneration({
          userId: user.id,
          projectId: project.id,
          tier: "starter",
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    });

    it("refuses another user's project", async () => {
      const { project } = await fixture("owner@tally.test");
      const intruder = await createUser({ email: "intruder@tally.test" });
      const { startScriptGeneration } = await import("@/lib/scripts/service");

      // A valid project id belonging to somebody else — the only test of
      // isolation that counts (§34).
      await expect(
        startScriptGeneration({
          userId: intruder.id,
          projectId: project.id,
          tier: "starter",
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    });

    it("rejects a revision note long enough to be a prompt", async () => {
      const { project, user } = await fixture("longnote@tally.test");
      const { startScriptGeneration } = await import("@/lib/scripts/service");

      await expect(
        startScriptGeneration({
          userId: user.id,
          projectId: project.id,
          tier: "starter",
          feedback: "x".repeat(1_001),
        }),
      ).rejects.toMatchObject({ code: "validation_failed" });
    });
  });

  describe("executeScriptGeneration", () => {
    it("stores a version, measures it, and moves to SCRIPT_READY", async () => {
      const { project, user } = await fixture("exec@tally.test");
      ai.generateJson.mockResolvedValue(scriptDraft());

      const { startScriptGeneration } = await import("@/lib/scripts/service");
      const { getProject } = await import("@/lib/projects/service");
      const { jobId } = await startScriptGeneration({
        userId: user.id,
        projectId: project.id,
        tier: "starter",
      });

      const result = await generate(user.id, project.id, jobId);

      expect(result.version).toBe(1);
      expect(result.wordCount).toBeGreaterThan(0);
      // Derived from the word count at a stated rate, never taken from the model
      // (§42). 150 wpm means the two are locked together.
      expect(result.estimatedDurationSeconds).toBe(
        Math.round((result.wordCount / 150) * 60),
      );

      const after = await getProject(user.id, project.id);
      expect(after.status).toBe("SCRIPT_READY");
      expect(after.errorMessage).toBeNull();

      const { db } = await import("@/lib/db");
      const { scriptVersions, scripts } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      const [script] = await db
        .select()
        .from(scripts)
        .where(eq(scripts.projectId, project.id));
      expect(script?.activeVersionId).toBe(result.versionId);
      expect(script?.approvedAt).toBeNull();

      const [version] = await db
        .select()
        .from(scriptVersions)
        .where(eq(scriptVersions.id, result.versionId));

      expect(version?.title).toBe("Why cheap sensors beat the expensive ones");
      expect(version?.sections).toHaveLength(3);
      expect(version?.source).toBe("ai");
      // The provider and model are recorded so the Script screen's footer states
      // what actually wrote this rather than a hard-coded label.
      expect(version?.provider).toBe("anthropic");
      expect(version?.model).toBeTruthy();
    });

    it("builds a brief from the channel's own settings and brand kit", async () => {
      const { project, user } = await fixture("brief@tally.test");
      ai.generateJson.mockResolvedValue(scriptDraft());

      const { startScriptGeneration } = await import("@/lib/scripts/service");
      const { jobId } = await startScriptGeneration({
        userId: user.id,
        projectId: project.id,
        tier: "starter",
      });
      await generate(user.id, project.id, jobId);

      const call = ai.generateJson.mock.calls[0]?.[0];
      expect(call.prompt).toContain("home automation");
      expect(call.prompt).toContain("renters setting up a first smart home");
      expect(call.prompt).toContain("Wired Cottage");
      expect(call.prompt).toContain("Grab the parts list");
      // 480s at 150wpm.
      expect(call.prompt).toContain("1200 spoken words");
      // Accounting context, so the call lands in `api_usage` (§41).
      expect(call.usage).toMatchObject({
        operation: "script.generate",
        userId: user.id,
        projectId: project.id,
        jobId,
      });
    });

    it("records the failure on the project instead of leaving it generating", async () => {
      const { project, user } = await fixture("fail@tally.test");
      const { ProviderError } = await import("@/lib/errors");
      ai.generateJson.mockRejectedValue(
        new ProviderError("Claude", "The model returned an unusable response."),
      );

      const { startScriptGeneration } = await import("@/lib/scripts/service");
      const { getProject } = await import("@/lib/projects/service");
      const { jobId } = await startScriptGeneration({
        userId: user.id,
        projectId: project.id,
        tier: "starter",
      });

      await expect(generate(user.id, project.id, jobId)).rejects.toThrow();

      const after = await getProject(user.id, project.id);
      // §30: never leave the UI stuck on "Generating".
      expect(after.status).toBe("FAILED");
      expect(after.failedStage).toBe("SCRIPT");
      expect(after.errorCode).toBe("provider_failed");
      expect(after.errorMessage).toContain("unusable response");
    });

    it("surfaces a missing credential as a configuration state, not a crash", async () => {
      const { project, user } = await fixture("nokey@tally.test");
      const { NotConfiguredError } = await import("@/lib/errors");
      ai.generateJson.mockRejectedValue(
        new NotConfiguredError("Claude", ["ANTHROPIC_API_KEY"]),
      );

      const { startScriptGeneration } = await import("@/lib/scripts/service");
      const { getProject } = await import("@/lib/projects/service");
      const { jobId } = await startScriptGeneration({
        userId: user.id,
        projectId: project.id,
        tier: "starter",
      });

      await expect(generate(user.id, project.id, jobId)).rejects.toThrow();

      const after = await getProject(user.id, project.id);
      // §48: the variable is named, and no invented script is stored.
      expect(after.errorCode).toBe("provider_not_configured");
      expect(after.errorMessage).toContain("ANTHROPIC_API_KEY");

      const { db } = await import("@/lib/db");
      const { jobs, scriptVersions } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      expect(await db.select().from(scriptVersions)).toHaveLength(0);

      // The job reads as blocked rather than failed, because no number of
      // retries will conjure an API key.
      const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
      expect(job?.status).toBe("blocked_not_configured");
      expect(job?.notConfiguredProvider).toBe("Claude");
    });

    it("passes a revision note through to the rewrite", async () => {
      const { project, user } = await fixture("note@tally.test");
      ai.generateJson.mockResolvedValue(scriptDraft());

      const { startScriptGeneration } = await import("@/lib/scripts/service");
      const { jobId } = await startScriptGeneration({
        userId: user.id,
        projectId: project.id,
        tier: "starter",
        feedback: "The hook is too slow.",
      });

      await generate(user.id, project.id, jobId, "The hook is too slow.");

      const call = ai.generateJson.mock.calls[0]?.[0];
      expect(call.prompt).toContain("REVISION NOTE");
      expect(call.prompt).toContain("The hook is too slow.");
    });
  });

  // -------------------------------------------------------------------------
  // The worker seam
  // -------------------------------------------------------------------------

  describe("scriptHandler", () => {
    it("takes the owning user from the job row, not from the payload", async () => {
      const { project, user } = await fixture("handler@tally.test");
      ai.generateJson.mockResolvedValue(scriptDraft());

      const { startScriptGeneration } = await import("@/lib/scripts/service");
      const { scriptHandler } = await import("@/worker/handlers/script");
      const { getProject } = await import("@/lib/projects/service");

      const { jobId } = await startScriptGeneration({
        userId: user.id,
        projectId: project.id,
        tier: "starter",
      });

      // The payload carries no userId at all — §34's rule that a message arriving
      // over Redis is data, never authorisation.
      const result = await scriptHandler({
        jobId,
        payload: { jobId, projectId: project.id },
        traceId: "test-trace",
        attempt: 1,
      });

      expect(result).toMatchObject({ version: 1 });
      expect((await getProject(user.id, project.id)).status).toBe("SCRIPT_READY");
    });

    it("refuses a payload pointing at a different project than the job row", async () => {
      const first = await fixture("payload-a@tally.test");
      const second = await fixture("payload-b@tally.test");
      ai.generateJson.mockResolvedValue(scriptDraft());

      const { startScriptGeneration } = await import("@/lib/scripts/service");
      const { scriptHandler } = await import("@/worker/handlers/script");

      const { jobId } = await startScriptGeneration({
        userId: first.user.id,
        projectId: first.project.id,
        tier: "starter",
      });

      // A tampered payload would otherwise have the first user's job write a
      // script into the second user's project.
      await expect(
        scriptHandler({
          jobId,
          payload: { jobId, projectId: second.project.id },
          traceId: "test-trace",
          attempt: 1,
        }),
      ).rejects.toThrow(/does not match/i);

      expect(ai.generateJson).not.toHaveBeenCalled();
    });

    it("rejects a malformed payload without calling the model", async () => {
      const { project, user } = await fixture("payload-bad@tally.test");
      const { startScriptGeneration } = await import("@/lib/scripts/service");
      const { scriptHandler } = await import("@/worker/handlers/script");

      const { jobId } = await startScriptGeneration({
        userId: user.id,
        projectId: project.id,
        tier: "starter",
      });

      await expect(
        scriptHandler({
          jobId,
          payload: { jobId, projectId: "not-a-uuid" },
          traceId: "test-trace",
          attempt: 1,
        }),
      ).rejects.toThrow(/Invalid script payload/);

      expect(ai.generateJson).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Versioning
  // -------------------------------------------------------------------------

  describe("versioning", () => {
    async function withVersion(email: string) {
      const f = await fixture(email);
      ai.generateJson.mockResolvedValue(scriptDraft());
      const { startScriptGeneration } = await import("@/lib/scripts/service");
      const { jobId } = await startScriptGeneration({
        userId: f.user.id,
        projectId: f.project.id,
        tier: "starter",
      });
      const first = await generate(f.user.id, f.project.id, jobId);
      return { ...f, first };
    }

    it("appends v2 without destroying v1", async () => {
      const { user, project, first } = await withVersion("v2@tally.test");
      const { startScriptGeneration, listScriptVersions } = await import(
        "@/lib/scripts/service"
      );

      ai.generateJson.mockResolvedValue(scriptDraft("A second, sharper angle"));
      const second = await startScriptGeneration({
        userId: user.id,
        projectId: project.id,
        tier: "starter",
      });
      const v2 = await generate(user.id, project.id, second.jobId);

      expect(second.nextVersion).toBe(2);
      expect(v2.version).toBe(2);
      expect(v2.scriptId).toBe(first.scriptId);

      const versions = await listScriptVersions(user.id, project.id);
      // Both drafts survive. A user who preferred v1 has not lost it.
      expect(versions.map((v) => v.version)).toEqual([2, 1]);
      expect(versions.find((v) => v.version === 2)?.isActive).toBe(true);
      expect(versions.find((v) => v.version === 1)?.isActive).toBe(false);
    });

    it("reverts to an earlier version by moving the pointer", async () => {
      const { user, project, first } = await withVersion("revert@tally.test");
      const { startScriptGeneration, activateScriptVersion, listScriptVersions } =
        await import("@/lib/scripts/service");

      ai.generateJson.mockResolvedValue(scriptDraft("A second, sharper angle"));
      const second = await startScriptGeneration({
        userId: user.id,
        projectId: project.id,
        tier: "starter",
      });
      await generate(user.id, project.id, second.jobId);

      const { version } = await activateScriptVersion(
        user.id,
        project.id,
        first.versionId,
      );

      expect(version).toBe(1);
      const versions = await listScriptVersions(user.id, project.id);
      expect(versions.find((v) => v.version === 1)?.isActive).toBe(true);
      expect(versions.find((v) => v.version === 2)?.isActive).toBe(false);
      // Nothing was deleted by reverting — v2 is still there to go back to.
      expect(versions).toHaveLength(2);
    });

    it("refuses to activate another user's version", async () => {
      const { first, project } = await withVersion("vowner@tally.test");
      const intruder = await createUser({ email: "vintruder@tally.test" });
      const { activateScriptVersion } = await import("@/lib/scripts/service");

      await expect(
        activateScriptVersion(intruder.id, project.id, first.versionId),
      ).rejects.toMatchObject({ code: "not_found" });
    });

    it("shows no versions to another user", async () => {
      const { project } = await withVersion("vlist@tally.test");
      const intruder = await createUser({ email: "vlistother@tally.test" });
      const { listScriptVersions } = await import("@/lib/scripts/service");

      expect(await listScriptVersions(intruder.id, project.id)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Approval
  // -------------------------------------------------------------------------

  describe("approveScript", () => {
    async function ready(email: string) {
      const f = await fixture(email);
      ai.generateJson.mockResolvedValue(scriptDraft());
      const { startScriptGeneration } = await import("@/lib/scripts/service");
      const { jobId } = await startScriptGeneration({
        userId: f.user.id,
        projectId: f.project.id,
        tier: "starter",
      });
      const version = await generate(f.user.id, f.project.id, jobId);
      return { ...f, version };
    }

    /** The stored approval timestamp, which is what the video builder will read. */
    async function approvedAtFor(projectId: string) {
      const { db } = await import("@/lib/db");
      const { scripts } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const [row] = await db
        .select({ approvedAt: scripts.approvedAt })
        .from(scripts)
        .where(eq(scripts.projectId, projectId));
      return row?.approvedAt ?? null;
    }

    it("records the approval against the active version", async () => {
      const { user, project, version } = await ready("approve@tally.test");
      const { approveScript } = await import("@/lib/scripts/service");

      const approved = await approveScript(user.id, project.id);
      expect(approved.versionId).toBe(version.versionId);
      expect(approved.version).toBe(1);
      expect(await approvedAtFor(project.id)).toBeInstanceOf(Date);
    });

    it("leaves the project at SCRIPT_READY rather than starting the asset spend", async () => {
      const { user, project } = await ready("approvestate@tally.test");
      const { approveScript } = await import("@/lib/scripts/service");
      const { getProject } = await import("@/lib/projects/service");

      await approveScript(user.id, project.id);

      // Approval and "spend money on voiceover, visuals and a render" are
      // separate decisions. The video builder makes the second one.
      expect((await getProject(user.id, project.id)).status).toBe("SCRIPT_READY");
    });

    it("clears the approval when a new version is generated", async () => {
      const { user, project } = await ready("reapprove@tally.test");
      const { approveScript, startScriptGeneration } = await import(
        "@/lib/scripts/service"
      );

      await approveScript(user.id, project.id);
      expect(await approvedAtFor(project.id)).toBeInstanceOf(Date);

      ai.generateJson.mockResolvedValue(scriptDraft("A second, sharper angle"));
      const second = await startScriptGeneration({
        userId: user.id,
        projectId: project.id,
        tier: "starter",
      });
      await generate(user.id, project.id, second.jobId);

      // What was approved is not what is now active. Carrying the approval over
      // would send an unreviewed script to the video builder (§42).
      expect(await approvedAtFor(project.id)).toBeNull();
    });

    it("clears the approval when an earlier version is reactivated", async () => {
      const { user, project } = await ready("revertapprove@tally.test");
      const {
        activateScriptVersion,
        approveScript,
        listScriptVersions,
        startScriptGeneration,
      } = await import("@/lib/scripts/service");

      ai.generateJson.mockResolvedValue(scriptDraft("A second, sharper angle"));
      const second = await startScriptGeneration({
        userId: user.id,
        projectId: project.id,
        tier: "starter",
      });
      const v2 = await generate(user.id, project.id, second.jobId);

      // v2 is what the user reviewed and signed off.
      await approveScript(user.id, project.id);
      expect(v2.version).toBe(2);

      const v1 = (await listScriptVersions(user.id, project.id)).find(
        (v) => v.version === 1,
      );
      if (!v1) throw new Error("expected version 1 to still exist");

      await activateScriptVersion(user.id, project.id, v1.id);

      // v1 is now what would be produced, and it has never been approved as such.
      expect(await approvedAtFor(project.id)).toBeNull();
    });

    it("refuses while a rewrite is still running", async () => {
      const { user, project } = await ready("approvebusy@tally.test");
      const { approveScript, startScriptGeneration } = await import(
        "@/lib/scripts/service"
      );

      // Queued but not executed: the project sits at SCRIPT_GENERATING, so the
      // draft on screen is about to be replaced.
      await startScriptGeneration({
        userId: user.id,
        projectId: project.id,
        tier: "starter",
      });

      await expect(approveScript(user.id, project.id)).rejects.toMatchObject({
        code: "conflict",
      });
    });

    it("refuses when there is no script yet", async () => {
      const { user, project } = await fixture("noscript@tally.test");
      const { approveScript } = await import("@/lib/scripts/service");

      await expect(approveScript(user.id, project.id)).rejects.toMatchObject({
        code: "not_found",
      });
    });

    it("refuses another user's script", async () => {
      const { project } = await ready("approveowner@tally.test");
      const intruder = await createUser({ email: "approveintruder@tally.test" });
      const { approveScript } = await import("@/lib/scripts/service");

      await expect(approveScript(intruder.id, project.id)).rejects.toMatchObject({
        code: "forbidden",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  describe("metadata", () => {
    async function withScript(email: string) {
      const f = await fixture(email);
      ai.generateJson.mockResolvedValue(scriptDraft());
      const { startScriptGeneration } = await import("@/lib/scripts/service");
      const { jobId } = await startScriptGeneration({
        userId: f.user.id,
        projectId: f.project.id,
        tier: "starter",
      });
      const version = await generate(f.user.id, f.project.id, jobId);
      // Reset so the metadata assertions read the metadata call, not the script's.
      ai.generateJson.mockReset();
      return { ...f, version };
    }

    it("generates from the active script and computes chapter offsets", async () => {
      const { user, project } = await withScript("meta@tally.test");
      ai.generateJson.mockResolvedValue(metadataDraft());
      const { generateMetadata } = await import("@/lib/metadata/service");

      const metadata = await generateMetadata({
        userId: user.id,
        projectId: project.id,
      });

      expect(metadata.title).toBe("Why cheap sensors beat the expensive ones");
      expect(metadata.tags).toContain("budget smart home");
      expect(metadata.categoryId).toBe("28");
      expect(metadata.editedByUser).toBe(false);
      // From the channel's own language setting, not a hard-coded default.
      expect(metadata.defaultLanguage).toBe("en-GB");

      // Four labels, four chapters, first at exactly 0 — YouTube ignores a
      // chapter list whose first marker is not 0:00, and rejects one whose
      // offsets are not strictly increasing.
      expect(metadata.chapters).toHaveLength(4);
      expect(metadata.chapters[0]?.startMs).toBe(0);
      const offsets = metadata.chapters.map((c) => c.startMs);
      expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
      expect(new Set(offsets).size).toBe(offsets.length);

      // The whole script reached the prompt, because the description has to
      // describe what the video actually says.
      const call = ai.generateJson.mock.calls[0]?.[0];
      expect(call.prompt).toContain("Twelve sensors, three weeks, one hallway");
      expect(call.usage.operation).toBe("metadata.generate");
    });

    it("prefers real scene timings over the word-count estimate", async () => {
      const { user, project, version } = await withScript("metascenes@tally.test");
      const { db } = await import("@/lib/db");
      const { scenes } = await import("@/lib/db/schema");

      // Offsets as the timeline stage will write them, measured from real audio
      // durations rather than estimated from word counts.
      const measured = [0, 31_500, 92_250, 180_000];
      await db.insert(scenes).values(
        measured.map((startMs, index) => ({
          projectId: project.id,
          userId: user.id,
          scriptVersionId: version.versionId,
          index,
          label: `Scene ${index}`,
          narration: `Narration for scene ${index}`,
          startMs,
        })),
      );

      ai.generateJson.mockResolvedValue(metadataDraft());
      const { generateMetadata } = await import("@/lib/metadata/service");
      const metadata = await generateMetadata({
        userId: user.id,
        projectId: project.id,
      });

      // A chapter marker is a claim about the video file. Once the file's timings
      // exist the claim can be exact, so the estimate is not used (§42).
      expect(metadata.chapters.map((c) => c.startMs)).toEqual(measured);
      // The labels stay the model's; only the offsets come from the scenes.
      expect(metadata.chapters.map((c) => c.label)).toEqual(
        metadataDraft().chapterLabels,
      );
    });

    it("refuses before there is a script to describe", async () => {
      const { user, project } = await fixture("metanoscript@tally.test");
      const { generateMetadata } = await import("@/lib/metadata/service");

      // Metadata written before the script would describe a video that does not
      // exist yet — plausible-looking fiction (§42).
      await expect(
        generateMetadata({ userId: user.id, projectId: project.id }),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(ai.generateJson).not.toHaveBeenCalled();
    });

    it("marks a manual edit and refuses to overwrite it", async () => {
      const { user, project } = await withScript("metaedit@tally.test");
      ai.generateJson.mockResolvedValue(metadataDraft());
      const { generateMetadata, updateMetadata } = await import(
        "@/lib/metadata/service"
      );

      await generateMetadata({ userId: user.id, projectId: project.id });

      const edited = await updateMetadata({
        userId: user.id,
        projectId: project.id,
        title: "My own title, thanks",
      });
      expect(edited.title).toBe("My own title, thanks");
      expect(edited.editedByUser).toBe(true);

      // The Publish panel tells the user "regenerating metadata will not
      // overwrite this". That promise is kept here, not by hiding a button.
      await expect(
        generateMetadata({ userId: user.id, projectId: project.id }),
      ).rejects.toMatchObject({ code: "conflict" });

      const { getMetadata } = await import("@/lib/metadata/service");
      expect((await getMetadata(user.id, project.id))?.title).toBe(
        "My own title, thanks",
      );
      // One generation call, from before the edit. The refused one never ran, so
      // the refusal also saved the tokens.
      expect(ai.generateJson).toHaveBeenCalledTimes(1);
    });

    it("replaces an edited row only when regeneration is confirmed", async () => {
      const { user, project } = await withScript("metaforce@tally.test");
      ai.generateJson.mockResolvedValue(metadataDraft());
      const { generateMetadata, updateMetadata } = await import(
        "@/lib/metadata/service"
      );

      await generateMetadata({ userId: user.id, projectId: project.id });
      await updateMetadata({
        userId: user.id,
        projectId: project.id,
        title: "My own title, thanks",
      });

      const regenerated = await generateMetadata({
        userId: user.id,
        projectId: project.id,
        force: true,
      });

      expect(regenerated.title).toBe("Why cheap sensors beat the expensive ones");
      // The stored row is model output again, so the flag has to reset or the
      // next regeneration would refuse for no reason.
      expect(regenerated.editedByUser).toBe(false);
    });

    it("enforces YouTube's tag budget on a hand-edited list", async () => {
      const { user, project } = await withScript("metatags@tally.test");
      ai.generateJson.mockResolvedValue(metadataDraft());
      const { generateMetadata, updateMetadata } = await import(
        "@/lib/metadata/service"
      );

      await generateMetadata({ userId: user.id, projectId: project.id });

      const saved = await updateMetadata({
        userId: user.id,
        projectId: project.id,
        tags: Array.from({ length: 40 }, (_, i) => `tag-number-${i}`),
      });

      // Over 500 characters YouTube rejects the whole upload, so the trim happens
      // on save rather than being discovered at publish time.
      expect(saved.tags.length).toBeLessThanOrEqual(15);
      expect(saved.tags.join(",").length).toBeLessThanOrEqual(500);
    });

    it("rejects a title over YouTube's limit", async () => {
      const { user, project } = await withScript("metatitle@tally.test");
      ai.generateJson.mockResolvedValue(metadataDraft());
      const { generateMetadata, getMetadata, updateMetadata } = await import(
        "@/lib/metadata/service"
      );

      await generateMetadata({ userId: user.id, projectId: project.id });

      await expect(
        updateMetadata({
          userId: user.id,
          projectId: project.id,
          title: "x".repeat(101),
        }),
      ).rejects.toMatchObject({ code: "validation_failed" });

      // Rejected outright rather than silently truncated: a title cut at 100
      // characters is not the title the user asked for.
      expect((await getMetadata(user.id, project.id))?.title).toBe(
        "Why cheap sensors beat the expensive ones",
      );
    });

    it("refuses to edit metadata that does not exist yet", async () => {
      const { user, project } = await withScript("metanoedit@tally.test");
      const { updateMetadata } = await import("@/lib/metadata/service");

      await expect(
        updateMetadata({
          userId: user.id,
          projectId: project.id,
          title: "Editing nothing",
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    });

    it("refuses another user's metadata", async () => {
      const { user, project } = await withScript("metaowner@tally.test");
      ai.generateJson.mockResolvedValue(metadataDraft());
      const { generateMetadata, getMetadata, updateMetadata } = await import(
        "@/lib/metadata/service"
      );

      await generateMetadata({ userId: user.id, projectId: project.id });
      const intruder = await createUser({ email: "metaintruder@tally.test" });

      expect(await getMetadata(intruder.id, project.id)).toBeNull();
      await expect(
        updateMetadata({
          userId: intruder.id,
          projectId: project.id,
          title: "Hijacked",
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        generateMetadata({ userId: intruder.id, projectId: project.id }),
      ).rejects.toMatchObject({ code: "forbidden" });
    });
  });
});
