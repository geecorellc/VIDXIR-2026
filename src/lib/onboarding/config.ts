/**
 * §5 onboarding — the questions, their allowed answers, and the Zod schema the
 * API validates against.
 *
 * Kept in one module shared by the client screen and the server route so the
 * option lists cannot drift apart, and so the server never accepts a value the
 * UI did not offer (§34: validate all input).
 */
import { z } from "zod";

export interface Choice {
  value: string;
  label: string;
  /** Shown under the label in card-style pickers. */
  hint?: string;
}

/**
 * Starting niches. Free text is also accepted — this list exists to make the
 * common cases one click, not to constrain the user to our taxonomy.
 */
export const NICHES: readonly Choice[] = [
  { value: "ai-technology", label: "AI & technology" },
  { value: "business-finance", label: "Business & finance" },
  { value: "self-improvement", label: "Self improvement" },
  { value: "education-explainers", label: "Education & explainers" },
  { value: "gaming", label: "Gaming" },
  { value: "health-fitness", label: "Health & fitness" },
  { value: "news-commentary", label: "News & commentary" },
  { value: "history-culture", label: "History & culture" },
  { value: "science-space", label: "Science & space" },
  { value: "travel-places", label: "Travel & places" },
  { value: "food-cooking", label: "Food & cooking" },
  { value: "other", label: "Something else" },
] as const;

/** BCP-47 tags — the same values the voice and caption providers accept. */
export const LANGUAGES: readonly Choice[] = [
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "es-ES", label: "Spanish (Spain)" },
  { value: "es-MX", label: "Spanish (Latin America)" },
  { value: "pt-BR", label: "Portuguese (Brazil)" },
  { value: "fr-FR", label: "French" },
  { value: "de-DE", label: "German" },
  { value: "it-IT", label: "Italian" },
  { value: "nl-NL", label: "Dutch" },
  { value: "pl-PL", label: "Polish" },
  { value: "hi-IN", label: "Hindi" },
  { value: "id-ID", label: "Indonesian" },
  { value: "ja-JP", label: "Japanese" },
  { value: "ko-KR", label: "Korean" },
  { value: "ar-SA", label: "Arabic" },
] as const;

export interface LengthChoice extends Choice {
  seconds: number;
}

export const VIDEO_LENGTHS: readonly LengthChoice[] = [
  { value: "short", label: "Under 60 seconds", hint: "Shorts", seconds: 55 },
  { value: "brief", label: "3–5 minutes", hint: "Quick explainers", seconds: 240 },
  { value: "standard", label: "6–10 minutes", hint: "The YouTube default", seconds: 480 },
  { value: "long", label: "12–20 minutes", hint: "Deep dives", seconds: 900 },
] as const;

export const UPLOAD_FREQUENCIES: readonly Choice[] = [
  { value: "1", label: "Once a week" },
  { value: "2", label: "Twice a week" },
  { value: "3", label: "Three times a week" },
  { value: "5", label: "Five times a week" },
  { value: "7", label: "Every day" },
] as const;

export const CONTENT_STYLES: readonly Choice[] = [
  { value: "documentary", label: "Documentary", hint: "Measured, narrated, archival feel" },
  { value: "explainer", label: "Explainer", hint: "Clear, structured, teaching-first" },
  { value: "listicle", label: "List & countdown", hint: "Ranked, punchy, high retention" },
  { value: "commentary", label: "Commentary", hint: "Opinionated take on what is happening" },
  { value: "storytelling", label: "Storytelling", hint: "Narrative arc, cinematic pacing" },
  { value: "tutorial", label: "Tutorial", hint: "Step by step, screen-led" },
] as const;

export const VOICE_PREFERENCES: readonly Choice[] = [
  { value: "warm-female", label: "Warm female", hint: "Approachable, conversational" },
  { value: "warm-male", label: "Warm male", hint: "Approachable, conversational" },
  { value: "authoritative-female", label: "Authoritative female", hint: "Documentary narration" },
  { value: "authoritative-male", label: "Authoritative male", hint: "Documentary narration" },
  { value: "energetic", label: "Energetic", hint: "Fast, high-attention delivery" },
  { value: "own-voice", label: "I'll record my own", hint: "Skip AI voiceover" },
] as const;

export const AUTOMATION_LEVELS: readonly Choice[] = [
  {
    value: "manual",
    label: "I approve every step",
    hint: "Vidxir AI researches and drafts; nothing moves without you.",
  },
  {
    value: "assisted",
    label: "Build it, then ask me",
    hint: "Vidxir AI produces the finished video and waits for your approval to publish.",
  },
  {
    value: "autopilot",
    label: "Run it end to end",
    hint: "Vidxir AI researches, produces and publishes on your schedule.",
  },
] as const;

export const WEEKDAYS: readonly Choice[] = [
  { value: "0", label: "Sun" },
  { value: "1", label: "Mon" },
  { value: "2", label: "Tue" },
  { value: "3", label: "Wed" },
  { value: "4", label: "Thu" },
  { value: "5", label: "Fri" },
  { value: "6", label: "Sat" },
] as const;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const values = (choices: readonly Choice[]) => choices.map((c) => c.value);

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Step payloads. Each step PATCHes only its own keys, so a partial answer set
 * persists and a browser refresh resumes where the user left off (§45).
 */
export const onboardingPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    declaredChannelUrl: z.string().trim().max(500).optional(),
    niche: z.string().trim().min(2).max(160).optional(),
    targetAudience: z.string().trim().max(1000).optional(),
    contentLanguage: z.enum(values(LANGUAGES) as [string, ...string[]]).optional(),
    preferredLengthSeconds: z.number().int().min(15).max(3600).optional(),
    uploadsPerWeek: z.number().int().min(1).max(14).optional(),
    contentStyle: z.enum(values(CONTENT_STYLES) as [string, ...string[]]).optional(),
    voicePreference: z
      .enum(values(VOICE_PREFERENCES) as [string, ...string[]])
      .optional(),
    automationLevel: z.enum(["manual", "assisted", "autopilot"]).optional(),
    publishDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    publishTimes: z.array(z.string().regex(HHMM)).min(1).max(6).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    lastStep: z.number().int().min(0).max(20).optional(),
  })
  .strict();

export type OnboardingPatch = z.infer<typeof onboardingPatchSchema>;

/** Fields that must be answered before onboarding can be marked complete. */
export const REQUIRED_FIELDS = [
  "niche",
  "contentLanguage",
  "preferredLengthSeconds",
  "uploadsPerWeek",
  "contentStyle",
  "voicePreference",
  "automationLevel",
] as const;

export type RequiredField = (typeof REQUIRED_FIELDS)[number];

/** The wizard's steps, used for the progress rail and the resume position. */
export const ONBOARDING_STEPS = [
  { id: "you", title: "About you", eyebrow: "Step 01" },
  { id: "channel", title: "Your channel", eyebrow: "Step 02" },
  { id: "audience", title: "Who it's for", eyebrow: "Step 03" },
  { id: "format", title: "Format", eyebrow: "Step 04" },
  { id: "voice", title: "Voice & style", eyebrow: "Step 05" },
  { id: "automation", title: "How hands-off", eyebrow: "Step 06" },
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]["id"];

/** Resolve a length preset back to a label, for summaries. */
export function lengthLabel(seconds: number): string {
  const match = VIDEO_LENGTHS.find((l) => l.seconds === seconds);
  if (match) return match.label;
  // Under a minute stays in seconds; rounding 30s up to "about 1 minutes" was
  // both wrong and ungrammatical.
  if (seconds < 60) return `${Math.round(seconds)} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "about a minute" : `about ${minutes} minutes`;
}

/** Resolve a stored niche value (slug or free text) to a display label. */
export function nicheLabel(value: string): string {
  return NICHES.find((n) => n.value === value)?.label ?? value;
}

export function choiceLabel(choices: readonly Choice[], value: string): string {
  return choices.find((c) => c.value === value)?.label ?? value;
}
