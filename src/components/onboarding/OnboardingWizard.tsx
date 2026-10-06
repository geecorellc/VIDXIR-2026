"use client";

/**
 * §5 onboarding wizard.
 *
 * Each step PATCHes its answers to /api/onboarding before advancing, so the
 * answers live in Postgres rather than component state — close the tab at step 4
 * and you come back to step 4 (§45).
 *
 * The final step does not ask for a YouTube password (§6). It hands off to the
 * Channels screen, where connecting a channel goes through Google OAuth.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clock,
  Globe,
  Radio,
  Sparkles,
  User,
  Youtube,
} from "lucide-react";
import { Btn } from "@/components/ui/Btn";
import { ChoiceGrid, TogglePills } from "@/components/ui/ChoiceGrid";
import { Field, SelectField, TextAreaField } from "@/components/ui/Field";
import { VidxirLogo } from "@/components/ui/VidxirLogo";
import { color, display, font, radius } from "@/lib/design/tokens";
import {
  AUTOMATION_LEVELS,
  CONTENT_STYLES,
  LANGUAGES,
  NICHES,
  ONBOARDING_STEPS,
  UPLOAD_FREQUENCIES,
  VIDEO_LENGTHS,
  VOICE_PREFERENCES,
  WEEKDAYS,
  type OnboardingPatch,
} from "@/lib/onboarding/config";
import { ApiError, api, messageOf } from "@/services/api-client";

export interface OnboardingProfileView {
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
  completedAt: Date | string | null;
}

export interface OnboardingWizardProps {
  initialName: string;
  initialProfile: OnboardingProfileView;
}

/** Resolve a stored niche to the picker value; free text falls back to "other". */
function nicheSelection(niche: string | null): string {
  if (!niche) return "";
  return NICHES.some((n) => n.value === niche) ? niche : "other";
}

/** Resolve stored seconds to the closest length preset. */
function lengthSelection(seconds: number): string {
  let best = VIDEO_LENGTHS[0]!;
  for (const option of VIDEO_LENGTHS) {
    if (
      Math.abs(option.seconds - seconds) < Math.abs(best.seconds - seconds)
    ) {
      best = option;
    }
  }
  return best.value;
}

export function OnboardingWizard({
  initialName,
  initialProfile,
}: OnboardingWizardProps) {
  const router = useRouter();

  const [step, setStep] = useState(() =>
    Math.min(initialProfile.lastStep, ONBOARDING_STEPS.length - 1),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1 — about you
  const [name, setName] = useState(initialName);

  // Step 2 — channel + niche
  const [channelUrl, setChannelUrl] = useState(
    initialProfile.declaredChannelUrl ?? "",
  );
  const [nicheChoice, setNicheChoice] = useState(
    nicheSelection(initialProfile.niche),
  );
  const [nicheOther, setNicheOther] = useState(
    nicheSelection(initialProfile.niche) === "other"
      ? (initialProfile.niche ?? "")
      : "",
  );

  // Step 3 — audience + language
  const [audience, setAudience] = useState(initialProfile.targetAudience ?? "");
  const [language, setLanguage] = useState(initialProfile.contentLanguage);

  // Step 4 — format
  const [lengthChoice, setLengthChoice] = useState(
    lengthSelection(initialProfile.preferredLengthSeconds),
  );
  const [frequency, setFrequency] = useState(
    String(initialProfile.uploadsPerWeek),
  );

  // Step 5 — voice + style
  const [contentStyle, setContentStyle] = useState(
    initialProfile.contentStyle ?? "",
  );
  const [voice, setVoice] = useState(initialProfile.voicePreference ?? "");

  // Step 6 — automation + schedule
  const [automation, setAutomation] = useState<string>(
    initialProfile.automationLevel,
  );
  const [publishDays, setPublishDays] = useState<string[]>(
    initialProfile.publishDays.map(String),
  );
  const [publishTime, setPublishTime] = useState(
    initialProfile.publishTimes[0] ?? "18:00",
  );

  const resolvedNiche =
    nicheChoice === "other" ? nicheOther.trim() : nicheChoice;

  /** The patch this step contributes, or a validation message. */
  function stepPatch(index: number): OnboardingPatch | string {
    switch (index) {
      case 0:
        if (name.trim().length < 1) return "Tell us what to call you.";
        return { name: name.trim() };
      case 1:
        if (resolvedNiche.length < 2) return "Pick a niche, or describe your own.";
        return {
          declaredChannelUrl: channelUrl.trim(),
          niche: resolvedNiche,
        };
      case 2:
        return {
          targetAudience: audience.trim(),
          contentLanguage: language,
        };
      case 3: {
        const preset = VIDEO_LENGTHS.find((l) => l.value === lengthChoice);
        if (!preset) return "Choose a target video length.";
        return {
          preferredLengthSeconds: preset.seconds,
          uploadsPerWeek: Number(frequency),
        };
      }
      case 4:
        if (!contentStyle) return "Choose a content style.";
        if (!voice) return "Choose a voice.";
        return { contentStyle, voicePreference: voice };
      case 5: {
        if (publishDays.length === 0) return "Pick at least one publishing day.";
        if (automation !== "manual" && automation !== "assisted" && automation !== "autopilot") {
          return "Choose an automation level.";
        }
        return {
          automationLevel: automation,
          publishDays: publishDays.map(Number),
          publishTimes: [publishTime],
          // Reported by the browser; used to interpret the publish times above.
          timezone:
            Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        };
      }
      default:
        return {};
    }
  }

  async function advance() {
    const patch = stepPatch(step);
    if (typeof patch === "string") {
      setError(patch);
      return;
    }

    setSaving(true);
    setError(null);
    const isLast = step === ONBOARDING_STEPS.length - 1;

    try {
      await api.patch("/api/onboarding", {
        ...patch,
        lastStep: Math.min(step + 1, ONBOARDING_STEPS.length - 1),
      });

      if (isLast) {
        await api.post("/api/onboarding");
        // Straight to Channels: the next real step is connecting YouTube.
        router.push("/dashboard/channels?connect=1");
        router.refresh();
        return;
      }
      setStep(step + 1);
    } catch (caught) {
      if (caught instanceof ApiError && Array.isArray(caught.details?.missing)) {
        setError(
          "Some answers are still missing. Step back through the questions to fill them in.",
        );
      } else {
        setError(messageOf(caught));
      }
    } finally {
      setSaving(false);
    }
  }

  function back() {
    setError(null);
    setStep((s) => Math.max(0, s - 1));
  }

  const current = ONBOARDING_STEPS[step]!;
  const isLast = step === ONBOARDING_STEPS.length - 1;

  return (
    <div
      className="vidxir-scroll"
      style={{
        minHeight: "100vh",
        padding: "44px 20px 70px",
        position: "relative",
      }}
    >
      <div className="grain" aria-hidden="true" />

      <div style={{ position: "relative", maxWidth: 640, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 30 }}>
          <VidxirLogo size={19} />
        </div>

        {/* Step rail */}
        <div
          style={{ display: "flex", gap: 6, marginBottom: 26 }}
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={ONBOARDING_STEPS.length}
          aria-valuenow={step + 1}
          aria-label={`Step ${step + 1} of ${ONBOARDING_STEPS.length}`}
        >
          {ONBOARDING_STEPS.map((s, index) => (
            <div
              key={s.id}
              style={{
                flex: 1,
                height: 3,
                borderRadius: 2,
                background:
                  index < step
                    ? color.accentDark
                    : index === step
                      ? color.accent
                      : color.borderLight,
              }}
            />
          ))}
        </div>

        <div
          style={{
            background: color.card,
            border: `1px solid ${color.border}`,
            borderRadius: radius.lg,
            padding: "26px 24px",
          }}
        >
          <div
            style={{
              fontFamily: font.display,
              fontSize: 10.5,
              letterSpacing: 1.4,
              textTransform: "uppercase",
              color: color.accent,
              marginBottom: 8,
            }}
          >
            {current.eyebrow}
          </div>
          <h1 style={{ ...display(22), marginBottom: 20 }}>{current.title}</h1>

          {error && (
            <div
              role="alert"
              style={{
                background: color.dangerBg,
                border: `1px solid ${color.dangerBorder}`,
                borderRadius: radius.md,
                padding: "10px 12px",
                fontSize: 12.5,
                lineHeight: 1.55,
                color: color.rose,
                marginBottom: 18,
              }}
            >
              {error}
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {step === 0 && (
              <>
                <Field
                  label="Your name"
                  icon={User}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Alex Rivera"
                  autoComplete="name"
                  hint="Used on your dashboard and in Vidxir AI's emails to you."
                />
                <p
                  style={{
                    margin: 0,
                    fontSize: 12.5,
                    lineHeight: 1.6,
                    color: color.textFaint,
                  }}
                >
                  You can add more channels later — each one keeps its own niche,
                  voice and schedule.
                </p>
              </>
            )}

            {step === 1 && (
              <>
                <Field
                  label="Your channel"
                  icon={Youtube}
                  value={channelUrl}
                  onChange={(e) => setChannelUrl(e.target.value)}
                  placeholder="youtube.com/@yourchannel"
                  hint="Optional for now. You'll connect it securely with Google after setup — Vidxir AI never asks for your YouTube password."
                />
                <ChoiceGrid
                  legend="Niche"
                  options={NICHES}
                  value={nicheChoice}
                  onChange={(value) => setNicheChoice(value)}
                  minWidth={168}
                />
                {nicheChoice === "other" && (
                  <Field
                    label="Describe your niche"
                    value={nicheOther}
                    onChange={(e) => setNicheOther(e.target.value)}
                    placeholder="Vintage synthesizer restoration"
                  />
                )}
              </>
            )}

            {step === 2 && (
              <>
                <TextAreaField
                  label="Target audience"
                  value={audience}
                  onChange={setAudience}
                  rows={4}
                  maxLength={1000}
                  placeholder="Solo founders in their late twenties who want to ship faster without hiring."
                  hint="The more specific this is, the better Vidxir AI's research and scripts get."
                />
                <SelectField
                  label="Content language"
                  value={language}
                  onChange={setLanguage}
                  options={LANGUAGES.map((l) => ({ value: l.value, label: l.label }))}
                  hint="Scripts, voiceover and captions are all produced in this language."
                />
              </>
            )}

            {step === 3 && (
              <>
                <ChoiceGrid
                  legend="Typical video length"
                  options={VIDEO_LENGTHS}
                  value={lengthChoice}
                  onChange={setLengthChoice}
                  minWidth={200}
                />
                <ChoiceGrid
                  legend="Upload frequency"
                  options={UPLOAD_FREQUENCIES}
                  value={frequency}
                  onChange={setFrequency}
                  minWidth={168}
                />
              </>
            )}

            {step === 4 && (
              <>
                <ChoiceGrid
                  legend="Content style"
                  options={CONTENT_STYLES}
                  value={contentStyle}
                  onChange={setContentStyle}
                  minWidth={215}
                />
                <ChoiceGrid
                  legend="Voice"
                  options={VOICE_PREFERENCES}
                  value={voice}
                  onChange={setVoice}
                  minWidth={215}
                />
              </>
            )}

            {step === 5 && (
              <>
                <ChoiceGrid
                  legend="Automation level"
                  options={AUTOMATION_LEVELS}
                  value={automation}
                  onChange={setAutomation}
                  minWidth={280}
                />
                <TogglePills
                  legend="Publishing days"
                  options={WEEKDAYS}
                  values={publishDays}
                  onChange={setPublishDays}
                />
                <Field
                  label="Publishing time"
                  icon={Clock}
                  type="time"
                  value={publishTime}
                  onChange={(e) => setPublishTime(e.target.value)}
                  hint={
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <Globe size={11} aria-hidden="true" />
                      {Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC"}
                    </span>
                  }
                />
                {automation === "autopilot" && (
                  <div
                    style={{
                      background: color.inputBg,
                      border: `1px solid ${color.border}`,
                      borderRadius: radius.md,
                      padding: "12px 13px",
                      fontSize: 12.5,
                      lineHeight: 1.6,
                      color: color.textDim,
                    }}
                  >
                    <strong style={{ color: color.textBright }}>
                      Auto-publishing is a Studio feature.
                    </strong>{" "}
                    Vidxir AI will build every video on this schedule; publishing
                    without approval unlocks when you upgrade, and you can turn it
                    on per channel.
                  </div>
                )}
              </>
            )}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginTop: 26,
            }}
          >
            {step > 0 ? (
              <Btn variant="ghost" onClick={back} icon={<ArrowLeft size={15} />}>
                Back
              </Btn>
            ) : (
              <span />
            )}
            <Btn
              onClick={advance}
              loading={saving}
              icon={isLast ? <Check size={15} /> : <ArrowRight size={15} />}
            >
              {isLast ? "Finish setup" : "Continue"}
            </Btn>
          </div>
        </div>

        <p
          style={{
            margin: "18px 0 0",
            textAlign: "center",
            fontSize: 12,
            color: color.textFaint,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
          }}
        >
          <Sparkles size={12} aria-hidden="true" />
          Answers save as you go — you can change any of this later in settings.
        </p>

        <p
          style={{
            margin: "10px 0 0",
            textAlign: "center",
            fontSize: 11.5,
            color: color.textFaint,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
          }}
        >
          <Radio size={11} aria-hidden="true" />
          Step {step + 1} of {ONBOARDING_STEPS.length}
        </p>
      </div>
    </div>
  );
}
