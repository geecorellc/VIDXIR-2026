/**
 * Channel settings, brand kit and automation persistence (§27, §28, §18).
 *
 * Three rules hold throughout:
 *
 *  1. Every read and write carries `userId` in its predicate. `requireChannelAccess`
 *     has already proven ownership, but the predicate stays anyway — tenant
 *     isolation is a property of the query, not of an earlier check (§34).
 *  2. Rows are created lazily on first read, so a channel connected before these
 *     tables existed still resolves to complete settings.
 *  3. Paid switches (`autoPublish`, scheduling) are never persisted from a request
 *     body alone. The caller passes the tier read from `subscriptions`, and this
 *     module refuses the write if the plan does not include the feature (§24).
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  automationSettings,
  brandKits,
  channelSettings,
} from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { hasFeature } from "@/lib/plans/enforce";
import { FeatureNotInPlanError } from "@/lib/errors";
import { planByTier, type PlanTier } from "@/lib/plans";
import {
  channelDefaultsFrom,
  automationDefaultsFrom,
  getProfile,
} from "@/lib/onboarding/service";
import type {
  AutomationPatch,
  BrandKitPatch,
  ChannelSettingsPatch,
} from "@/lib/settings/config";

const log = logger.child({ component: "settings" });

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface ChannelSettingsView {
  niche: string | null;
  targetAudience: string | null;
  contentLanguage: string;
  preferredLengthSeconds: number;
  uploadsPerWeek: number;
  contentStyle: string | null;
  videoStyle: string | null;
  thumbnailStyle: string | null;
  voiceProviderVoiceId: string | null;
  voiceStyle: string | null;
  voiceSpeed: number;
  competitorChannelIds: string[];
  keywords: string[];
  updatedAt: Date;
}

export interface BrandKitView {
  brandName: string | null;
  logoAssetId: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  fontPreference: string | null;
  introAssetId: string | null;
  outroAssetId: string | null;
  defaultCta: string | null;
  /** Stored as jsonb; the UI edits a single named preset. */
  captionStyle: string | null;
  updatedAt: Date;
}

export interface AutomationView {
  enabled: boolean;
  level: "manual" | "assisted" | "autopilot";
  publishDays: number[];
  publishTimes: string[];
  timezone: string;
  videosPerWeek: number;
  autoPublish: boolean;
  requireApproval: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  updatedAt: Date;
}

export interface ChannelConfig {
  channelId: string;
  settings: ChannelSettingsView;
  brand: BrandKitView;
  automation: AutomationView;
}

// ---------------------------------------------------------------------------
// Reads (creating defaults on first access)
// ---------------------------------------------------------------------------

/**
 * Load a channel's full configuration, seeding any missing row from the user's
 * onboarding answers.
 *
 * Seeding happens here rather than only at connect time so the settings screen
 * cannot render blank fields for a channel that predates a schema addition.
 */
export async function getChannelConfig(
  userId: string,
  channelId: string,
): Promise<ChannelConfig> {
  const [settings, brand, automation] = await Promise.all([
    loadSettings(userId, channelId),
    loadBrand(userId, channelId),
    loadAutomation(userId, channelId),
  ]);

  if (settings && brand && automation) {
    return { channelId, settings, brand, automation };
  }

  await ensureRows(userId, channelId, {
    settings: settings === null,
    brand: brand === null,
    automation: automation === null,
  });

  const [freshSettings, freshBrand, freshAutomation] = await Promise.all([
    loadSettings(userId, channelId),
    loadBrand(userId, channelId),
    loadAutomation(userId, channelId),
  ]);

  if (!freshSettings || !freshBrand || !freshAutomation) {
    // The inserts either succeeded or conflicted with a concurrent insert; a
    // missing row at this point means the write path is broken.
    throw new Error(`Failed to initialise settings for channel ${channelId}`);
  }

  return {
    channelId,
    settings: freshSettings,
    brand: freshBrand,
    automation: freshAutomation,
  };
}

/**
 * Create the three per-channel rows for a newly connected channel (§27).
 *
 * Called from the OAuth callback. Uses `onConflictDoNothing` so reconnecting an
 * existing channel never overwrites settings the user has since edited.
 */
export async function initialiseChannelConfig(
  userId: string,
  channelId: string,
): Promise<void> {
  await ensureRows(userId, channelId, {
    settings: true,
    brand: true,
    automation: true,
  });
}

async function ensureRows(
  userId: string,
  channelId: string,
  which: { settings: boolean; brand: boolean; automation: boolean },
): Promise<void> {
  const profile = await getProfile(userId);

  if (which.settings) {
    const defaults = channelDefaultsFrom(profile);
    await db
      .insert(channelSettings)
      .values({ channelId, userId, ...defaults })
      .onConflictDoNothing();
  }

  if (which.brand) {
    await db.insert(brandKits).values({ channelId, userId }).onConflictDoNothing();
  }

  if (which.automation) {
    const defaults = automationDefaultsFrom(profile);
    await db
      .insert(automationSettings)
      .values({ channelId, userId, ...defaults })
      .onConflictDoNothing();
  }

  log.info("channel config initialised", { userId, channelId, ...which });
}

async function loadSettings(
  userId: string,
  channelId: string,
): Promise<ChannelSettingsView | null> {
  const rows = await db
    .select({
      niche: channelSettings.niche,
      targetAudience: channelSettings.targetAudience,
      contentLanguage: channelSettings.contentLanguage,
      preferredLengthSeconds: channelSettings.preferredLengthSeconds,
      uploadsPerWeek: channelSettings.uploadsPerWeek,
      contentStyle: channelSettings.contentStyle,
      videoStyle: channelSettings.videoStyle,
      thumbnailStyle: channelSettings.thumbnailStyle,
      voiceProviderVoiceId: channelSettings.voiceProviderVoiceId,
      voiceStyle: channelSettings.voiceStyle,
      voiceSpeed: channelSettings.voiceSpeed,
      competitorChannelIds: channelSettings.competitorChannelIds,
      keywords: channelSettings.keywords,
      updatedAt: channelSettings.updatedAt,
    })
    .from(channelSettings)
    .where(
      and(
        eq(channelSettings.channelId, channelId),
        eq(channelSettings.userId, userId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

async function loadBrand(
  userId: string,
  channelId: string,
): Promise<BrandKitView | null> {
  const rows = await db
    .select({
      brandName: brandKits.brandName,
      logoAssetId: brandKits.logoAssetId,
      primaryColor: brandKits.primaryColor,
      secondaryColor: brandKits.secondaryColor,
      fontPreference: brandKits.fontPreference,
      introAssetId: brandKits.introAssetId,
      outroAssetId: brandKits.outroAssetId,
      defaultCta: brandKits.defaultCta,
      captionStyle: brandKits.captionStyle,
      updatedAt: brandKits.updatedAt,
    })
    .from(brandKits)
    .where(and(eq(brandKits.channelId, channelId), eq(brandKits.userId, userId)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const preset = row.captionStyle?.["preset"];
  return {
    ...row,
    captionStyle: typeof preset === "string" ? preset : null,
  };
}

async function loadAutomation(
  userId: string,
  channelId: string,
): Promise<AutomationView | null> {
  const rows = await db
    .select({
      enabled: automationSettings.enabled,
      level: automationSettings.level,
      publishDays: automationSettings.publishDays,
      publishTimes: automationSettings.publishTimes,
      timezone: automationSettings.timezone,
      videosPerWeek: automationSettings.videosPerWeek,
      autoPublish: automationSettings.autoPublish,
      requireApproval: automationSettings.requireApproval,
      lastRunAt: automationSettings.lastRunAt,
      nextRunAt: automationSettings.nextRunAt,
      updatedAt: automationSettings.updatedAt,
    })
    .from(automationSettings)
    .where(
      and(
        eq(automationSettings.channelId, channelId),
        eq(automationSettings.userId, userId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function updateChannelSettings(
  userId: string,
  channelId: string,
  patch: ChannelSettingsPatch,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await getChannelConfig(userId, channelId);

  const competitorChannelIds = patch.competitorChannelIds
    ? [...new Set(patch.competitorChannelIds)]
    : undefined;
  const keywords = patch.keywords
    ? [...new Set(patch.keywords.map((k) => k.toLowerCase()))]
    : undefined;

  await db
    .update(channelSettings)
    .set({
      ...patch,
      ...(competitorChannelIds ? { competitorChannelIds } : {}),
      ...(keywords ? { keywords } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(channelSettings.channelId, channelId),
        eq(channelSettings.userId, userId),
      ),
    );

  log.info("channel settings updated", {
    userId,
    channelId,
    fields: Object.keys(patch),
  });
}

export async function updateBrandKit(
  userId: string,
  channelId: string,
  patch: BrandKitPatch,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await getChannelConfig(userId, channelId);

  const { captionStyle, ...rest } = patch;

  await db
    .update(brandKits)
    .set({
      ...rest,
      // Stored as jsonb so the render step can grow the shape (font size, safe
      // margins) without another migration.
      ...(captionStyle !== undefined ? { captionStyle: { preset: captionStyle } } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(brandKits.channelId, channelId), eq(brandKits.userId, userId)));

  log.info("brand kit updated", { userId, channelId, fields: Object.keys(patch) });
}

/**
 * Update the automation rules for a channel.
 *
 * The tier argument must come from `currentTier()`. Turning on auto-publish or a
 * schedule requires the plan's feature flags, and refusing here — rather than at
 * publish time — means the user is told immediately instead of discovering it
 * when a video silently fails to go out (§24, §30).
 */
export async function updateAutomation(
  userId: string,
  channelId: string,
  tier: PlanTier,
  patch: AutomationPatch,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await getChannelConfig(userId, channelId);

  const plan = planByTier(tier);

  if (patch.autoPublish === true && !hasFeature(tier, "autoPublish")) {
    throw new FeatureNotInPlanError("autoPublish", plan.name);
  }
  // "enabled" means the scheduler may act on this channel unattended, which is
  // the scheduling feature regardless of whether publishing is automatic.
  if (patch.enabled === true && !hasFeature(tier, "scheduling")) {
    throw new FeatureNotInPlanError("scheduling", plan.name);
  }

  const publishDays = patch.publishDays
    ? [...new Set(patch.publishDays)].sort((a, b) => a - b)
    : undefined;
  const publishTimes = patch.publishTimes
    ? [...new Set(patch.publishTimes)].sort()
    : undefined;

  await db
    .update(automationSettings)
    .set({
      ...patch,
      ...(publishDays ? { publishDays } : {}),
      ...(publishTimes ? { publishTimes } : {}),
      // Changing the cadence invalidates the previously computed run time; the
      // scheduler recomputes it on its next tick (§19).
      nextRunAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(automationSettings.channelId, channelId),
        eq(automationSettings.userId, userId),
      ),
    );

  log.info("automation updated", {
    userId,
    channelId,
    fields: Object.keys(patch),
    tier,
  });
}
