/**
 * State machine tests (§20, §39, §42).
 *
 * The important assertion in this file is the last group: PUBLISHED must be
 * unreachable except from PUBLISHING, and PUBLISHING must not be able to slide
 * back to "ready" on failure. §42 forbids showing "Published" that YouTube never
 * confirmed, and this table is the mechanism that makes that impossible.
 */
import { describe, expect, it } from "vitest";
import {
  PROJECT_STATUSES,
  STATUS_LABEL,
  allowedTransitions,
  canTransition,
  isTerminal,
  isWorking,
  needsUserAction,
  projectReach,
  statusTone,
  type ProjectStatus,
} from "@/lib/projects/state-machine";

describe("transition table", () => {
  it("covers every status", () => {
    for (const status of PROJECT_STATUSES) {
      expect(allowedTransitions(status)).toBeDefined();
    }
  });

  it("only ever names statuses that exist", () => {
    for (const status of PROJECT_STATUSES) {
      for (const next of allowedTransitions(status)) {
        expect(PROJECT_STATUSES).toContain(next);
      }
    }
  });

  it("allows a no-op write so an idempotent worker retry is not an error", () => {
    for (const status of PROJECT_STATUSES) {
      expect(canTransition(status, status)).toBe(true);
    }
  });

  it("lets every non-terminal state fail", () => {
    for (const status of PROJECT_STATUSES) {
      if (status === "FAILED" || isTerminal(status)) continue;
      expect(canTransition(status, "FAILED")).toBe(true);
    }
  });

  it("walks the happy path from IDEA to PUBLISHED", () => {
    const path: ProjectStatus[] = [
      "IDEA",
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
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      const from = path[i]!;
      const to = path[i + 1]!;
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  it("refuses to skip stages", () => {
    expect(canTransition("SCRIPT_READY", "PUBLISHED")).toBe(false);
    expect(canTransition("IDEA", "RENDERING")).toBe(false);
    expect(canTransition("SCRIPT_READY", "RENDERING")).toBe(false);
    expect(canTransition("ASSETS_GENERATING", "READY_TO_PUBLISH")).toBe(false);
  });
});

describe("PUBLISHED is only reachable from a confirmed upload (§42)", () => {
  it("has PUBLISHING as its only predecessor", () => {
    const predecessors = PROJECT_STATUSES.filter(
      (s) => s !== "PUBLISHED" && allowedTransitions(s).includes("PUBLISHED"),
    );
    expect(predecessors).toEqual(["PUBLISHING"]);
  });

  it("is terminal — nothing transitions out of it", () => {
    expect(allowedTransitions("PUBLISHED")).toHaveLength(0);
    expect(isTerminal("PUBLISHED")).toBe(true);
    for (const status of PROJECT_STATUSES) {
      if (status === "PUBLISHED") continue;
      expect(canTransition("PUBLISHED", status)).toBe(false);
    }
  });

  it("does not let a failed upload quietly reappear as ready", () => {
    // PUBLISHING -> READY_TO_PUBLISH would hide an upload failure. The only way
    // out is FAILED, which the UI must surface.
    expect(canTransition("PUBLISHING", "READY_TO_PUBLISH")).toBe(false);
    expect(canTransition("PUBLISHING", "SCHEDULED")).toBe(false);
    expect(allowedTransitions("PUBLISHING")).toEqual(["PUBLISHED", "FAILED"]);
  });
});

describe("retry", () => {
  it("lets a failed project re-enter each generating stage", () => {
    for (const stage of [
      "SCRIPT_GENERATING",
      "ASSETS_GENERATING",
      "RENDERING",
      "THUMBNAIL_GENERATING",
      "PUBLISHING",
    ] as const) {
      expect(canTransition("FAILED", stage)).toBe(true);
    }
  });

  it("does not let a failed project jump straight to PUBLISHED", () => {
    expect(canTransition("FAILED", "PUBLISHED")).toBe(false);
  });
});

describe("scheduling", () => {
  it("allows unscheduling", () => {
    expect(canTransition("READY_TO_PUBLISH", "SCHEDULED")).toBe(true);
    expect(canTransition("SCHEDULED", "READY_TO_PUBLISH")).toBe(true);
  });
});

describe("status classification", () => {
  it("labels every status", () => {
    for (const status of PROJECT_STATUSES) {
      expect(STATUS_LABEL[status]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("treats working and action-required as mutually exclusive", () => {
    for (const status of PROJECT_STATUSES) {
      expect(isWorking(status) && needsUserAction(status)).toBe(false);
    }
  });

  it("classifies a failure as action-required, not as work in progress", () => {
    expect(needsUserAction("FAILED")).toBe(true);
    expect(isWorking("FAILED")).toBe(false);
  });

  it("never leaves a status without a tone", () => {
    for (const status of PROJECT_STATUSES) {
      expect(["neutral", "working", "action", "success", "danger"]).toContain(
        statusTone(status),
      );
    }
  });

  it("tones PUBLISHED as success and FAILED as danger", () => {
    expect(statusTone("PUBLISHED")).toBe("success");
    expect(statusTone("FAILED")).toBe("danger");
  });
});

describe("projectReach gates the dashboard tabs", () => {
  it("unlocks nothing beyond the idea before a script exists", () => {
    expect(projectReach("IDEA")).toBe("idea");
    expect(projectReach("SCRIPT_GENERATING")).toBe("idea");
  });

  it("unlocks the video tab once a script is ready", () => {
    expect(projectReach("SCRIPT_READY")).toBe("script");
  });

  it("unlocks the publish tab once a video exists", () => {
    expect(projectReach("VIDEO_READY")).toBe("video");
    expect(projectReach("PUBLISHED")).toBe("video");
  });

  it("keeps a failed project reachable so the user can retry it", () => {
    expect(projectReach("FAILED")).not.toBe("none");
  });
});
