"use client";

/**
 * Settings — per-channel strategy, brand kit and automation (§5, §27, §28, §18).
 *
 * The prototype had no settings screen; its equivalent values were the hard-coded
 * strings inside each tab. This screen is new work, so it follows the prototype's
 * visual language rather than inventing one: uppercase Oswald section eyebrows,
 * #141216 cards with a #241F22 border, red active states, and the same field and
 * choice-card components onboarding already uses.
 *
 * The one structural rule worth naming: there is a channel *switcher*, and every
 * section below it edits only the selected channel. Nothing here is account-wide
 * except the name field, because §27 requires that editing one channel never
 * changes another.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import {
  Bot,
  Brush,
  Check,
  ChevronRight,
  Radio,
  Save,
  Target,
  User as UserIcon,
} from "lucide-react";
import { Btn } from "@/components/ui/Btn";
import { Card } from "@/components/ui/Card";
import { ChoiceGrid, TogglePills } from "@/components/ui/ChoiceGrid";
import { Field, SelectField, TextAreaField } from "@/components/ui/Field";
import { EmptyCTA } from "@/components/ui/SectionHeader";
import { color, eyebrow, font, radius } from "@/lib/design/tokens";
import {
  AUTOMATION_LEVELS,
  CONTENT_STYLES,
  LANGUAGES,
  UPLOAD_FREQUENCIES,
  VIDEO_LENGTHS,
  VOICE_PREFERENCES,
  WEEKDAYS,
} from "@/lib/onboarding/config";
import {
  CAPTION_STYLES,
  THUMBNAIL_STYLES,
  VIDEO_STYLES,
} from "@/lib/settings/config";
import type { ChannelConfig } from "@/lib/settings/service";
import { api, messageOf } from "@/services/api-client";

export interface SettingsChannelOption {
  id: string;
  title: string;
  handle: string | null;
  needsReauth: boolean;
}

export interface SettingsFormProps {
  accountName: string | null;
  accountEmail: string;
  channels: SettingsChannelOption[];
  /** Configuration for the channel currently selected via `?channel=`. */
  config: ChannelConfig | null;
  selectedChannelId: string | null;
  /** Plan gates, resolved server-side from the subscriptions row (§24). */
  schedulingAvailable: boolean;
  autoPublishAvailable: boolean;
  planName: string;
  /** Whether AI voiceover is in the plan — the voice controls say so if not. */
  voiceoverAvailable: boolean;
}

type Section = "account" | "strategy" | "brand" | "automation";

export function SettingsForm({
  accountName,
  accountEmail,
  channels,
  config,
  selectedChannelId,
  schedulingAvailable,
  autoPublishAvailable,
  planName,
  voiceoverAvailable,
}: SettingsFormProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [saving, setSaving] = useState<Section | null>(null);
  const [saved, setSaved] = useState<Section | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Account
  const [name, setName] = useState(accountName ?? "");

  // Strategy
  const [niche, setNiche] = useState(config?.settings.niche ?? "");
  const [audience, setAudience] = useState(config?.settings.targetAudience ?? "");
  const [language, setLanguage] = useState(
    config?.settings.contentLanguage ?? "en-US",
  );
  const [length, setLength] = useState(
    String(config?.settings.preferredLengthSeconds ?? 480),
  );
  const [uploads, setUploads] = useState(String(config?.settings.uploadsPerWeek ?? 1));
  const [contentStyle, setContentStyle] = useState(
    config?.settings.contentStyle ?? "explainer",
  );
  const [videoStyle, setVideoStyle] = useState(
    config?.settings.videoStyle ?? "broll-narration",
  );
  const [keywords, setKeywords] = useState(
    (config?.settings.keywords ?? []).join(", "),
  );
  const [competitors, setCompetitors] = useState(
    (config?.settings.competitorChannelIds ?? []).join("\n"),
  );

  // Brand kit
  const [brandName, setBrandName] = useState(config?.brand.brandName ?? "");
  const [primary, setPrimary] = useState(config?.brand.primaryColor ?? "#E8332B");
  const [secondary, setSecondary] = useState(
    config?.brand.secondaryColor ?? "#0B0A0C",
  );
  const [fontPreference, setFontPreference] = useState(
    config?.brand.fontPreference ?? "",
  );
  const [cta, setCta] = useState(config?.brand.defaultCta ?? "");
  const [captionStyle, setCaptionStyle] = useState(
    config?.brand.captionStyle ?? "word-pop",
  );
  const [thumbnailStyle, setThumbnailStyle] = useState(
    config?.settings.thumbnailStyle ?? "bold-text",
  );
  const [voiceStyle, setVoiceStyle] = useState(
    config?.settings.voiceStyle ?? "warm-female",
  );

  // Automation
  const [automationEnabled, setAutomationEnabled] = useState(
    config?.automation.enabled ?? false,
  );
  const [level, setLevel] = useState(config?.automation.level ?? "manual");
  const [publishDays, setPublishDays] = useState(
    (config?.automation.publishDays ?? [1, 3, 5]).map(String),
  );
  const [publishTime, setPublishTime] = useState(
    config?.automation.publishTimes[0] ?? "18:00",
  );
  const [videosPerWeek, setVideosPerWeek] = useState(
    String(config?.automation.videosPerWeek ?? 3),
  );
  const [autoPublish, setAutoPublish] = useState(
    config?.automation.autoPublish ?? false,
  );

  /** One save helper for all four sections, so the feedback pattern is identical. */
  async function save(section: Section, run: () => Promise<unknown>) {
    setError(null);
    setSaved(null);
    setSaving(section);
    try {
      await run();
      setSaved(section);
      startTransition(() => router.refresh());
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSaving(null);
    }
  }

  const settingsPath = selectedChannelId
    ? `/api/channels/${selectedChannelId}/settings`
    : null;

  function saveAccount() {
    void save("account", () => api.patch("/api/account", { name: name.trim() }));
  }

  function saveStrategy() {
    if (!settingsPath) return;
    void save("strategy", () =>
      api.patch(settingsPath, {
        settings: {
          ...(niche.trim() ? { niche: niche.trim() } : {}),
          targetAudience: audience.trim(),
          contentLanguage: language,
          preferredLengthSeconds: Number(length),
          uploadsPerWeek: Number(uploads),
          contentStyle,
          videoStyle,
          keywords: splitList(keywords),
          competitorChannelIds: splitList(competitors),
        },
      }),
    );
  }

  function saveBrand() {
    if (!settingsPath) return;
    void save("brand", () =>
      api.patch(settingsPath, {
        brand: {
          brandName: brandName.trim(),
          primaryColor: primary,
          secondaryColor: secondary,
          fontPreference: fontPreference.trim(),
          defaultCta: cta.trim(),
          captionStyle,
        },
        settings: { thumbnailStyle, voiceStyle },
      }),
    );
  }

  function saveAutomation() {
    if (!settingsPath) return;
    void save("automation", () =>
      api.patch(settingsPath, {
        automation: {
          enabled: automationEnabled,
          level,
          publishDays: publishDays.map(Number),
          publishTimes: [publishTime],
          timezone:
            config?.automation.timezone ??
            Intl.DateTimeFormat().resolvedOptions().timeZone ??
            "UTC",
          videosPerWeek: Number(videosPerWeek),
          autoPublish,
          // Autopilot is the only level that does not stop for approval, and
          // approval is still required whenever auto-publish is off.
          requireApproval: !autoPublish || level !== "autopilot",
        },
      }),
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {error && (
        <Card tone="warning" pad={14}>
          <p style={{ margin: 0, fontSize: 13, color: color.warning, lineHeight: 1.6 }}>
            {error}
          </p>
        </Card>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Account                                                           */}
      {/* ---------------------------------------------------------------- */}
      <Card>
        <SectionTitle icon={<UserIcon size={14} />} label="Account" />
        <div style={{ display: "grid", gap: 14, maxWidth: 460 }}>
          <Field
            label="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            autoComplete="name"
          />
          <Field
            label="Email"
            value={accountEmail}
            readOnly
            hint="Changing your email re-runs verification, so it has its own flow."
          />
        </div>
        <SaveRow
          onClick={saveAccount}
          loading={saving === "account"}
          saved={saved === "account"}
          disabled={name.trim().length === 0}
        />
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* Channel switcher                                                  */}
      {/* ---------------------------------------------------------------- */}
      {channels.length === 0 ? (
        <EmptyCTA
          icon={<Radio size={22} />}
          title="No channel connected"
          body="Strategy, brand kit and automation are configured per channel. Connect a YouTube channel and its settings appear here."
          action={
            <Btn onClick={() => router.push("/dashboard/channels")}>
              Go to channels <ChevronRight size={15} />
            </Btn>
          }
        />
      ) : (
        <>
          {channels.length > 1 && (
            <Card pad={16}>
              <div style={{ ...eyebrow, marginBottom: 10 }}>Editing channel</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {channels.map((channel) => {
                  const active = channel.id === selectedChannelId;
                  return (
                    <button
                      key={channel.id}
                      type="button"
                      onClick={() =>
                        router.push(`/dashboard/settings?channel=${channel.id}`)
                      }
                      aria-current={active ? "true" : undefined}
                      style={{
                        all: "unset",
                        cursor: "pointer",
                        padding: "8px 13px",
                        borderRadius: radius.pill,
                        fontSize: 12.5,
                        fontWeight: 600,
                        fontFamily: font.body,
                        color: active ? color.text : color.textDim,
                        background: active ? color.accentBgSoft : color.inputBg,
                        border: `1px solid ${active ? color.accent : color.border}`,
                      }}
                    >
                      {channel.title}
                    </button>
                  );
                })}
              </div>
              <p
                style={{
                  margin: "12px 0 0",
                  fontSize: 12,
                  lineHeight: 1.6,
                  color: color.textFaint,
                }}
              >
                Each channel keeps its own strategy, brand kit and schedule. Editing
                one never changes another.
              </p>
            </Card>
          )}

          {config === null ? (
            <Card tone="warning" pad={16}>
              <p style={{ margin: 0, fontSize: 13, color: color.warning, lineHeight: 1.6 }}>
                That channel could not be loaded. Pick one from the list above.
              </p>
            </Card>
          ) : (
            <>
              {/* ------------------------------------------------------ */}
              {/* Strategy                                                */}
              {/* ------------------------------------------------------ */}
              <Card>
                <SectionTitle icon={<Target size={14} />} label="Content strategy" />
                <div style={{ display: "grid", gap: 16 }}>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                      gap: 14,
                    }}
                  >
                    <Field
                      label="Niche"
                      value={niche}
                      onChange={(e) => setNiche(e.target.value)}
                      maxLength={160}
                      placeholder="AI & technology"
                      hint="Research and scripts are generated for this niche."
                    />
                    <SelectField
                      label="Language"
                      value={language}
                      onChange={setLanguage}
                      options={LANGUAGES.map((l) => ({ value: l.value, label: l.label }))}
                    />
                    <SelectField
                      label="Target length"
                      value={length}
                      onChange={setLength}
                      options={VIDEO_LENGTHS.map((l) => ({
                        value: String(l.seconds),
                        label: l.label,
                      }))}
                    />
                    <SelectField
                      label="Uploads per week"
                      value={uploads}
                      onChange={setUploads}
                      options={UPLOAD_FREQUENCIES.map((f) => ({
                        value: f.value,
                        label: f.label,
                      }))}
                    />
                  </div>

                  <TextAreaField
                    label="Who it's for"
                    value={audience}
                    onChange={setAudience}
                    rows={3}
                    maxLength={1000}
                    placeholder="Founders and operators who want to automate the boring half of their work."
                  />

                  <ChoiceGrid
                    legend="Script style"
                    options={CONTENT_STYLES}
                    value={contentStyle}
                    onChange={setContentStyle}
                  />

                  <ChoiceGrid
                    legend="Video style"
                    options={VIDEO_STYLES}
                    value={videoStyle}
                    onChange={setVideoStyle}
                  />

                  <TextAreaField
                    label="Research keywords"
                    value={keywords}
                    onChange={setKeywords}
                    rows={2}
                    placeholder="ai agents, automation, solo business"
                    hint="Comma separated. These seed the research engine's search demand signals."
                  />

                  <TextAreaField
                    label="Competitor channels"
                    value={competitors}
                    onChange={setCompetitors}
                    rows={3}
                    placeholder={"UCxxxxxxxxxxxxxxxxxxxxxx\nUCyyyyyyyyyyyyyyyyyyyyyy"}
                    hint="One YouTube channel id per line (the UC… id, not the handle). Vidxir AI tracks what breaks out on these channels."
                  />
                </div>
                <SaveRow
                  onClick={saveStrategy}
                  loading={saving === "strategy"}
                  saved={saved === "strategy"}
                />
              </Card>

              {/* ------------------------------------------------------ */}
              {/* Brand kit                                               */}
              {/* ------------------------------------------------------ */}
              <Card>
                <SectionTitle icon={<Brush size={14} />} label="Brand kit" />
                <p
                  style={{
                    margin: "0 0 16px",
                    fontSize: 12.5,
                    lineHeight: 1.6,
                    color: color.textDim,
                  }}
                >
                  Applied by the video builder, the thumbnail designer and the caption
                  burn-in, so every video for this channel looks like the same channel.
                </p>

                <div style={{ display: "grid", gap: 16 }}>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                      gap: 14,
                    }}
                  >
                    <Field
                      label="Brand name"
                      value={brandName}
                      onChange={(e) => setBrandName(e.target.value)}
                      maxLength={120}
                      placeholder="Nightline AI"
                    />
                    <Field
                      label="Display font"
                      value={fontPreference}
                      onChange={(e) => setFontPreference(e.target.value)}
                      maxLength={80}
                      placeholder="Oswald"
                    />
                    <ColorField
                      label="Primary colour"
                      value={primary}
                      onChange={setPrimary}
                    />
                    <ColorField
                      label="Secondary colour"
                      value={secondary}
                      onChange={setSecondary}
                    />
                  </div>

                  <TextAreaField
                    label="Default call to action"
                    value={cta}
                    onChange={setCta}
                    rows={2}
                    maxLength={500}
                    placeholder="If this was useful, subscribe — one video like this every week."
                  />

                  <ChoiceGrid
                    legend="Thumbnail direction"
                    options={THUMBNAIL_STYLES}
                    value={thumbnailStyle}
                    onChange={setThumbnailStyle}
                  />

                  <ChoiceGrid
                    legend="Captions"
                    options={CAPTION_STYLES}
                    value={captionStyle}
                    onChange={setCaptionStyle}
                  />

                  <div>
                    <ChoiceGrid
                      legend="Voice"
                      options={VOICE_PREFERENCES}
                      value={voiceStyle}
                      onChange={setVoiceStyle}
                    />
                    {!voiceoverAvailable && (
                      <p
                        style={{
                          margin: "10px 0 0",
                          fontSize: 11.5,
                          lineHeight: 1.55,
                          color: color.textFaint,
                        }}
                      >
                        AI voiceover is part of the Studio plan. On {planName} this
                        preference is saved but no voiceover is generated.
                      </p>
                    )}
                  </div>
                </div>

                <SaveRow
                  onClick={saveBrand}
                  loading={saving === "brand"}
                  saved={saved === "brand"}
                />
              </Card>

              {/* ------------------------------------------------------ */}
              {/* Automation                                              */}
              {/* ------------------------------------------------------ */}
              <Card>
                <SectionTitle icon={<Bot size={14} />} label="Automation & schedule" />

                <div style={{ display: "grid", gap: 16 }}>
                  <ChoiceGrid
                    legend="How hands-off"
                    options={AUTOMATION_LEVELS}
                    value={level}
                    onChange={(v) =>
                      setLevel(v as "manual" | "assisted" | "autopilot")
                    }
                    minWidth={240}
                  />

                  <Toggle
                    label="Run this channel on a schedule"
                    description={
                      schedulingAvailable
                        ? "Vidxir AI's scheduler starts videos for you. It runs on the server, so nothing depends on this browser being open."
                        : `Scheduling is part of the Studio plan. On ${planName} you can start each video yourself from Research.`
                    }
                    checked={automationEnabled}
                    onChange={setAutomationEnabled}
                    disabled={!schedulingAvailable}
                  />

                  <TogglePills
                    legend="Publish days"
                    options={WEEKDAYS}
                    values={publishDays}
                    onChange={setPublishDays}
                  />

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                      gap: 14,
                    }}
                  >
                    <Field
                      label="Publish time"
                      type="time"
                      value={publishTime}
                      onChange={(e) => setPublishTime(e.target.value)}
                      hint={`Interpreted in ${config.automation.timezone}.`}
                    />
                    <SelectField
                      label="Videos per week"
                      value={videosPerWeek}
                      onChange={setVideosPerWeek}
                      options={UPLOAD_FREQUENCIES.map((f) => ({
                        value: f.value,
                        label: f.label,
                      }))}
                    />
                  </div>

                  <Toggle
                    label="Publish to YouTube without asking me"
                    description={
                      autoPublishAvailable
                        ? "When off, a finished video waits in Publish for your approval. When on, Vidxir AI uploads it at the scheduled time."
                        : `Auto-publish is part of the Studio plan. On ${planName} every video waits for your approval.`
                    }
                    checked={autoPublish}
                    onChange={setAutoPublish}
                    disabled={!autoPublishAvailable}
                  />
                </div>

                {config.automation.nextRunAt && automationEnabled && (
                  <p
                    style={{
                      margin: "16px 0 0",
                      fontSize: 12,
                      color: color.textFaint,
                    }}
                  >
                    Next scheduled run{" "}
                    {config.automation.nextRunAt.toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                    .
                  </p>
                )}

                <SaveRow
                  onClick={saveAutomation}
                  loading={saving === "automation"}
                  saved={saved === "automation"}
                  disabled={publishDays.length === 0}
                />
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local pieces
// ---------------------------------------------------------------------------

function SectionTitle({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 16,
        color: color.accent,
      }}
    >
      <span aria-hidden="true" style={{ display: "flex" }}>
        {icon}
      </span>
      <span style={{ ...eyebrow, color: color.accent, marginBottom: 0 }}>{label}</span>
    </div>
  );
}

function SaveRow({
  onClick,
  loading,
  saved,
  disabled,
}: {
  onClick: () => void;
  loading: boolean;
  saved: boolean;
  disabled?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        marginTop: 18,
        flexWrap: "wrap",
      }}
    >
      <Btn onClick={onClick} loading={loading} disabled={disabled} icon={<Save size={14} />}>
        Save
      </Btn>
      {/* Confirmation appears only after the server accepted the write. */}
      {saved && !loading && (
        <span
          role="status"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12.5,
            color: color.positive,
          }}
        >
          <Check size={13} aria-hidden="true" /> Saved
        </span>
      )}
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <span style={eyebrow}>{label}</span>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: color.inputBg,
          border: `1px solid ${color.border}`,
          borderRadius: radius.md,
          padding: "8px 12px",
        }}
      >
        <input
          type="color"
          value={normaliseHex(value)}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          style={{
            width: 26,
            height: 26,
            padding: 0,
            border: "none",
            borderRadius: radius.sm,
            background: "transparent",
            cursor: "pointer",
          }}
        />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={9}
          aria-label={`${label} hex value`}
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            color: color.text,
            fontFamily: font.mono,
            fontSize: 13,
            minWidth: 0,
          }}
        />
      </div>
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        background: color.inputBg,
        border: `1px solid ${checked && !disabled ? color.accent : color.border}`,
        borderRadius: radius.md,
        padding: "13px 14px",
      }}
    >
      <input
        type="checkbox"
        checked={checked && !disabled}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{
          appearance: "none",
          width: 16,
          height: 16,
          flexShrink: 0,
          marginTop: 2,
          borderRadius: radius.sm,
          border: `2px solid ${checked && !disabled ? color.accent : "#3A3336"}`,
          background: checked && !disabled ? color.accent : "transparent",
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      />
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 13.5,
            fontWeight: 600,
            color: color.textBright,
            lineHeight: 1.35,
          }}
        >
          {label}
        </span>
        <span
          style={{
            display: "block",
            marginTop: 5,
            fontSize: 12,
            lineHeight: 1.55,
            color: color.textDim,
          }}
        >
          {description}
        </span>
      </span>
    </label>
  );
}

/** Split a comma- or newline-separated textarea into trimmed, non-empty values. */
function splitList(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** `<input type="color">` only accepts #rrggbb, so widen shorthand and trim alpha. */
function normaliseHex(value: string): string {
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})/.exec(value.trim());
  if (!match) return "#000000";
  const hex = match[1]!;
  if (hex.length === 6) return `#${hex}`;
  return `#${hex
    .split("")
    .map((c) => c + c)
    .join("")}`;
}
