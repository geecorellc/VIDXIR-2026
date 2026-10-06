/**
 * Settings — per-channel strategy, brand kit and automation.
 *
 * New screen (the prototype had none), so it takes its structure from the
 * prototype's stage pages: section eyebrow, one card per concern, red accents.
 *
 * Everything is scoped to one channel at a time. `?channel=` selects it; without
 * that parameter the most recently connected channel is used, matching how the
 * stage screens pick the active project.
 */
import { redirect } from "next/navigation";
import { SettingsForm, type SettingsChannelOption } from "@/components/settings/SettingsForm";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { getSession } from "@/lib/auth/session";
import { currentTier } from "@/lib/api/guard";
import { listChannelSummaries } from "@/lib/dashboard/stage";
import { hasFeature } from "@/lib/plans/enforce";
import { planByTier } from "@/lib/plans";
import { getChannelConfig, type ChannelConfig } from "@/lib/settings/service";
import { logger } from "@/lib/logger";

export const metadata = { title: "Settings — Vidxir AI" };

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ channel?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login?next=%2Fdashboard%2Fsettings");
  const user = session.user;

  const params = await searchParams;
  const [connected, tier] = await Promise.all([
    listChannelSummaries(user.id),
    currentTier(user.id),
  ]);

  // Only ids from the user's own channel list are honoured, so `?channel=` cannot
  // be used to probe for another tenant's channel (§34).
  const requested = params.channel
    ? connected.find((c) => c.id === params.channel)
    : undefined;
  const selected = requested ?? connected[0] ?? null;

  let config: ChannelConfig | null = null;
  if (selected) {
    try {
      config = await getChannelConfig(user.id, selected.id);
    } catch (error) {
      logger
        .child({ component: "settings-page", userId: user.id })
        .error("load_channel_config_failed", { channelId: selected.id, error });
    }
  }

  const options: SettingsChannelOption[] = connected.map((channel) => ({
    id: channel.id,
    title: channel.title,
    handle: channel.handle,
    needsReauth: channel.reauthRequiredAt !== null,
  }));

  return (
    <div>
      <SectionHeader
        eyebrow="Settings"
        title="Tune the studio"
        sub="Strategy, brand and schedule — set once per channel, applied to every video."
      />
      <SettingsForm
        accountName={user.name}
        accountEmail={user.email}
        channels={options}
        config={config}
        selectedChannelId={selected?.id ?? null}
        schedulingAvailable={hasFeature(tier, "scheduling")}
        autoPublishAvailable={hasFeature(tier, "autoPublish")}
        voiceoverAvailable={hasFeature(tier, "aiVoiceover")}
        planName={planByTier(tier).name}
      />
    </div>
  );
}
