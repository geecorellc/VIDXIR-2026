/**
 * The edit document — what the user's cut actually is.
 *
 * `timeline.ts` describes a video the pipeline *derived*: scene durations come from
 * measured narration, scenes are packed end to end, and there is exactly one visual
 * and one narration per scene. That model is right for an automated build and cannot
 * express an edit. A trim has nowhere to live, a split would need two rows for one
 * scene, and moving a clip earlier would have to renumber every scene after it.
 *
 * So the edit document is a second representation, and the division of
 * responsibility between the two is the thing to keep hold of:
 *
 *  - `scenes` stays the source of truth for the **narrative** — the beats, their
 *    narration text, their visual prompts. The script stage owns it.
 *  - the edit document is the source of truth for the **cut** — what is on screen at
 *    4.2 seconds, how loud the music is under it, where the caption breaks.
 *
 * It is deliberately *not* a flattened MP4 and not a copy of the timeline. It is a
 * track/clip structure that `compileEditDocument` turns back into the same
 * `TimelineDocument` the existing renderer already consumes, which is what keeps one
 * rendering path rather than two.
 *
 * Three properties are load-bearing:
 *
 *  1. **Storage keys, not just asset ids.** A clip references what it plays by
 *     `assetId` *and* by the `storageKey` resolved at seed time. The compiler is
 *     pure and the renderer needs keys; resolving ids inside the compiler would make
 *     it asynchronous and put a database read on the preview path.
 *  2. **Source in/out is separate from timeline position.** `startMs` is where a clip
 *     sits in the video; `sourceInMs`/`sourceOutMs` are which part of the underlying
 *     file plays. That separation is the whole of trim and split — a split is two
 *     clips over one asset with adjoining source ranges.
 *  3. **Every number is milliseconds and every one is validated.** The document is
 *     `jsonb` a browser writes, so `EditDocumentSchema` is the boundary for shape the
 *     same way `requireProjectAccess` is for ownership. A `durationMs` of -1 or 1e12
 *     reaches ffmpeg as an argument, and ffmpeg is not a validator.
 *
 * The correctness property the tests pin: **a seeded, unedited document compiles to
 * the identical `TimelineDocument` that `buildTimeline` produced.** That is what
 * makes opening the editor safe — every difference in an export is then something the
 * user actually did. Several fields exist here only to hold that property: a clip's
 * `label`, `transition` and its source's `kind` are carried through untouched even
 * though the first editor does not expose them, and dropping one would silently
 * change videos that were merely opened.
 */

import { z } from "zod";
import {
  MIN_SCENE_MS,
  TAIL_PADDING_MS,
  resolveCaptionStyle,
  type TimelineCaptionStyle,
  type TimelineDocument,
  type TimelineScene,
} from "@/lib/video/timeline";
import { formatSpec, VIDEO_FORMATS, type VideoFormat } from "@/lib/video/format";

/**
 * Schema version, stored on the document.
 *
 * Not the row's optimistic-concurrency `version`, which counts saves. This is the
 * shape's version, so a document written by an older deploy is recognisable rather
 * than silently misread. Bumped only when a field changes meaning.
 */
export const EDIT_DOCUMENT_VERSION = 1;

/**
 * The longest video the editor accepts, and every bound below follows from it.
 *
 * Six hours is far past anything Vidxir AI generates; the point is that a ceiling exists
 * at all. Without one, a `startMs` of `Number.MAX_SAFE_INTEGER` becomes an ffmpeg
 * `-t` argument and a filter graph that never terminates.
 */
export const MAX_TIMELINE_MS = 6 * 60 * 60_000;

/**
 * The shortest clip that plays a media file.
 *
 * Well under `MIN_SCENE_MS`: that floor is an editorial judgement about how fast a cut
 * can read, and the editor exists to let a user overrule it. This one is mechanical —
 * a frame at 30fps is 33ms, so three frames is the least that can be decoded into
 * something. Shorter than this, ffmpeg's `trim` yields zero frames and `concat`
 * rejects the graph.
 *
 * Deliberately **not** applied to text and caption clips. Whisper emits word-level
 * cues, and a cue for "a" is routinely 40–80ms; flooring those would make a seeded
 * document compile to different caption timings than the render used, which is exactly
 * the silent change this module exists to prevent. A 60ms subtitle is a subtitle nobody
 * reads — harmless — whereas a 60ms video input is a broken filter graph.
 */
export const MIN_MEDIA_CLIP_MS = 100;

/**
 * The shortest clip of any kind.
 *
 * One millisecond, not zero: a zero-length clip is not a cut and would divide by zero
 * in the preview's scrubber. Anything longer is the caller's judgement.
 */
export const MIN_CLIP_MS = 1;

/** Tracks, in the order they stack. Later kinds paint over earlier ones. */
export const TRACK_KINDS = [
  "video",
  "image",
  "text",
  "caption",
  "voiceover",
  "music",
] as const;

export type TrackKind = (typeof TRACK_KINDS)[number];

/**
 * The four asset kinds that can appear on a visual track.
 *
 * The same four `TimelineScene.visualKind` allows, and for the same reason: the
 * renderer decides from the kind whether to loop an input or hold a frame from it.
 * Carried on the clip so the compiler stays pure — it has no asset row to look a kind
 * up in.
 */
export const CLIP_VISUAL_KINDS = [
  "stock_video",
  "stock_image",
  "generated_video",
  "generated_image",
] as const;

export type ClipVisualKind = (typeof CLIP_VISUAL_KINDS)[number];

/** Which track kinds carry pixels. */
const VISUAL_TRACK_KINDS: readonly TrackKind[] = ["video", "image"];

/** Which carry sound, and therefore support volume and audio trim. */
const AUDIO_TRACK_KINDS: readonly TrackKind[] = ["voiceover", "music"];

export function isVisualTrack(kind: TrackKind): boolean {
  return VISUAL_TRACK_KINDS.includes(kind);
}

export function isAudioTrack(kind: TrackKind): boolean {
  return AUDIO_TRACK_KINDS.includes(kind);
}

/**
 * A bounded millisecond offset.
 *
 * Integer because a fractional millisecond has no meaning at any frame rate Vidxir AI
 * renders, and the ffmpeg argument builder's `.toFixed(3)` would round it away
 * anyway — better rejected here than silently changed there.
 */
const Ms = z.number().int().min(0).max(MAX_TIMELINE_MS);

/** A clip's own length. Bounded below so a zero-length clip cannot exist. */
const DurationMs = z.number().int().min(MIN_CLIP_MS).max(MAX_TIMELINE_MS);

/**
 * Linear gain.
 *
 * Capped at 2 rather than 1: a quiet voiceover genuinely needs boosting and ffmpeg's
 * `volume` filter handles >1 correctly. Past 2 is clipping, not editing.
 */
const Gain = z.number().min(0).max(2);

/**
 * The asset a clip plays.
 *
 * `assetId` and `storageKey` are both required. The id is what the editor round-trips
 * and what a future "replace this clip's footage" would rewrite; the key is what the
 * compiler hands the renderer. Keeping both means the compiler stays pure and a clip
 * whose asset row was deleted is detectable rather than a dangling key.
 */
const ClipSourceSchema = z
  .object({
    assetId: z.string().uuid(),
    storageKey: z.string().min(1).max(512),
    /**
     * The asset's kind, for visual clips.
     *
     * Null on audio clips, where it carries nothing the compiler needs. Preserved
     * rather than re-derived so a stock clip stays `stock_video` through an
     * open-and-export: `TimelineScene.visualKind` is provenance as well as a renderer
     * hint, and §29 wants provenance kept.
     */
    kind: z.enum(CLIP_VISUAL_KINDS).nullable().default(null),
    /**
     * Intrinsic length of the underlying file, when known.
     *
     * Null for a still, which has no length, and for an asset whose duration was
     * never measured. The editor stops a trim handle at the end of the material with
     * it; the renderer decides from it whether an input needs looping.
     */
    sourceDurationMs: z.number().int().min(0).max(MAX_TIMELINE_MS).nullable(),
  })
  .strict();

export type ClipSource = z.infer<typeof ClipSourceSchema>;

/**
 * One clip on one track.
 *
 * `id` is client-generated and only has to be unique within the document — it is how
 * the editor addresses a clip for selection, drag and undo. It is never a database
 * key, which is why it is a bounded string rather than a uuid: requiring uuid would
 * force the editor to mint them in a particular format for no benefit.
 */
const ClipSchema = z
  .object({
    id: z.string().min(1).max(64),
    /** Where this clip starts in the finished video. */
    startMs: Ms,
    /** How long it occupies the timeline. */
    durationMs: DurationMs,
    /**
     * Which part of the source plays, when the source is time-based.
     *
     * Null for a still, a text clip or a caption — there is nothing to seek into.
     * When set, `sourceOutMs - sourceInMs` need not equal `durationMs`: a 3s window of
     * footage held for 5s is a legitimate edit (the renderer holds or loops), and
     * forcing them equal would forbid it.
     */
    sourceInMs: Ms.nullable().default(null),
    sourceOutMs: Ms.nullable().default(null),
    /** Audio gain. Ignored on visual and text clips. */
    volume: Gain.default(1),
    /**
     * Text content, for `text` and `caption` clips.
     *
     * Bounded at 500 because this is burned into the frame, and more than a few lines
     * cannot be read at any size that fits.
     */
    text: z.string().max(500).nullable().default(null),
    /**
     * Storyboard label — "Hook", "Problem", "CTA".
     *
     * Shown against the clip in the timeline, and carried onto the compiled scene so
     * an unedited document keeps the labels the script stage assigned.
     */
    label: z.string().max(80).nullable().default(null),
    /**
     * The transition into this clip.
     *
     * Transitions are deliberately deferred, so nothing in the first editor writes
     * this — it is here to be *preserved*. `buildTimeline` defaults scene 0 to "none"
     * and every other scene to "fade", and an export that quietly turned each existing
     * fade into a hard cut would be an edit the user did not make.
     */
    transition: z.string().max(32).nullable().default(null),
    /** The asset, for clips that play one. Null on text and caption clips. */
    source: ClipSourceSchema.nullable().default(null),
    /**
     * The scene this clip came from, when it came from one.
     *
     * Kept so the editor can show a clip's origin and so re-generating one scene can
     * later find the clips it replaced. Null for anything the user added by hand.
     */
    sceneIndex: z.number().int().min(0).max(10_000).nullable().default(null),
  })
  .strict()
  .superRefine((clip, ctx) => {
    // A source window that runs backwards is not a trim, and ffmpeg would "accept"
    // `-ss 9 -to 4` by producing nothing rather than by failing.
    if (
      clip.sourceInMs !== null &&
      clip.sourceOutMs !== null &&
      clip.sourceOutMs <= clip.sourceInMs
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceOutMs"],
        message: "the source window must end after it starts",
      });
    }

    if (clip.startMs + clip.durationMs > MAX_TIMELINE_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationMs"],
        message: "the clip ends past the maximum timeline length",
      });
    }

    // A clip that plays a file has to be long enough to decode a frame from it; a text
    // or caption clip does not, which is why this is conditional on having a source.
    if (clip.source !== null && clip.durationMs < MIN_MEDIA_CLIP_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationMs"],
        message: `a clip playing an asset must be at least ${MIN_MEDIA_CLIP_MS}ms`,
      });
    }
  });

export type EditClip = z.infer<typeof ClipSchema>;

/**
 * One track.
 *
 * `kind` decides what the compiler does with the clips and what the properties panel
 * offers. Several tracks may share a kind — two video tracks is how a cutaway is
 * expressed — and `order` breaks the tie for stacking.
 */
const TrackSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.enum(TRACK_KINDS),
    /** Shown in the timeline gutter. Falls back to the kind when absent. */
    label: z.string().max(80).nullable().default(null),
    /** Higher paints later, so a higher-order visual track covers a lower one. */
    order: z.number().int().min(0).max(64).default(0),
    /** A muted audio track contributes nothing to the mix. */
    muted: z.boolean().default(false),
    /** A hidden visual track contributes no pixels. */
    hidden: z.boolean().default(false),
    /** Track-level gain, multiplied with each clip's own. */
    volume: Gain.default(1),
    clips: z.array(ClipSchema).max(500),
  })
  .strict()
  .superRefine((track, ctx) => {
    const ids = new Set<string>();
    for (const clip of track.clips) {
      if (ids.has(clip.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["clips"],
          message: `duplicate clip id ${clip.id}`,
        });
      }
      ids.add(clip.id);
    }

    // Overlap is rejected per track rather than tolerated. Two clips on one track at
    // the same moment have no defined winner, and silently preferring one would let a
    // drag that landed a pixel too far produce a video the editor never showed.
    // Overlapping *is* expressible — on two tracks, which is what stacking is for.
    const sorted = [...track.clips].sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1];
      const current = sorted[i];
      if (!previous || !current) continue;
      if (current.startMs < previous.startMs + previous.durationMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["clips"],
          message: `clips ${previous.id} and ${current.id} overlap on one track`,
        });
      }
    }
  });

export type EditTrack = z.infer<typeof TrackSchema>;

/**
 * Caption look, mirroring `TimelineCaptionStyle`.
 *
 * Redeclared with bounds rather than reused as a type, because this arrives from a
 * browser. The ranges are the ones `timeline.ts`'s `pickStyle` already enforces on the
 * brand kit's copy, so a style that survives one path survives the other.
 */
const CaptionStyleSchema = z
  .object({
    fontFamily: z.string().min(1).max(60),
    fontSizePx: z.number().int().min(20).max(120),
    color: z.string().regex(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i),
    backgroundColor: z
      .string()
      .regex(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i)
      .nullable(),
    verticalPosition: z.number().min(0).max(1),
  })
  .strict();

export const EditDocumentSchema = z
  .object({
    /** Shape version, not save count. */
    schemaVersion: z.literal(EDIT_DOCUMENT_VERSION),
    format: z.enum(VIDEO_FORMATS),
    tracks: z.array(TrackSchema).min(1).max(24),
    captions: z
      .object({
        burnedIn: z.boolean(),
        style: CaptionStyleSchema,
      })
      .strict(),
    music: z
      .object({
        duckUnderNarration: z.boolean(),
      })
      .strict(),
    brand: z
      .object({
        primaryColor: z.string().max(32).nullable(),
        secondaryColor: z.string().max(32).nullable(),
        fontPreference: z.string().max(80).nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((document, ctx) => {
    const ids = new Set<string>();
    for (const track of document.tracks) {
      if (ids.has(track.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tracks"],
          message: `duplicate track id ${track.id}`,
        });
      }
      ids.add(track.id);
    }
  });

export type EditDocument = z.infer<typeof EditDocumentSchema>;

/**
 * Parse an untrusted document.
 *
 * Throws `ZodError`. Note that a `ZodError` is *not* an `AppError`, so a route letting
 * one escape renders a 500 rather than a 400 — a request carrying an untrusted document
 * should go through `edit-service`'s `parseIncomingDocument`, which translates it into a
 * `ValidationError`. This entry point is for documents that are already ours: a stored
 * row on the way out, or a seed the compiler produced.
 */
export function parseEditDocument(value: unknown): EditDocument {
  return EditDocumentSchema.parse(value);
}

// ---------------------------------------------------------------------------
// Seeding — an existing project becomes an editable document
// ---------------------------------------------------------------------------

/**
 * What the seeder needs to know about one scene.
 *
 * Deliberately the shape `assembleTimeline` already assembles rather than a new query,
 * so the two cannot read the same project differently.
 */
export interface SeedScene {
  index: number;
  label: string | null;
  onScreenText: string | null;
  transition: string | null;
  /**
   * Absolute offset from `scenes.start_ms`, or null when the timeline stage has not
   * written it yet. Null means the seeder packs the scene the way `buildTimeline`
   * would, so the document still describes the video that stage would have built.
   */
  startMs: number | null;
  durationMs: number | null;
  visual: {
    assetId: string;
    storageKey: string;
    kind: ClipVisualKind;
    durationMs: number | null;
  };
  narration: {
    assetId: string;
    storageKey: string;
    durationMs: number;
  } | null;
}

export interface SeedInput {
  format: VideoFormat | null;
  scenes: readonly SeedScene[];
  music: {
    assetId: string;
    storageKey: string;
    volume: number;
    startMs: number;
    durationMs: number | null;
    duckUnderNarration: boolean;
  } | null;
  captions: {
    burnedIn: boolean;
    cues: ReadonlyArray<{ startMs: number; endMs: number; text: string }>;
  } | null;
  /** The brand kit's raw `caption_style` jsonb, resolved here exactly as the pipeline does. */
  captionStyle?: Partial<TimelineCaptionStyle> | null;
  brand?: {
    primaryColor?: string | null;
    secondaryColor?: string | null;
    fontPreference?: string | null;
  } | null;
}

/**
 * Build the first editable document for a project the pipeline has already built.
 *
 * Every clip is placed at the offset the render used, read from `scenes.start_ms`
 * rather than recomputed — so opening the editor loads the actual scenes, generated
 * footage, voiceover, music, captions and timing.
 *
 * Track layout, and why it is this rather than one track per scene:
 *
 *  - **one** video track carrying every scene's visual in order. Scenes are
 *    sequential in the source material, so they are clips on a shared track; that is
 *    what makes dragging one earlier a move rather than a renumber.
 *  - **one** voiceover track, each clip at its own scene's offset.
 *  - **one** music track, at most one clip.
 *  - **one** caption track, one clip per cue, so a cue can be retimed and reworded
 *    like any other clip.
 *  - **one** text track for on-screen text, present only when a scene has any.
 *
 * Stills and footage share the `video` track rather than splitting by kind: they
 * occupy the same visual slot and each clip carries its own kind, so a separate
 * `image` track would be empty in most projects.
 */
export function seedEditDocument(input: SeedInput): EditDocument {
  const spec = formatSpec(input.format);
  const ordered = [...input.scenes].sort((a, b) => a.index - b.index);

  const videoClips: EditClip[] = [];
  const voiceClips: EditClip[] = [];
  const textClips: EditClip[] = [];

  // Only consulted for scenes whose measured offsets are missing. Advanced for every
  // scene regardless, so a project whose timeline stage ran partially still packs the
  // remainder contiguously rather than restarting at zero.
  let cursor = 0;

  for (const scene of ordered) {
    const narrationMs = Math.round(scene.narration?.durationMs ?? 0);
    // `buildTimeline`'s rule, through its exported constant rather than re-derived: a
    // scene is at least MIN_SCENE_MS long however short its line is.
    const packedMs = Math.max(MIN_SCENE_MS, narrationMs);

    const durationMs =
      scene.durationMs !== null && scene.durationMs > 0
        ? Math.max(MIN_MEDIA_CLIP_MS, Math.round(scene.durationMs))
        : packedMs;
    const startMs =
      scene.startMs !== null ? Math.max(0, Math.round(scene.startMs)) : cursor;

    cursor = startMs + durationMs;

    videoClips.push({
      id: `scene-${scene.index}-visual`,
      startMs,
      durationMs,
      // Untrimmed by definition: the pipeline never trimmed, it held or looped to fill
      // the slot. A trim is something only the editor introduces.
      sourceInMs: null,
      sourceOutMs: null,
      volume: 0,
      text: null,
      label: scene.label,
      transition: scene.transition,
      source: {
        assetId: scene.visual.assetId,
        storageKey: scene.visual.storageKey,
        kind: scene.visual.kind,
        sourceDurationMs: scene.visual.durationMs,
      },
      sceneIndex: scene.index,
    });

    if (scene.narration && narrationMs > 0) {
      voiceClips.push({
        id: `scene-${scene.index}-narration`,
        startMs,
        // The narration's own measured length, which may be shorter than the slot:
        // `buildTimeline` floors a scene at MIN_SCENE_MS, so a short line leaves the
        // visual up after the audio ends. Stretching this to fill would be an edit.
        durationMs: Math.max(MIN_MEDIA_CLIP_MS, narrationMs),
        sourceInMs: null,
        sourceOutMs: null,
        volume: 1,
        text: null,
        label: scene.label,
        transition: null,
        source: {
          assetId: scene.narration.assetId,
          storageKey: scene.narration.storageKey,
          kind: null,
          sourceDurationMs: scene.narration.durationMs,
        },
        sceneIndex: scene.index,
      });
    }

    if (scene.onScreenText) {
      textClips.push({
        id: `scene-${scene.index}-text`,
        startMs,
        durationMs: onScreenTextMs(durationMs),
        sourceInMs: null,
        sourceOutMs: null,
        volume: 0,
        text: scene.onScreenText.slice(0, 500),
        label: scene.label,
        transition: null,
        source: null,
        sceneIndex: scene.index,
      });
    }
  }

  /**
   * Caption cues become clips, one per cue, and their timings are preserved to the
   * millisecond rather than floored.
   *
   * `startMs` is clamped to zero the way `buildTimeline` clamps it, and the length is
   * measured from the *clamped* start — a cue at -200..300ms is 300ms of subtitle in
   * both models, not 500ms of it. Cues that survive neither rounding are dropped here
   * exactly as `buildTimeline` drops them.
   */
  const captionClips: EditClip[] = [];
  (input.captions?.cues ?? []).forEach((cue, index) => {
    const startMs = Math.max(0, Math.round(cue.startMs));
    const endMs = Math.round(cue.endMs);
    if (endMs <= startMs) return;

    captionClips.push({
      id: `cue-${index}`,
      startMs,
      durationMs: Math.max(MIN_CLIP_MS, endMs - startMs),
      sourceInMs: null,
      sourceOutMs: null,
      volume: 0,
      text: cue.text.slice(0, 500),
      label: null,
      transition: null,
      source: null,
      sceneIndex: null,
    });
  });

  // `buildTimeline` gives the video a tail of silence past the last scene and the bed
  // plays under it, so the music clip runs to the same end the render used.
  const contentEndMs = videoClips.reduce(
    (end, clip) => Math.max(end, clip.startMs + clip.durationMs),
    0,
  );

  const musicClips: EditClip[] = [];
  if (input.music) {
    const startMs = Math.max(0, Math.round(input.music.startMs));
    musicClips.push({
      id: "music-0",
      startMs,
      durationMs: Math.max(
        MIN_MEDIA_CLIP_MS,
        contentEndMs + TAIL_PADDING_MS - startMs,
      ),
      sourceInMs: null,
      sourceOutMs: null,
      volume: input.music.volume,
      text: null,
      label: null,
      transition: null,
      source: {
        assetId: input.music.assetId,
        storageKey: input.music.storageKey,
        kind: null,
        sourceDurationMs: input.music.durationMs,
      },
      sceneIndex: null,
    });
  }

  const tracks: EditTrack[] = [track("video-0", "video", "Video", 0, videoClips)];

  if (textClips.length > 0) {
    tracks.push(track("text-0", "text", "On-screen text", 1, textClips));
  }
  if (captionClips.length > 0) {
    tracks.push(track("caption-0", "caption", "Captions", 2, captionClips));
  }
  if (voiceClips.length > 0) {
    tracks.push(track("voiceover-0", "voiceover", "Voiceover", 0, voiceClips));
  }
  if (musicClips.length > 0) {
    tracks.push(track("music-0", "music", "Music", 1, musicClips));
  }

  return {
    schemaVersion: EDIT_DOCUMENT_VERSION,
    format: spec.format,
    tracks,
    captions: {
      burnedIn: input.captions?.burnedIn ?? true,
      // Resolved once, here, through the pipeline's own merge — so the document holds
      // the values the render used rather than a second interpretation of the kit.
      style: resolveCaptionStyle(input.captionStyle),
    },
    music: { duckUnderNarration: input.music?.duckUnderNarration ?? true },
    brand: {
      primaryColor: input.brand?.primaryColor ?? null,
      secondaryColor: input.brand?.secondaryColor ?? null,
      fontPreference: input.brand?.fontPreference ?? null,
    },
  };
}

function track(
  id: string,
  kind: TrackKind,
  label: string,
  order: number,
  clips: EditClip[],
): EditTrack {
  return { id, kind, label, order, muted: false, hidden: false, volume: 1, clips };
}

/**
 * How long on-screen text holds.
 *
 * Mirrors the window `render.ts` gives a Shotstack title built from
 * `scene.onScreenText`: at least 1.5s, at most 4s, and never quite to the end of the
 * scene, so it does not compete with the captions for the whole shot. Duplicated as a
 * function because `render.ts` computes it inline in seconds; the numbers are asserted
 * in the tests so the two cannot drift silently.
 */
function onScreenTextMs(sceneDurationMs: number): number {
  return Math.round(Math.min(4_000, Math.max(1_500, sceneDurationMs - 500)));
}

// ---------------------------------------------------------------------------
// Compilation — the document becomes the timeline the renderer already takes
// ---------------------------------------------------------------------------

/**
 * A clip the compiler has resolved to a position, a source window and a gain.
 *
 * Exported because Phase B's renderer needs per-clip trims and gains that
 * `TimelineScene` has no field for, and because the preview reads the same shape. One
 * structure for both is what makes preview and export agree.
 */
export interface CompiledClip {
  clipId: string;
  trackId: string;
  trackKind: TrackKind;
  startMs: number;
  durationMs: number;
  sourceInMs: number | null;
  sourceOutMs: number | null;
  /** Track gain multiplied by clip gain, clamped. Zero on a muted track. */
  gain: number;
  text: string | null;
  storageKey: string | null;
  sourceKind: ClipVisualKind | null;
  sourceDurationMs: number | null;
  sceneIndex: number | null;
  label: string | null;
  transition: string | null;
  /** True when the owning track is hidden, so the compiler leaves it out of the frame. */
  hidden: boolean;
  /** Stacking order: track order first, then the track's position in the document. */
  layer: number;
}

export interface CompiledEdit {
  /** What the existing renderer consumes, unchanged in shape. */
  timeline: TimelineDocument;
  /**
   * Every clip, in timeline order, with its source window and gain.
   *
   * The timeline document cannot carry these — it has one visual per scene and no
   * concept of a trim — so Phase B's ffmpeg builder and the editor's preview read this
   * instead. It is a superset of the timeline derived in the same pass, so the two
   * cannot describe different videos.
   */
  clips: readonly CompiledClip[];
  durationMs: number;
}

/**
 * Turn an edit document into a timeline.
 *
 * The single compiler both the preview and the export go through. Pure: no database,
 * no storage, no network, which is what lets the preview call it on every change and
 * the test compare its output to `buildTimeline`'s directly.
 *
 * How the track model collapses back onto `TimelineScene`, which has room for one
 * visual and one narration per entry:
 *
 *  - each visible visual clip becomes a scene, in start order. A split therefore
 *    produces two scenes, which is right — they are two shots.
 *  - the narration clip starting nearest a visual clip's own start, within it, is that
 *    scene's narration. That reproduces the seeded pairing exactly and degrades
 *    sensibly once things move: narration sitting under no visual is carried on the
 *    clip list for Phase B's mixer rather than silently dropped.
 *  - caption clips become cues; text clips become the scenes' `onScreenText`.
 *
 * `buildTimeline` is deliberately *not* called to place the scenes. Its packing is
 * precisely the behaviour an editor exists to override, and invoking it only to
 * overwrite its offsets would leave two placements in the code with one of them dead.
 * What is shared instead is everything that is genuinely one rule: `resolveCaptionStyle`,
 * `TAIL_PADDING_MS`, `MIN_SCENE_MS` and the cue clipping below. The equality test is
 * what holds the two in agreement.
 */
export function compileEditDocument(document: EditDocument): CompiledEdit {
  const spec = formatSpec(document.format);

  const clips: CompiledClip[] = [];

  document.tracks.forEach((track, position) => {
    for (const clip of track.clips) {
      const audible = isAudioTrack(track.kind) && !track.muted;
      clips.push({
        clipId: clip.id,
        trackId: track.id,
        trackKind: track.kind,
        startMs: clip.startMs,
        durationMs: clip.durationMs,
        sourceInMs: clip.sourceInMs,
        sourceOutMs: clip.sourceOutMs,
        // A muted track contributes silence rather than being absent: the clip is
        // still on the timeline, still selectable, still exported at gain 0.
        gain: audible ? clampGain(track.volume * clip.volume) : 0,
        text: clip.text,
        storageKey: clip.source?.storageKey ?? null,
        sourceKind: clip.source?.kind ?? null,
        sourceDurationMs: clip.source?.sourceDurationMs ?? null,
        sceneIndex: clip.sceneIndex,
        label: clip.label,
        transition: clip.transition,
        hidden: track.hidden,
        layer: track.order * 100 + position,
      });
    }
  });

  clips.sort((a, b) => a.startMs - b.startMs || a.layer - b.layer);

  const visuals = clips.filter(
    (clip) =>
      isVisualTrack(clip.trackKind) && clip.storageKey !== null && !clip.hidden,
  );

  const narrations = clips.filter(
    (clip) => clip.trackKind === "voiceover" && clip.storageKey !== null,
  );

  const texts = clips.filter((clip) => clip.trackKind === "text" && clip.text);

  const musicClip =
    clips.find((clip) => clip.trackKind === "music" && clip.storageKey !== null) ??
    null;

  /**
   * The video's length.
   *
   * The visual track's extent plus the same tail of silence `buildTimeline` adds, so
   * an unedited document lands on the identical duration. Audio reaching past the last
   * visual also counts: a music bed the user dragged long is part of the video, and
   * cutting it here would silently undo the edit.
   */
  const visualEndMs = visuals.reduce(
    (end, clip) => Math.max(end, clip.startMs + clip.durationMs),
    0,
  );
  const audioEndMs = clips
    .filter((clip) => isAudioTrack(clip.trackKind))
    .reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0);

  const durationMs =
    visualEndMs > 0 ? Math.max(visualEndMs + TAIL_PADDING_MS, audioEndMs) : 0;

  const scenes: TimelineScene[] = visuals.map((clip, index) => {
    const narration = narrationFor(narrations, clip);
    const text = texts.find(
      (candidate) =>
        candidate.startMs >= clip.startMs &&
        candidate.startMs < clip.startMs + clip.durationMs,
    );

    return {
      // Renumbered in timeline order rather than carried from the scene row: after a
      // split or a reorder the row's index no longer describes position, and the
      // renderer concatenates in this order.
      index,
      label: clip.label,
      startMs: clip.startMs,
      durationMs: clip.durationMs,
      visualKey: clip.storageKey as string,
      visualKind: clip.sourceKind ?? inferVisualKind(clip),
      visualDurationMs: clip.sourceDurationMs,
      narrationKey: narration?.storageKey ?? null,
      narrationDurationMs: narration?.durationMs ?? 0,
      onScreenText: text?.text ?? null,
      // `buildTimeline`'s own default, applied to the compiled position rather than to
      // the original scene index: the first thing on screen cannot fade in from
      // anything, whichever clip the user dragged there.
      transition: clip.transition ?? (index === 0 ? "none" : "fade"),
    };
  });

  const cues = clips
    .filter((clip) => clip.trackKind === "caption" && clip.text)
    .map((clip) => ({
      startMs: clip.startMs,
      endMs: clip.startMs + clip.durationMs,
      text: clip.text as string,
    }))
    // `buildTimeline`'s clipping rule: a cue past the last frame is dropped by some
    // providers and errors on others, so it is trimmed back or removed here.
    .filter((cue) => cue.startMs < durationMs)
    .map((cue) => ({ ...cue, endMs: Math.min(durationMs, cue.endMs) }))
    .filter((cue) => cue.endMs > cue.startMs);

  const timeline: TimelineDocument = {
    width: spec.width,
    height: spec.height,
    fps: spec.fps,
    durationMs,
    scenes,
    music: musicClip
      ? {
          key: musicClip.storageKey as string,
          volume: musicClip.gain,
          duckUnderNarration: document.music.duckUnderNarration,
          startMs: musicClip.startMs,
          durationMs: musicClip.sourceDurationMs,
        }
      : null,
    captions:
      cues.length > 0
        ? {
            burnedIn: document.captions.burnedIn,
            style: resolveCaptionStyle(document.captions.style),
            cues,
          }
        : null,
    brand: document.brand,
  };

  return { timeline, clips, durationMs };
}

/**
 * The narration belonging to a visual clip.
 *
 * "Starts within this clip, nearest its start" rather than "overlaps it": a seeded
 * document has them starting on the same millisecond, and after an edit the narration
 * that begins under a shot is the one that belongs to it. Narration starting under no
 * visual matches nothing here and stays on the clip list for the mixer — the honest
 * outcome, since it is audible in the export and visible in the editor, just not
 * attributed to a scene.
 */
function narrationFor(
  narrations: readonly CompiledClip[],
  visual: CompiledClip,
): CompiledClip | null {
  let best: CompiledClip | null = null;
  for (const candidate of narrations) {
    if (candidate.startMs < visual.startMs) continue;
    if (candidate.startMs >= visual.startMs + visual.durationMs) continue;
    if (!best || candidate.startMs < best.startMs) best = candidate;
  }
  return best;
}

/**
 * The kind of a visual clip whose source did not record one.
 *
 * Only reached for a clip assembled outside the seeder. A source with a measured
 * length is time-based, one without is a still — the same distinction
 * `render.ts`'s `isVideo` makes, and the one that decides whether ffmpeg loops an
 * input or holds a frame from it. `generated_*` rather than `stock_*` because a clip
 * with no recorded provenance must not claim a stock licence it cannot evidence (§29).
 */
function inferVisualKind(clip: CompiledClip): ClipVisualKind {
  return clip.sourceDurationMs !== null && clip.sourceDurationMs > 0
    ? "generated_video"
    : "generated_image";
}

function clampGain(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(2, Math.max(0, value));
}
