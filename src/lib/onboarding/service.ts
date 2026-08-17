/**
 * Onboarding persistence (§5, §45).
 *
 * Answers are written to Postgres on every step, not held in React state, so
 * closing the browser mid-flow loses nothing. Completing onboarding stamps
 * `users.onboarded_at`, which is what `requireOnboarded()` checks.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { onboardingProfiles, users } from "@/lib/db/schema";
import { ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  REQUIRED_FIELDS,
  type OnboardingPatch,
  type RequiredField,
} from "@/lib/onboarding/config";

const log = logger.child({ component: "onboarding" });

export interface OnboardingProfile {
  declaredChannelUrl: string | null;
  niche: string | null;
  targetAudience: string | null;
  contentLanguage: string;
  preferredLengthSeconds: number;
  uploadsPerWeek: number;
  contentStyle: string | null;
  voicePreference: string | null;
  automationLevel: "manual" | "assisted" | "autopilot";
  publishDays: number[];
  publishTimes: string[];
  timezone: string;
  lastStep: number;
  completedAt: Date | null;
}

/** Read the user's profile, creating the row on first access. */
export async function getProfile(userId: string): Promise<OnboardingProfile> {
  const existing = await load(userId);
  if (existing) return existing;

  await db.insert(onboardingProfiles).values({ userId }).onConflictDoNothing();
  const created = await load(userId);
  if (!created) {
    // The insert either succeeded or conflicted with a concurrent insert; a
    // missing row here means something is wrong with the write path.
    throw new Error("Failed to create onboarding profile");
  }
  return created;
}

async function load(userId: string): Promise<OnboardingProfile | null> {
  const rows = await db
    .select({
      declaredChannelUrl: onboardingProfiles.declaredChannelUrl,
      niche: onboardingProfiles.niche,
      targetAudience: onboardingProfiles.targetAudience,
      contentLanguage: onboardingProfiles.contentLanguage,
      preferredLengthSeconds: onboardingProfiles.preferredLengthSeconds,
      uploadsPerWeek: onboardingProfiles.uploadsPerWeek,
      contentStyle: onboardingProfiles.contentStyle,
      voicePreference: onboardingProfiles.voicePreference,
      automationLevel: onboardingProfiles.automationLevel,
      publishDays: onboardingProfiles.publishDays,
      publishTimes: onboardingProfiles.publishTimes,
      timezone: onboardingProfiles.timezone,
      lastStep: onboardingProfiles.lastStep,
      completedAt: onboardingProfiles.completedAt,
    })
    .from(onboardingProfiles)
    .where(eq(onboardingProfiles.userId, userId))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Apply one step's answers. `name` is stored on the user row rather than the
 * profile, since it is identity rather than content strategy.
 */
export async function saveStep(
  userId: string,
  patch: OnboardingPatch,
): Promise<OnboardingProfile> {
  const { name, ...profileFields } = patch;

  await getProfile(userId);

  if (name !== undefined) {
    await db
      .update(users)
      .set({ name, updatedAt: new Date() })
      .where(eq(users.id, userId));
  }

  if (Object.keys(profileFields).length > 0) {
    // Deduplicate and sort publish days so downstream schedule maths can assume
    // a canonical shape.
    const publishDays = profileFields.publishDays
      ? [...new Set(profileFields.publishDays)].sort((a, b) => a - b)
      : undefined;
    const publishTimes = profileFields.publishTimes
      ? [...new Set(profileFields.publishTimes)].sort()
      : undefined;

    await db
      .update(onboardingProfiles)
      .set({
        ...profileFields,
        ...(publishDays ? { publishDays } : {}),
        ...(publishTimes ? { publishTimes } : {}),
        updatedAt: new Date(),
      })
      .where(eq(onboardingProfiles.userId, userId));
  }

  const updated = await load(userId);
  if (!updated) throw new Error("Onboarding profile disappeared during save");
  return updated;
}

/** Which required answers are still missing. */
export function missingFields(profile: OnboardingProfile): RequiredField[] {
  return REQUIRED_FIELDS.filter((field) => {
    const value = profile[field];
    return value === null || value === undefined || value === "";
  });
}

/**
 * Mark onboarding complete. Refuses if a required answer is missing, so the
 * dashboard is never reachable without the strategy the generators depend on.
 */
export async function complete(userId: string): Promise<void> {
  const profile = await getProfile(userId);
  const missing = missingFields(profile);
  if (missing.length > 0) {
    throw new ValidationError("Some onboarding answers are still missing.", {
      missing,
    });
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(onboardingProfiles)
      .set({ completedAt: now, updatedAt: now })
      .where(eq(onboardingProfiles.userId, userId));
    await tx
      .update(users)
      .set({ onboardedAt: now, updatedAt: now })
      .where(eq(users.id, userId));
  });

  log.info("onboarding completed", { userId });
}

/**
 * Channel-settings defaults derived from the onboarding answers. Called when a
 * channel is connected (§27: each channel gets its own copy, which the user can
 * then edit independently).
 */
export function channelDefaultsFrom(profile: OnboardingProfile) {
  return {
    niche: profile.niche,
    targetAudience: profile.targetAudience,
    contentLanguage: profile.contentLanguage,
    preferredLengthSeconds: profile.preferredLengthSeconds,
    uploadsPerWeek: profile.uploadsPerWeek,
    contentStyle: profile.contentStyle,
    voiceStyle: profile.voicePreference,
  };
}

/** Automation defaults derived from the onboarding answers. */
export function automationDefaultsFrom(profile: OnboardingProfile) {
  return {
    level: profile.automationLevel,
    publishDays: profile.publishDays,
    publishTimes: profile.publishTimes,
    timezone: profile.timezone,
    videosPerWeek: profile.uploadsPerWeek,
    // autoPublish is deliberately NOT derived here. It is a paid feature and is
    // switched on only after the plan check in the channel settings route (§23).
    autoPublish: false,
    requireApproval: profile.automationLevel !== "autopilot",
  };
}
