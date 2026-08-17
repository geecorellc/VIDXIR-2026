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

vi.mock("@/lib/research/service", () => ({
  RESEARCH_JOB_NAME: "research-run",
  executeResearchRun: (...a: unknown[]) => executeResearchRun(...a),
}));
vi.mock("@/lib/scripts/service", () => ({
  SCRIPT_JOB_NAME: "script-generate",
  executeScriptGeneration: (...a: unknown[]) => executeScriptGeneration(...a),
}));
vi.mock("@/lib/video/service", () => ({
  SCENE_PLAN_JOB: "video-scene-plan",
  VOICEOVER_JOB: "video-voiceover",
  VISUALS_JOB: "video-visuals",
  MUSIC_JOB: "video-music",
  CAPTIONS_JOB: "video-captions",
  TIMELINE_JOB: "video-timeline",
  RENDER_JOB: "video-render",
  executeScenePlan: (...a: unknown[]) => executeScenePlan(...a),
  executeVoiceover: vi.fn(),
  executeVisuals: vi.fn(),
  executeMusic: vi.fn(),
  executeCaptions: vi.fn(),
  executeTimeline: vi.fn(),
  executeRender: vi.fn(),
}));

const { researchHandler } = await import("@/worker/handlers/research");
const { scriptHandler } = await import("@/worker/handlers/script");
const { videoHandlers } = await import("@/worker/handlers/video");

const JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CHANNEL_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RUN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function ctx(payload: Record<string, unknown>) {
  return { jobId: JOB_ID, payload, traceId: "trace", attempt: 1 };
}

const scenePlan = () => {
  const handler = videoHandlers["video-scene-plan"];
  if (!handler) throw new Error("scene plan handler is not registered");
  return handler;
};

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
});
