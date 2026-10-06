/**
 * Make one real, minimal call to each configured provider (§48, §42).
 *
 * The unit tests cover every adapter against recorded response shapes, which
 * proves the parsing and the error taxonomy. They cannot prove that a key works,
 * that an account has the entitlement, that a model id still exists, or that a
 * response shape has not drifted since the fixture was recorded. Those failures
 * only appear against the live service, and the honest place to discover them is
 * here rather than in a user's first render.
 *
 *   npx tsx scripts/verify-providers.ts            # every configured provider
 *   npx tsx scripts/verify-providers.ts voice      # substring match on one
 *
 * Deliberately cheap: one short sentence of narration, one two-second clip to
 * transcribe, one search page. Cents, not dollars. It reads `.env.local` exactly
 * as the app does, so a pass means the app's own configuration works rather than
 * a separate set of variables that happen to be right.
 *
 * `VIDXIR_USE_MOCK_PROVIDERS=true` is overridden for this run only, in-process. A
 * verification that exercised the mocks would report success while proving
 * nothing, which is the specific dishonesty §42 prohibits. The per-provider
 * selectors are left alone: `VOICE_PROVIDER=mock` is a real answer, and the
 * honest report is "not configured", not a silent upgrade to a paid provider.
 *
 * Needs DATABASE_URL, because every provider call records an `api_usage` row and
 * that accounting is part of what is being verified (§41).
 */
import "@/lib/load-env";

process.env["VIDXIR_USE_MOCK_PROVIDERS"] = "false";

interface Check {
  name: string;
  /** The env vars an operator would set to enable this. */
  vars: readonly string[];
  /** Null when the provider is switched off rather than misconfigured. */
  run: () => Promise<{ detail: string } | null>;
}

/** Usage rows need a context; this one is clearly not a user's work. */
const USAGE = {
  userId: null,
  projectId: null,
  jobId: null,
  traceId: "verify-providers",
} as const;

const CHECKS: readonly Check[] = [
  {
    name: "Claude (scripts, research, metadata)",
    // Either transport satisfies this: AI_PROVIDER decides which of the two
    // credential sets is the relevant one (§32).
    vars: ["AI_PROVIDER", "ANTHROPIC_API_KEY", "BEDROCK_REGION"],
    async run() {
      const {
        isAiConfigured,
        generateJson,
        jsonSchema,
        aiProviderName,
        aiModelName,
      } = await import("@/lib/providers/ai");
      if (!isAiConfigured()) return null;

      const { z } = await import("zod");
      const result = await generateJson({
        system: "You reply with JSON only.",
        prompt: 'Reply with {"ok":true}.',
        schema: z.object({ ok: z.boolean() }),
        jsonSchema: jsonSchema({
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        }),
        maxTokens: 64,
        // The cheapest tier: this asks nothing that benefits from reasoning.
        effort: "low",
        usage: { ...USAGE, operation: "verify" },
      });
      // Naming the transport is the point of running this on Bedrock: it proves
      // which surface answered, not merely that something did.
      return {
        detail:
          `${aiProviderName()} / ${aiModelName()} replied ok=${result.ok}`,
      };
    },
  },
  {
    name: "ElevenLabs (voiceover)",
    vars: ["ELEVENLABS_API_KEY"],
    async run() {
      const { isVoiceConfigured, voiceProviderName, synthesize } = await import(
        "@/lib/providers/voice"
      );
      if (voiceProviderName() === "mock" || !isVoiceConfigured()) return null;

      const result = await synthesize({
        segments: [{ sceneIndex: 0, text: "Vidxir AI provider check." }],
        usage: { ...USAGE, operation: "verify" },
      });
      const segment = result.segments[0];
      if (!segment || segment.bytes.byteLength === 0) {
        throw new Error("returned no audio");
      }
      // The duration is measured from the returned bytes, so a plausible number
      // here also proves `mp3DurationMs` parsed a real frame header.
      return {
        detail:
          `voice ${result.voiceId} -> ${segment.bytes.byteLength} bytes, ` +
          `${segment.durationMs}ms, ${result.charactersBilled} chars billed`,
      };
    },
  },
  {
    name: "Captions (transcription)",
    vars: ["OPENAI_API_KEY", "DEEPGRAM_API_KEY"],
    async run() {
      const { isTranscriptionConfigured, transcriptionProviderName, transcribe } =
        await import("@/lib/providers/transcription");
      if (
        transcriptionProviderName() === "mock" ||
        !isTranscriptionConfigured()
      ) {
        return null;
      }

      /**
       * The audio comes from the voice provider rather than from a silent WAV or
       * a committed fixture.
       *
       * A silent WAV was the first attempt and it was wrong: `transcribe()`
       * deliberately rejects an empty cue list, because in the pipeline that means
       * a truncated upload rather than a quiet clip. Verifying with silence
       * therefore reported a failure for a working key — the check's premise was
       * wrong, not the credential.
       *
       * Synthesising a line first costs a few cents and proves more: it is
       * exactly the composition the captions stage performs, so a drift in either
       * provider's audio format shows up here instead of mid-render.
       */
      const { isVoiceConfigured, voiceProviderName, synthesize } = await import(
        "@/lib/providers/voice"
      );
      if (voiceProviderName() === "mock" || !isVoiceConfigured()) {
        return {
          detail:
            `${transcriptionProviderName()} configured, not exercised: ` +
            `needs a real voice provider to produce speech to transcribe ` +
            `(set VOICE_PROVIDER and its key)`,
        };
      }

      const spoken = await synthesize({
        segments: [
          {
            sceneIndex: 0,
            // Distinctive enough that a wrong or empty result is obvious.
            text: "Vidxir AI transcription check: the quick brown fox jumps over the lazy dog.",
          },
        ],
        usage: { ...USAGE, operation: "verify" },
      });
      const segment = spoken.segments[0];
      if (!segment) throw new Error("the voice provider returned no audio to transcribe");

      const result = await transcribe({
        audio: segment.bytes,
        filename: "verify.mp3",
        mimeType: "audio/mpeg",
        language: "en",
        usage: { ...USAGE, operation: "verify" },
      });

      const text = result.cues
        .map((c) => c.text)
        .join(" ")
        .trim();
      return {
        detail:
          `${result.provider} transcribed ${segment.bytes.byteLength} bytes of ` +
          `${spoken.provider} speech -> ${result.cues.length} cue(s), ` +
          `language ${result.language}: "${text.slice(0, 60)}${
            text.length > 60 ? "…" : ""
          }"`,
      };
    },
  },
  {
    name: "Visuals (stock / generated b-roll)",
    vars: ["VISUAL_PROVIDERS", "PEXELS_API_KEY", "RUNWAY_API_KEY"],
    async run() {
      const { isVisualsConfigured, visualsProviderName, acquireVisual } =
        await import("@/lib/providers/visuals");
      if (visualsProviderName() === "mock" || !isVisualsConfigured()) return null;

      const visual = await acquireVisual(
        {
          sceneIndex: 0,
          visualPrompt: "a city skyline at dusk",
          searchTerms: ["city skyline"],
          durationMs: 4_000,
        },
        { usage: { ...USAGE, operation: "verify" } },
      );
      return {
        detail:
          `${visual.provider} -> ${visual.kind} ${visual.width}x${visual.height}, ` +
          `${visual.bytes.byteLength} bytes`,
      };
    },
  },
  {
    name: "Freesound (music bed)",
    vars: ["FREESOUND_API_KEY"],
    async run() {
      const { isMusicConfigured, musicProviderName, acquireMusic } = await import(
        "@/lib/providers/music"
      );
      if (musicProviderName() === "mock" || !isMusicConfigured()) return null;

      const music = await acquireMusic(
        { mood: "calm documentary", durationMs: 30_000 },
        { usage: { ...USAGE, operation: "verify" } },
      );
      return {
        detail:
          `${music.provider} -> ${music.bytes.byteLength} bytes` +
          (music.attribution ? `, attribution required` : ""),
      };
    },
  },
  {
    name: "Renderer (ffmpeg / hosted)",
    vars: ["RENDER_PROVIDER", "FFMPEG_PATH"],
    async run() {
      const { renderProviderName, isRenderConfigured } = await import(
        "@/lib/providers/render"
      );
      if (!isRenderConfigured()) return null;

      const provider = renderProviderName();
      if (provider !== "ffmpeg") {
        // A hosted render is minutes and real money; the smoke tests cover the
        // local encoder, and submitting a job here is a poor trade for a
        // credential check.
        return { detail: `${provider} configured (not exercised: hosted render)` };
      }

      const { ffmpegBinary } = await import("@/lib/media/ffmpeg");
      const binary = ffmpegBinary();
      if (!binary) throw new Error("no ffmpeg binary resolved");

      const { spawnSync } = await import("node:child_process");
      const probe = spawnSync(binary, ["-hide_banner", "-version"], {
        encoding: "utf8",
      });
      if (probe.status !== 0) {
        throw new Error(`ffmpeg -version exited ${String(probe.status)}`);
      }

      // The encoders and filters the pipeline actually needs. A build without
      // libass passes `-version` and then fails every render with burned-in
      // captions, which is the failure worth catching before a user sees it.
      const encoders =
        spawnSync(binary, ["-hide_banner", "-encoders"], { encoding: "utf8" })
          .stdout ?? "";
      const filters =
        spawnSync(binary, ["-hide_banner", "-filters"], { encoding: "utf8" })
          .stdout ?? "";

      const missing = [
        ...["libx264", "aac"].filter((c) => !encoders.includes(c)),
        ...["subtitles", "amix"].filter((f) => !filters.includes(f)),
      ];
      if (missing.length > 0) throw new Error(`binary lacks: ${missing.join(", ")}`);

      const version = (probe.stdout ?? "").split("\n")[0] ?? "unknown";
      return { detail: `${version.trim()} (libx264, aac, subtitles, amix)` };
    },
  },
  {
    name: "YouTube OAuth client",
    vars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    async run() {
      const { isYouTubeConfigured, buildConsentUrl } = await import(
        "@/lib/providers/youtube"
      );
      if (!isYouTubeConfigured()) return null;

      /**
       * Not a live call, and deliberately so: every YouTube read and write in
       * Vidxir AI takes a channel's *OAuth access token*, which only exists after a
       * user has completed consent. There is no API-key-only path to exercise, so
       * the verifiable part here is that the client credentials produce a
       * well-formed consent URL carrying the scopes the app needs. Connecting a
       * channel through the UI is what proves the rest.
       */
      const url = buildConsentUrl({ state: "verify" });
      const parsed = new URL(url);
      if (!parsed.searchParams.get("client_id")) {
        throw new Error("consent URL carries no client_id");
      }
      const scopes = (parsed.searchParams.get("scope") ?? "").split(" ").length;
      return {
        detail: `consent URL builds with ${scopes} scope(s) (connect a channel to verify tokens)`,
      };
    },
  },
];

async function main(): Promise<void> {
  const only = process.argv.slice(2).map((a) => a.toLowerCase());
  const selected =
    only.length === 0
      ? CHECKS
      : CHECKS.filter((c) => only.some((a) => c.name.toLowerCase().includes(a)));

  if (selected.length === 0) {
    console.error(`No check matches: ${only.join(", ")}`);
    console.error(`Known: ${CHECKS.map((c) => c.name).join(" | ")}`);
    process.exit(2);
  }

  const { isAppError } = await import("@/lib/errors");

  let failed = 0;
  let skipped = 0;

  for (const check of selected) {
    process.stdout.write(`... ${check.name}\n`);
    try {
      const result = await check.run();
      if (result === null) {
        skipped += 1;
        console.log(`  - not configured (${check.vars.join(" / ")})\n`);
        continue;
      }
      console.log(`  OK  ${result.detail}\n`);
    } catch (error) {
      failed += 1;
      // The real message, not the sanitized one: this output is for the operator
      // who owns the credential, and a generic string would defeat the point.
      const message = error instanceof Error ? error.message : String(error);
      const code = isAppError(error) ? ` [${error.code}]` : "";
      console.log(`  FAIL ${message}${code}\n`);
    }
  }

  const { closeDb } = await import("@/lib/db");
  await closeDb().catch(() => {});

  const ran = selected.length - skipped;
  console.log(
    `${ran - failed}/${ran} live check(s) passed` +
      (skipped > 0 ? `, ${skipped} not configured` : ""),
  );
  // Non-zero only for a configured provider that failed. "Not configured" is a
  // documented state, not an error (§48), so it must not break a CI run.
  process.exit(failed > 0 ? 1 : 0);
}

void main();
