/**
 * The guards every handler runs before it does any work (§34, §31).
 *
 * Two properties, and both were broken at once:
 *
 *  1. The owning user comes from the `jobs` row, never from the payload. A worker
 *     that trusted a payload `userId` would let anyone who can write to Redis
 *     render into another tenant's storage.
 *  2. Those guards fail with *typed* errors. `shouldRetry` treats an unrecognised
 *     error as a possible network fault, so a bare `Error` for a permanent
 *     condition costs the full retry budget — which is what produced a queue of
 *     1099 undeliverable jobs.
 *
 * The services are mocked: this file is about the guards, and the stage logic has
 * its own tests plus integration coverage.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { shouldRetry } from "@/worker/runner";

const rowsFor = vi.fn<() => Array<Record<string, unknown>>>(() => []);

/**
 * A stand-in for the one query these handlers make.
 *
 * Mocked at `@/lib/db` rather than by pointing the real client at Postgres,
 * because the assertion is about which branch the guard takes for a given row —
 * that is decided in TypeScript, not in SQL.
 */
vi.mock("@/lib/db", () => {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rowsFor()),
  };
  return { db: chain };
});

const executeResearchRun = vi.fn();
const executeScriptGeneration = vi.fn();
const executeScenePlan = vi.fn();
const executeSceneRegeneration = vi.fn();
const executePublish = vi.fn();
const forgetUploadProgress = vi.fn();

vi.mock("@/lib/research/service", () => ({
  RESEARCH_JOB_NAME: "research-run",
  executeResearchRun: (...a: unknown[]) => executeResearchRun(...a),
}));
vi.mock("@/lib/scripts/service", () => ({
  SCRIPT_JOB_NAME: "script-generate",
  executeScriptGeneration: (...a: unknown[]) => executeScriptGeneration(...a),
}));
/**
 * Every stage name the registry reads, including the two continuity stages.
 *
 * A missing name here does not fail loudly at the mock — it registers a handler
 * under the key `undefined`, so the stage silently disappears from `videoHandlers`
 * and the guard tests for it stop running. Hence the whole list.
 */
vi.mock("@/lib/video/service", () => ({
  SCENE_PLAN_JOB: "video-scene-plan",
  VOICEOVER_JOB: "video-voiceover",
  VISUALS_JOB: "video-visuals",
  CONTINUITY_JOB: "video-continuity-check",
  SCENE_REGEN_JOB: "video-scene-regenerate",
  REFERENCE_IMAGES_JOB: "video-reference-images",
  MUSIC_JOB: "video-music",
  CAPTIONS_JOB: "video-captions",
  TIMELINE_JOB: "video-timeline",
  RENDER_JOB: "video-render",
  executeScenePlan: (...a: unknown[]) => executeScenePlan(...a),
  executeVoiceover: vi.fn(),
  executeVisuals: vi.fn(),
  executeContinuityCheck: vi.fn(),
  executeReferenceImages: vi.fn(),
  executeSceneRegeneration: (...a: unknown[]) => executeSceneRegeneration(...a),
  executeMusic: vi.fn(),
  executeCaptions: vi.fn(),
  executeTimeline: vi.fn(),
  executeRender: vi.fn(),
}));
vi.mock("@/lib/publish/service", () => ({
  PUBLISH_JOB: "publish-video",
  executePublish: (...a: unknown[]) => executePublish(...a),
  forgetUploadProgress: (...a: unknown[]) => forgetUploadProgress(...a),
}));

const { researchHandler } = await import("@/worker/handlers/research");
const { scriptHandler } = await import("@/worker/handlers/script");
const { videoHandlers } = await import("@/worker/handlers/video");
const { publishHandler } = await import("@/worker/handlers/publish");

const JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CHANNEL_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RUN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PUBLISH_JOB_ID = "11111111-1111-4111-8111-111111111111";

function ctx(payload: Record<string, unknown>) {
  return { jobId: JOB_ID, payload, traceId: "trace", attempt: 1 };
}

const stage = (name: string) => {
  const handler = videoHandlers[name];
  if (!handler) throw new Error(`${name} handler is not registered`);
  return handler;
};

const scenePlan = () => stage("video-scene-plan");

beforeEach(() => {
  vi.clearAllMocks();
  rowsFor.mockReturnValue([]);
});

describe.each([
  {
    label: "research",
    run: () => researchHandler(ctx({ runId: RUN_ID, channelId: CHANNEL_ID })),
    row: { userId: USER_ID, channelId: CHANNEL_ID },
    badPayload: () => researchHandler(ctx({ runId: "not-a-uuid", channelId: CHANNEL_ID })),
    mismatched: { userId: USER_ID, channelId: RUN_ID },
  },
  {
    label: "script",
    run: () => scriptHandler(ctx({ projectId: PROJECT_ID })),
    row: { userId: USER_ID, projectId: PROJECT_ID },
    badPayload: () => scriptHandler(ctx({ projectId: 42 })),
    mismatched: { userId: USER_ID, projectId: CHANNEL_ID },
  },
  {
    label: "video stage",
    run: () => scenePlan()(ctx({ projectId: PROJECT_ID, tier: "studio" })),
    row: { userId: USER_ID, projectId: PROJECT_ID },
    badPayload: () => scenePlan()(ctx({})),
    mismatched: { userId: USER_ID, projectId: CHANNEL_ID },
  },
  {
    /**
     * The continuity check is a stage like any other, and gets the same guards.
     * Worth stating explicitly: it reads a project's story bible and scene states,
     * so a handler that took the payload's `userId` would read another tenant's
     * bible (§20).
     */
    label: "continuity check",
    run: () =>
      stage("video-continuity-check")(ctx({ projectId: PROJECT_ID, tier: "studio" })),
    row: { userId: USER_ID, projectId: PROJECT_ID },
    badPayload: () => stage("video-continuity-check")(ctx({})),
    mismatched: { userId: USER_ID, projectId: CHANNEL_ID },
  },
  {
    /**
     * Scene regeneration has its own payload schema, so its guards are a separate
     * code path rather than the shared one — and it is the stage that spends money
     * on a mistake, since a regeneration is a paid generation.
     */
    label: "scene regeneration",
    run: () =>
      stage("video-scene-regenerate")(
        ctx({ projectId: PROJECT_ID, tier: "studio", sceneIndex: 3 }),
      ),
    row: { userId: USER_ID, projectId: PROJECT_ID },
    // No `sceneIndex`: required rather than defaulted, because defaulting to zero
    // would rebuild the wrong scene at full price.
    badPayload: () =>
      stage("video-scene-regenerate")(ctx({ projectId: PROJECT_ID, tier: "studio" })),
    mismatched: { userId: USER_ID, projectId: CHANNEL_ID },
  },
  {
    /**
     * Reference stills spend one paid generation per bible entity, so a guard that
     * failed open here would bill a tenant for illustrating somebody else's cast —
     * and store the results against their project.
     *
     * The ordinary payload and therefore the shared guard path: which entities get
     * drawn is read from the stored bible inside the stage, never taken from the job
     * message.
     */
    label: "reference stills",
    run: () =>
      stage("video-reference-images")(ctx({ projectId: PROJECT_ID, tier: "studio" })),
    row: { userId: USER_ID, projectId: PROJECT_ID },
    badPayload: () => stage("video-reference-images")(ctx({})),
    mismatched: { userId: USER_ID, projectId: CHANNEL_ID },
  },
  {
    /**
     * The publish handler matters most of the three: a guard that failed open
     * here would upload a video to another tenant's YouTube channel with that
     * tenant's OAuth token, which cannot be undone (§34).
     */
    label: "publish",
    run: () =>
      publishHandler(
        ctx({ projectId: PROJECT_ID, publishJobId: PUBLISH_JOB_ID }),
      ),
    row: { userId: USER_ID, projectId: PROJECT_ID },
    badPayload: () => publishHandler(ctx({ projectId: PROJECT_ID })),
    mismatched: { userId: USER_ID, projectId: CHANNEL_ID },
  },
])("$label handler", ({ run, row, badPayload, mismatched }) => {
  it("throws a discardable NotFoundError when the job row is gone", async () => {
    rowsFor.mockReturnValue([]);

    const error = await run().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundError);
    // The property that matters: BullMQ will discard rather than replay this.
    expect(shouldRetry(error)).toBe(false);
  });

  it("rejects a malformed payload without retrying it", async () => {
    rowsFor.mockReturnValue([row]);

    const error = await badPayload().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationError);
    expect(shouldRetry(error)).toBe(false);
  });

  it("refuses a payload whose ids disagree with the job row", async () => {
    rowsFor.mockReturnValue([mismatched]);

    const error = await run().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenError);
    expect(shouldRetry(error)).toBe(false);
  });
});

describe("authority comes from the job row", () => {
  it("passes the row's userId to the service, ignoring the payload's", async () => {
    rowsFor.mockReturnValue([{ userId: USER_ID, projectId: PROJECT_ID }]);
    executeScriptGeneration.mockResolvedValue({
      scriptId: "s",
      versionId: "v",
      version: 1,
      wordCount: 10,
      estimatedDurationSeconds: 5,
    });

    // An attacker-controlled `userId` in the Redis payload must be inert.
    await scriptHandler(
      ctx({ projectId: PROJECT_ID, userId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }),
    );

    expect(executeScriptGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, projectId: PROJECT_ID }),
    );
  });

  it("defaults an absent tier rather than failing a job from an older build", async () => {
    rowsFor.mockReturnValue([{ userId: USER_ID, projectId: PROJECT_ID }]);
    executeScenePlan.mockResolvedValue({ sceneCount: 4 });

    await scenePlan()(ctx({ projectId: PROJECT_ID }));

    expect(executeScenePlan).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "starter", userId: USER_ID }),
    );
  });

  it("regenerates the requested scene for the row's user, not the payload's", async () => {
    rowsFor.mockReturnValue([{ userId: USER_ID, projectId: PROJECT_ID }]);
    executeSceneRegeneration.mockResolvedValue({ regenerated: true });

    await stage("video-scene-regenerate")(
      ctx({
        projectId: PROJECT_ID,
        sceneIndex: 3,
        userId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      }),
    );

    // The scene index does come from the payload — it is the one thing the job
    // carries that the row cannot supply — but the owner does not.
    expect(executeSceneRegeneration).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, projectId: PROJECT_ID, sceneIndex: 3 }),
    );
  });

  it("uploads for the row's user, not a userId injected into the publish payload", async () => {
    rowsFor.mockReturnValue([{ userId: USER_ID, projectId: PROJECT_ID }]);
    executePublish.mockResolvedValue({
      youtubeVideoId: "v",
      url: "https://www.youtube.com/watch?v=v",
      uploadStatus: "uploaded",
      privacyStatus: "public",
      thumbnailSet: true,
      disclosureOutstanding: true,
    });

    await publishHandler(
      ctx({
        projectId: PROJECT_ID,
        publishJobId: PUBLISH_JOB_ID,
        userId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      }),
    );

    expect(executePublish).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, projectId: PROJECT_ID }),
    );
  });

  it("releases the publish progress throttle even when the upload fails", async () => {
    rowsFor.mockReturnValue([{ userId: USER_ID, projectId: PROJECT_ID }]);
    executePublish.mockRejectedValue(new Error("network reset"));

    await publishHandler(
      ctx({ projectId: PROJECT_ID, publishJobId: PUBLISH_JOB_ID }),
    ).catch(() => {});

    // A long-lived worker would otherwise keep one map entry per video it ever
    // attempted.
    expect(forgetUploadProgress).toHaveBeenCalledWith(PUBLISH_JOB_ID);
  });
});
