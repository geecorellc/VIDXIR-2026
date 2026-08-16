/**
 * §20 — the project state machine.
 *
 * The whole point of this file is that a project's state is a *persisted*,
 * *validated* value, not a React variable. Two properties matter:
 *
 *  1. Transitions are declared, so an out-of-order write (e.g. jumping to
 *     PUBLISHED from SCRIPT_READY) fails loudly instead of quietly corrupting a
 *     project. §42 forbids showing "Published" that YouTube never confirmed;
 *     the cheapest way to guarantee that is to make the illegal transition
 *     impossible to write.
 *  2. Every transition is appended to `project_events`, so a stuck project is
 *     diagnosable after the fact rather than a mystery.
 */

export const PROJECT_STATUSES = [
  "IDEA",
  "SCRIPT_GENERATING",
  "SCRIPT_READY",
  "ASSETS_GENERATING",
  "ASSETS_READY",
  "RENDERING",
  "VIDEO_READY",
  "THUMBNAIL_GENERATING",
  "READY_TO_PUBLISH",
  "SCHEDULED",
  "PUBLISHING",
  "PUBLISHED",
  "FAILED",
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * Legal successors for each state.
 *
 * Notes on the less obvious edges:
 *  - Every non-terminal state may go to FAILED. A provider can fail at any point.
 *  - FAILED goes back to the *generating* states, because retry re-runs the stage
 *    that failed rather than resuming mid-stage.
 *  - READY_TO_PUBLISH ↔ SCHEDULED both ways: a user may unschedule.
 *  - PUBLISHING → READY_TO_PUBLISH is absent by design. A failed upload goes to
 *    FAILED so the failure is visible and explicitly retried; it must never
 *    silently reappear as "ready" as though nothing happened.
 *  - PUBLISHED is terminal. Nothing transitions out of it.
 */
const TRANSITIONS: Record<ProjectStatus, readonly ProjectStatus[]> = {
  IDEA: ["SCRIPT_GENERATING", "FAILED"],
  SCRIPT_GENERATING: ["SCRIPT_READY", "FAILED"],
  // Regenerating a script is a legal loop back to SCRIPT_GENERATING.
  SCRIPT_READY: ["SCRIPT_GENERATING", "ASSETS_GENERATING", "FAILED"],
  ASSETS_GENERATING: ["ASSETS_READY", "FAILED"],
  ASSETS_READY: ["RENDERING", "ASSETS_GENERATING", "FAILED"],
  RENDERING: ["VIDEO_READY", "FAILED"],
  VIDEO_READY: [
    "THUMBNAIL_GENERATING",
    "READY_TO_PUBLISH",
    "RENDERING",
    "FAILED",
  ],
  THUMBNAIL_GENERATING: ["READY_TO_PUBLISH", "VIDEO_READY", "FAILED"],
  READY_TO_PUBLISH: [
    "SCHEDULED",
    "PUBLISHING",
    "THUMBNAIL_GENERATING",
    "FAILED",
  ],
  SCHEDULED: ["PUBLISHING", "READY_TO_PUBLISH", "FAILED"],
  PUBLISHING: ["PUBLISHED", "FAILED"],
  PUBLISHED: [],
  FAILED: [
    "SCRIPT_GENERATING",
    "ASSETS_GENERATING",
    "RENDERING",
    "THUMBNAIL_GENERATING",
    "READY_TO_PUBLISH",
    "PUBLISHING",
  ],
};

export function canTransition(from: ProjectStatus, to: ProjectStatus): boolean {
  // A no-op write is harmless — an idempotent worker retry may re-assert its
  // own state, and rejecting that would turn a duplicate delivery into an error.
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: ProjectStatus): readonly ProjectStatus[] {
  return TRANSITIONS[from];
}

export function isTerminal(status: ProjectStatus): boolean {
  return status === "PUBLISHED";
}

/** A project the user must act on before anything else can happen (§37). */
export function needsUserAction(status: ProjectStatus): boolean {
  return (
    status === "SCRIPT_READY" ||
    status === "VIDEO_READY" ||
    status === "READY_TO_PUBLISH" ||
    status === "FAILED"
  );
}

/** Whether background work is currently expected to be running. */
export function isWorking(status: ProjectStatus): boolean {
  return (
    status === "SCRIPT_GENERATING" ||
    status === "ASSETS_GENERATING" ||
    status === "RENDERING" ||
    status === "THUMBNAIL_GENERATING" ||
    status === "PUBLISHING"
  );
}

/**
 * Human-facing status label. §18's vocabulary, kept in one place so the sidebar,
 * the project list and the publish screen cannot disagree.
 */
export const STATUS_LABEL: Record<ProjectStatus, string> = {
  IDEA: "Idea",
  SCRIPT_GENERATING: "Writing script",
  SCRIPT_READY: "Script ready for review",
  ASSETS_GENERATING: "Generating",
  ASSETS_READY: "Assets ready",
  RENDERING: "Rendering",
  VIDEO_READY: "Video ready",
  THUMBNAIL_GENERATING: "Designing thumbnail",
  READY_TO_PUBLISH: "Ready for review",
  SCHEDULED: "Scheduled",
  PUBLISHING: "Publishing",
  PUBLISHED: "Published",
  FAILED: "Failed",
};

/** Token key used to colour a status chip. */
export function statusTone(
  status: ProjectStatus,
): "neutral" | "working" | "action" | "success" | "danger" {
  if (status === "PUBLISHED") return "success";
  if (status === "FAILED") return "danger";
  if (isWorking(status)) return "working";
  if (needsUserAction(status)) return "action";
  return "neutral";
}

/**
 * How far a project has progressed, for gating the dashboard's later stages.
 * Mirrors the prototype's `!project.script` sidebar locks, but derived from
 * persisted status rather than a nulled-out React field.
 */
export function projectReach(
  status: ProjectStatus,
): "none" | "idea" | "script" | "video" {
  switch (status) {
    case "IDEA":
    case "SCRIPT_GENERATING":
      return "idea";
    case "SCRIPT_READY":
    case "ASSETS_GENERATING":
    case "ASSETS_READY":
    case "RENDERING":
      return "script";
    case "VIDEO_READY":
    case "THUMBNAIL_GENERATING":
    case "READY_TO_PUBLISH":
    case "SCHEDULED":
    case "PUBLISHING":
    case "PUBLISHED":
      return "video";
    case "FAILED":
      // A failed project keeps whatever it had; the screen it failed on decides
      // what to offer. Treating it as "script" keeps the Video tab reachable so
      // the user can see the failure and retry it.
      return "script";
    default:
      return "none";
  }
}
