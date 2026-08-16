/**
 * Settings vocabulary and validation (§5, §27, §28).
 *
 * Channel settings are deliberately *not* the same object as the onboarding
 * profile. Onboarding captures account-level defaults; those defaults are copied
 * into `channel_settings` when a channel is connected, and from then on the two
 * are independent — §27: "Don't assume shared settings."
 *
 * Every list here is shared by the settings screen and the API route, so the
 * server never accepts a value the UI did not offer (§34).
 */
import { z } from "zod";
import {
  CONTENT_STYLES,
  LANGUAGES,
  VOICE_PREFERENCES,
  type Choice,
} from "@/lib/onboarding/config";

/** Visual treatment for the assembled video (§10 scene planner, §28 brand kit). */
export const VIDEO_STYLES: readonly Choice[] = [
  { value: "broll-narration", label: "B-roll + narration", hint: "Stock footage cut to the voiceover" },
  { value: "motion-graphics", label: "Motion graphics", hint: "Typography and animated panels" },
  { value: "documentary", label: "Documentary", hint: "Slow pans, archival texture" },
  { value: "kinetic", label: "Kinetic", hint: "Fast cuts, high energy" },
] as const;

/** Thumbnail art direction (§16, §28). */
export const THUMBNAIL_STYLES: readonly Choice[] = [
  { value: "bold-text", label: "Bold text", hint: "Large headline, high contrast" },
  { value: "face-reaction", label: "Face & reaction", hint: "Expression-led, close crop" },
  { value: "cinematic", label: "Cinematic", hint: "Filmic still, minimal text" },
  { value: "diagram", label: "Diagram", hint: "Arrows, labels, before/after" },
] as const;

/** Caption presentation, consumed by the caption burn-in step (§28). */
export const CAPTION_STYLES: readonly Choice[] = [
  { value: "none", label: "No burned-in captions" },
  { value: "word-pop", label: "Word pop", hint: "One or two words at a time" },
  { value: "subtitle", label: "Subtitle bar", hint: "Two lines, bottom third" },
  { value: "karaoke", label: "Karaoke", hint: "Line highlighted as it is spoken" },
] as const;

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** YouTube channel ids are `UC` + 22 base64url characters. */
const YOUTUBE_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

const values = (choices: readonly Choice[]) => choices.map((c) => c.value);

/**
 * Per-channel content strategy. Every key optional: the screen PATCHes only the
 * section the user edited, so a partial save is a normal outcome rather than a
 * whole-form replacement.
 */
export const channelSettingsPatchSchema = z
  .object({
    niche: z.string().trim().min(2).max(160).optional(),
    targetAudience: z.string().trim().max(1000).optional(),
    contentLanguage: z.enum(values(LANGUAGES) as [string, ...string[]]).optional(),
    preferredLengthSeconds: z.number().int().min(15).max(3600).optional(),
    uploadsPerWeek: z.number().int().min(1).max(14).optional(),
    contentStyle: z.enum(values(CONTENT_STYLES) as [string, ...string[]]).optional(),
    videoStyle: z.enum(values(VIDEO_STYLES) as [string, ...string[]]).optional(),
    thumbnailStyle: z.enum(values(THUMBNAIL_STYLES) as [string, ...string[]]).optional(),
    voiceStyle: z.enum(values(VOICE_PREFERENCES) as [string, ...string[]]).optional(),
    voiceSpeed: z.number().min(0.5).max(2).optional(),
    /**
     * Competitor channels tracked by the research engine (§7). Validated to the
     * YouTube id shape because these values are later interpolated into API
     * calls — accepting arbitrary strings there is how request forgery starts.
     */
    competitorChannelIds: z
      .array(z.string().trim().regex(YOUTUBE_CHANNEL_ID, "Not a YouTube channel id."))
      .max(25)
      .optional(),
    keywords: z.array(z.string().trim().min(2).max(80)).max(50).optional(),
  })
  .strict();

export type ChannelSettingsPatch = z.infer<typeof channelSettingsPatchSchema>;

/** §28 brand kit. Asset uploads (logo, intro, outro) are handled separately. */
export const brandKitPatchSchema = z
  .object({
    brandName: z.string().trim().max(120).optional(),
    primaryColor: z.string().trim().regex(HEX_COLOR, "Use a hex colour.").optional(),
    secondaryColor: z.string().trim().regex(HEX_COLOR, "Use a hex colour.").optional(),
    fontPreference: z.string().trim().max(80).optional(),
    defaultCta: z.string().trim().max(500).optional(),
    captionStyle: z.enum(values(CAPTION_STYLES) as [string, ...string[]]).optional(),
  })
  .strict();

export type BrandKitPatch = z.infer<typeof brandKitPatchSchema>;

/**
 * §18/§19 publishing cadence.
 *
 * `autoPublish` and any non-empty schedule are plan-gated; the route re-checks
 * entitlement against the `subscriptions` row before persisting, because a
 * request body is not evidence of a plan (§24).
 */
export const automationPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    level: z.enum(["manual", "assisted", "autopilot"]).optional(),
    publishDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    publishTimes: z.array(z.string().regex(HHMM)).min(1).max(6).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    videosPerWeek: z.number().int().min(1).max(14).optional(),
    autoPublish: z.boolean().optional(),
    requireApproval: z.boolean().optional(),
  })
  .strict();

export type AutomationPatch = z.infer<typeof automationPatchSchema>;

/** One PATCH may carry any combination of the three sections. */
export const channelUpdateSchema = z
  .object({
    settings: channelSettingsPatchSchema.optional(),
    brand: brandKitPatchSchema.optional(),
    automation: automationPatchSchema.optional(),
  })
  .strict()
  .refine(
    (v) => v.settings !== undefined || v.brand !== undefined || v.automation !== undefined,
    { message: "Nothing to update." },
  );

export type ChannelUpdate = z.infer<typeof channelUpdateSchema>;

/** Account-level profile fields editable from Settings (a subset of §5). */
export const accountPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
