/**
 * The six product stages shown on the landing page, and the pipeline stage
 * metadata used by the video status display.
 *
 * The landing copy is verbatim from the prototype (§44: the JSX is the UI
 * contract). The pipeline list below is the production expansion of it — the
 * prototype's four simulated asset keys become the real §10 stage set.
 */

export interface MarketingStage {
  n: string;
  title: string;
  body: string;
  /** lucide icon name, resolved by the component. */
  icon: string;
}

/** Landing page stage cards — copy preserved from the prototype. */
export const MARKETING_STAGES: readonly MarketingStage[] = [
  {
    n: "01",
    title: "Research",
    body: "Vidxir AI watches your niche, scores what is breaking out, and finds the angle nobody has taken yet.",
    icon: "TrendingUp",
  },
  {
    n: "02",
    title: "Script",
    body: "An original script built around the opportunity — hook, story, and a close that earns the subscribe.",
    icon: "FileText",
  },
  {
    n: "03",
    title: "Video",
    body: "Voiceover, b-roll, music and captions assembled on a real timeline and rendered to 1080p.",
    icon: "Clapperboard",
  },
  {
    n: "04",
    title: "Thumbnail",
    body: "Four competing concepts built for curiosity, contrast and legibility at 320 pixels wide.",
    icon: "ImageIcon",
  },
  {
    n: "05",
    title: "Publish",
    body: "Title, description, tags and chapters written, checked, then uploaded on your schedule.",
    icon: "Rocket",
  },
  {
    n: "06",
    title: "Scale",
    body: "Every result feeds back into the next round of research, across every channel you run.",
    icon: "BarChart3",
  },
] as const;

// ---------------------------------------------------------------------------
// Pipeline stages (§10, §38)
// ---------------------------------------------------------------------------

export type PipelineStage =
  | "RESEARCH"
  | "SCRIPT"
  | "SCENE_PLAN"
  | "VOICEOVER"
  | "VISUALS"
  | "MUSIC"
  | "CAPTIONS"
  | "TIMELINE"
  | "RENDER"
  | "QUALITY_CHECK"
  | "THUMBNAIL"
  | "METADATA"
  | "PUBLISH";

export interface StageMeta {
  stage: PipelineStage;
  /** Label shown in the status list, e.g. "B-roll". */
  label: string;
  /** Which provider capability this stage depends on. */
  capability:
    | "ai"
    | "voice"
    | "visuals"
    | "music"
    | "transcription"
    | "render"
    | "youtube"
    | null;
  /** Rough share of total pipeline time, used for overall progress weighting. */
  weight: number;
}

/**
 * Ordered production pipeline. Weights sum to 100 and are used to compute a
 * project's overall progress from completed stages — a derived number from real
 * stage state, not an animated guess.
 */
export const PIPELINE_STAGES: readonly StageMeta[] = [
  { stage: "SCRIPT", label: "Script", capability: "ai", weight: 8 },
  { stage: "SCENE_PLAN", label: "Scene plan", capability: "ai", weight: 5 },
  { stage: "VOICEOVER", label: "Voiceover", capability: "voice", weight: 14 },
  { stage: "VISUALS", label: "B-roll", capability: "visuals", weight: 20 },
  { stage: "MUSIC", label: "Music", capability: "music", weight: 5 },
  { stage: "CAPTIONS", label: "Captions", capability: "transcription", weight: 10 },
  { stage: "TIMELINE", label: "Timeline", capability: null, weight: 3 },
  { stage: "RENDER", label: "Rendering", capability: "render", weight: 25 },
  { stage: "QUALITY_CHECK", label: "Quality check", capability: null, weight: 4 },
  { stage: "THUMBNAIL", label: "Thumbnail", capability: "ai", weight: 4 },
  { stage: "METADATA", label: "Metadata", capability: "ai", weight: 2 },
] as const;

export function stageMeta(stage: PipelineStage): StageMeta | undefined {
  return PIPELINE_STAGES.find((s) => s.stage === stage);
}

export function stageLabel(stage: PipelineStage): string {
  return stageMeta(stage)?.label ?? stage.replace(/_/g, " ").toLowerCase();
}
