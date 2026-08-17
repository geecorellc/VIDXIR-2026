/**
 * The retry decision, which is the part of the worker that silently costs money
 * when it is wrong (§30, §31).
 *
 * This exists because of a real incident. Every handler threw a bare `Error` for
 * conditions that can never succeed — a missing `jobs` row, a malformed payload —
 * and `shouldRetry` treats an unrecognised error as a possible network blip. A
 * stale queue therefore replayed 1099 impossible jobs three times each with
 * exponential backoff, and the `job.discard()` path that exists precisely to stop
 * that was never reached.
 *
 * `@/lib/queue/jobs` is mocked because the subject here is the decision, not the
 * SQL; the row transitions have their own integration coverage.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppError,
  ForbiddenError,
  NotConfiguredError,
  NotFoundError,
  ProviderError,
  RateLimitedError,
  ValidationError,
} from "@/lib/errors";

const markJobRunning = vi.fn();
const markJobSucceeded = vi.fn();
const markJobFailed = vi.fn();

vi.mock("@/lib/queue/jobs", () => ({
  markJobRunning: (...args: unknown[]) => markJobRunning(...args),
  markJobSucceeded: (...args: unknown[]) => markJobSucceeded(...args),
  markJobFailed: (...args: unknown[]) => markJobFailed(...args),
}));

const { resolveJobId, runJob, shouldRetry } = await import("@/worker/runner");
type RunnableJob = Parameters<typeof runJob>[2];

function job(overrides: Partial<RunnableJob> = {}): RunnableJob & {
  discard: ReturnType<typeof vi.fn>;
} {
  const discard = vi.fn();
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "test-job",
    data: {},
    attemptsMade: 0,
    opts: { attempts: 3 },
    discard,
    ...overrides,
    // Kept last so an override cannot replace the spy the assertions read.
    ...(overrides.discard ? {} : { discard }),
  } as RunnableJob & { discard: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("shouldRetry", () => {
  it("retries what a provider said was transient", () => {
    expect(shouldRetry(new RateLimitedError(30))).toBe(true);
    expect(
      shouldRetry(new ProviderError("Claude", "upstream hiccup")),
    ).toBe(true);
  });

  it("refuses to retry conditions no attempt can change", () => {
    // Each of these is thrown by a handler for a permanent cause. If any starts
    // reporting `true`, a broken job silently costs three attempts.
    expect(shouldRetry(new NotFoundError("Job row x not found."))).toBe(false);
    expect(shouldRetry(new ValidationError("Invalid pipeline payload"))).toBe(false);
    expect(shouldRetry(new ForbiddenError())).toBe(false);
    expect(shouldRetry(new NotConfiguredError("ElevenLabs", ["ELEVENLABS_API_KEY"]))).toBe(
      false,
    );
    expect(
      shouldRetry(new ProviderError("Claude", "bad request", { retryable: false })),
    ).toBe(false);
  });

  it("retries an unrecognised error, because the usual cause is the network", () => {
    // Deliberate, and the reason the typed errors above matter: anything known to
    // be permanent has to say so, since the default assumption is a blip.
    expect(shouldRetry(new Error("socket hang up"))).toBe(true);
    expect(shouldRetry("not even an error")).toBe(true);
  });

  it("honours a `retryable` flag on a non-AppError", () => {
    const custom = Object.assign(new Error("nope"), { retryable: false });
    expect(shouldRetry(custom)).toBe(false);
  });
});

describe("resolveJobId", () => {
  it("prefers the payload copy, which is what an older build wrote", () => {
    expect(
      resolveJobId(job({ id: "queue-id", data: { jobId: "row-id" } })),
    ).toBe("row-id");
  });

  it("falls back to the BullMQ id, which enqueue sets to the row id", () => {
    expect(resolveJobId(job({ id: "queue-id", data: {} }))).toBe("queue-id");
  });

  it("returns null when there is nothing to correlate on", () => {
    expect(resolveJobId(job({ id: undefined, data: {} }))).toBeNull();
    // An empty string is not a usable id, and would produce a `WHERE id = ''`.
    expect(resolveJobId(job({ id: undefined, data: { jobId: "" } }))).toBeNull();
  });
});

describe("runJob", () => {
  it("records the result of a successful job", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const j = job();

    const outcome = await runJob("pipeline", { "test-job": handler }, j);

    expect(outcome.status).toBe("succeeded");
    expect(outcome.result).toEqual({ ok: true });
    expect(markJobRunning).toHaveBeenCalledWith(j.id, 1, "Starting");
    expect(markJobSucceeded).toHaveBeenCalledWith(j.id, { ok: true }, "Complete");
    expect(markJobFailed).not.toHaveBeenCalled();
    expect(j.discard).not.toHaveBeenCalled();
  });

  it("passes the row id and payload to the handler, not the queue id", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const j = job({ id: "queue-id", data: { jobId: "row-id", projectId: "p1" } });

    await runJob("pipeline", { "test-job": handler }, j);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "row-id",
        payload: { jobId: "row-id", projectId: "p1" },
        attempt: 1,
      }),
    );
  });

  it("discards a permanently-failed job instead of spending its retries", async () => {
    // The 1099-job case: a message whose `jobs` row was truncated away.
    const handler = vi
      .fn()
      .mockRejectedValue(new NotFoundError("Job row row-id not found."));
    const j = job();

    await expect(runJob("pipeline", { "test-job": handler }, j)).rejects.toThrow(
      /not found/,
    );

    expect(j.discard).toHaveBeenCalledOnce();
    expect(markJobFailed).toHaveBeenCalledWith(
      j.id,
      expect.any(NotFoundError),
      { willRetry: false },
    );
  });

  it("keeps a retryable failure alive while attempts remain", async () => {
    const handler = vi.fn().mockRejectedValue(new RateLimitedError(30));
    const j = job({ attemptsMade: 0, opts: { attempts: 3 } });

    await expect(runJob("research", { "test-job": handler }, j)).rejects.toThrow();

    expect(j.discard).not.toHaveBeenCalled();
    // `willRetry` keeps the row `running`, so the UI does not flash "Failed" and
    // then un-fail itself when the next attempt starts.
    expect(markJobFailed).toHaveBeenCalledWith(j.id, expect.any(RateLimitedError), {
      willRetry: true,
    });
  });

  it("reports a retryable failure as terminal on the final attempt", async () => {
    const handler = vi.fn().mockRejectedValue(new RateLimitedError(30));
    const j = job({ attemptsMade: 2, opts: { attempts: 3 } });

    await expect(runJob("research", { "test-job": handler }, j)).rejects.toThrow();

    // Still not discarded — BullMQ has no attempt left to cancel — but the row
    // must read `failed`, not a fourth `running`.
    expect(j.discard).not.toHaveBeenCalled();
    expect(markJobFailed).toHaveBeenCalledWith(j.id, expect.any(RateLimitedError), {
      willRetry: false,
    });
  });

  it("discards a job whose name has no handler", async () => {
    const j = job({ name: "job-from-a-newer-build" });

    await expect(runJob("pipeline", {}, j)).rejects.toThrow(/No handler registered/);

    expect(j.discard).toHaveBeenCalledOnce();
    expect(markJobFailed).toHaveBeenCalledWith(j.id, expect.any(AppError));
    // Never started, so it must not have been marked running.
    expect(markJobRunning).not.toHaveBeenCalled();
  });

  it("refuses a message with no id, and records nothing under a wrong id", async () => {
    const handler = vi.fn();
    const j = job({ id: undefined, data: {} });

    await expect(runJob("pipeline", { "test-job": handler }, j)).rejects.toThrow(
      /has no id/,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(markJobFailed).not.toHaveBeenCalled();
    expect(markJobRunning).not.toHaveBeenCalled();
    expect(j.discard).toHaveBeenCalledOnce();
  });

  it("treats a missing credential as blocked rather than retrying it", async () => {
    // §48: a missing key is a configuration state. `markJobFailed` maps this to
    // `blocked_not_configured`; the harness's part is not to retry it.
    const handler = vi
      .fn()
      .mockRejectedValue(new NotConfiguredError("ElevenLabs", ["ELEVENLABS_API_KEY"]));
    const j = job();

    await expect(runJob("pipeline", { "test-job": handler }, j)).rejects.toThrow();

    expect(j.discard).toHaveBeenCalledOnce();
    expect(markJobFailed).toHaveBeenCalledWith(
      j.id,
      expect.any(NotConfiguredError),
      { willRetry: false },
    );
  });

  it("records a void-returning handler as an empty result", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const j = job();

    const outcome = await runJob("maintenance", { "test-job": handler }, j);

    expect(outcome.result).toBeUndefined();
    expect(markJobSucceeded).toHaveBeenCalledWith(j.id, {}, "Complete");
  });
});
