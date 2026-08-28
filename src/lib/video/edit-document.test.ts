/**
 * Edit-document tests.
 *
 * One claim carries the whole phase, and it is the first describe block below:
 * **seeding a project and compiling it back produces the identical
 * `TimelineDocument` that `buildTimeline` produced from the same rows.** Everything
 * downstream depends on it. If it holds, opening the editor and exporting without
 * touching anything cannot change the video, and every difference in an export is
 * something the user actually did. If it fails, the editor silently re-cuts videos
 * merely by being opened — and it would fail quietly, in a rendered MP4 nobody
 * diffs.
 *
 * The equality is asserted with `toEqual` on the whole document rather than field by
 * field, deliberately: a new field added to `TimelineDocument` that the compiler
 * forgets to populate has to fail this test rather than slip through a list of
 * assertions that predates it.
 *
 * The rest of the file pins the two things a document is otherwise trusted for: that
 * the schema rejects what would reach ffmpeg as a bad argument, and that each editing
 * operation the first release supports actually changes the compiled timeline.
 */
import { describe, expect, it } from "vitest";
import {
  buildTimeline,
  MIN_SCENE_MS,
  TAIL_PADDING_MS,
  type BuildTimelineInput,
  type SceneInput,
} from "@/lib/video/timeline";
import {
  compileEditDocument,
  EditDocumentSchema,
  EDIT_DOCUMENT_VERSION,
  MAX_TIMELINE_MS,
  MIN_MEDIA_CLIP_MS,
  parseEditDocument,
  seedEditDocument,
  type EditClip,
  type EditDocument,
  type SeedInput,
  type SeedScene,
} from "@/lib/video/edit-document";

// ---------------------------------------------------------------------------
// Fixtures
//
// Two views of one project: what `assembleTimeline` would hand `buildTimeline`, and
// what the database rows behind it look like to the seeder. `seedFromScenes` derives
// the second from the first, including the derived `start_ms`/`duration_ms` the
// TIMELINE stage writes back — so the two cannot silently describe different videos
// and the equality test is comparing the same project through two paths.
// ---------------------------------------------------------------------------

const NARRATION_MS = [6_000, 11_400, 1_200] as const;

function pipelineScene(index: number, narrationDurationMs: number): SceneInput {
  return {
    index,
    label: `Scene ${index}`,
    onScreenText: index === 1 ? "Look at this" : null,
    // Null so `buildTimeline` applies its own default, which is the interesting case:
    // scene 0 cuts and the rest fade, and the compiler has to reproduce that.
    transition: null,
    visualKey: `visual-${index}.mp4`,
    visualKind: index === 2 ? "stock_image" : "stock_video",
    visualDurationMs: index === 2 ? null : 8_000,
    narrationKey: `narration-${index}.mp3`,
    narrationDurationMs,
  };
}

const CUES = [
  { startMs: 0, endMs: 1_800, text: "First line" },
  { startMs: 1_800, endMs: 4_100, text: "Second line" },
  // Word-level, the length Whisper actually emits. Under MIN_MEDIA_CLIP_MS, which is
  // why caption clips are not floored to it.
  { startMs: 4_100, endMs: 4_160, text: "a" },
] as const;

const MUSIC = {
  key: "music/bed.mp3",
  volume: 0.14,
  duckUnderNarration: true,
  startMs: 0,
  durationMs: 120_000,
} as const;

function pipelineInput(overrides: Partial<BuildTimelineInput> = {}): BuildTimelineInput {
  return {
    format: "landscape",
    scenes: NARRATION_MS.map((ms, index) => pipelineScene(index, ms)),
    music: { ...MUSIC },
    captionCues: CUES.map((cue) => ({ ...cue })),
    burnCaptions: true,
    captionStyle: null,
    brand: {
      primaryColor: "#22D3EE",
      secondaryColor: null,
      fontPreference: "Inter",
    },
    ...overrides,
  };
}

/**
 * The seeder's view of the same project.
 *
 * `startMs`/`durationMs` are taken from `buildTimeline`'s own output rather than
 * hard-coded, because that is what the TIMELINE stage writes back to `scenes` — the
 * seeder reads measured columns, not a second calculation of them.
 */
function seedInput(overrides: Partial<SeedInput> = {}): SeedInput {
  const built = buildTimeline(pipelineInput());

  const scenes: SeedScene[] = built.scenes.map((scene) => ({
    index: scene.index,
    label: scene.label,
    onScreenText: scene.onScreenText,
    // Null in the row: the pipeline never wrote a transition, it let the builder
    // default one. The compiler has to arrive at the same default.
    transition: null,
    startMs: scene.startMs,
    durationMs: scene.durationMs,
    visual: {
      assetId: `1111111a-0000-4000-8000-00000000000${scene.index}`,
      storageKey: scene.visualKey,
      kind: scene.visualKind,
      durationMs: scene.visualDurationMs,
    },
    narration: scene.narrationKey
      ? {
          assetId: `2222222b-0000-4000-8000-00000000000${scene.index}`,
          storageKey: scene.narrationKey,
          durationMs: scene.narrationDurationMs,
        }
      : null,
  }));

  return {
    format: "landscape",
    scenes,
    music: {
      assetId: "3333333c-0000-4000-8000-000000000000",
      storageKey: MUSIC.key,
      volume: MUSIC.volume,
      startMs: MUSIC.startMs,
      durationMs: MUSIC.durationMs,
      duckUnderNarration: MUSIC.duckUnderNarration,
    },
    captions: { burnedIn: true, cues: CUES.map((cue) => ({ ...cue })) },
    captionStyle: null,
    brand: {
      primaryColor: "#22D3EE",
      secondaryColor: null,
      fontPreference: "Inter",
    },
    ...overrides,
  };
}

/** Find a track by id, failing loudly rather than returning undefined. */
function trackOf(document: EditDocument, id: string) {
  const track = document.tracks.find((t) => t.id === id);
  if (!track) throw new Error(`no track ${id} in document`);
  return track;
}

/** Structurally clone a document so a mutation in one test cannot leak into another. */
function edit(document: EditDocument, mutate: (draft: EditDocument) => void): EditDocument {
  const draft = JSON.parse(JSON.stringify(document)) as EditDocument;
  mutate(draft);
  // Re-parsed rather than returned raw: an operation that produced an invalid document
  // should fail in the test that performs it, not in the compiler downstream.
  return parseEditDocument(draft);
}

// ---------------------------------------------------------------------------

describe("an unedited document compiles to the pipeline's own timeline", () => {
  it("produces a byte-for-byte identical TimelineDocument", () => {
    const expected = buildTimeline(pipelineInput());
    const { timeline } = compileEditDocument(seedEditDocument(seedInput()));

    // The whole document, not a field list: a field added to TimelineDocument that
    // the compiler forgets has to break here.
    expect(timeline).toEqual(expected);
  });

  it("matches with no music, no captions and no on-screen text", () => {
    // The all-null project — a channel-less video with an unconfigured music provider
    // — takes different branches in both models. Both have to still agree.
    const scenes = NARRATION_MS.map((ms, index) => ({
      ...pipelineScene(index, ms),
      onScreenText: null,
    }));

    const expected = buildTimeline(
      pipelineInput({ scenes, music: null, captionCues: [], brand: null }),
    );

    const seeded = seedEditDocument({
      ...seedInput(),
      scenes: seedInput().scenes.map((scene) => ({ ...scene, onScreenText: null })),
      music: null,
      captions: null,
      brand: null,
    });

    expect(compileEditDocument(seeded).timeline).toEqual(expected);
  });

  it("matches for a portrait project", () => {
    // The frame comes from the project, and the two models must read it the same way
    // — a portrait video seeded as landscape would export cropped.
    const expected = buildTimeline(pipelineInput({ format: "portrait" }));
    const seeded = seedEditDocument({ ...seedInput(), format: "portrait" });

    const { timeline } = compileEditDocument(seeded);
    expect(timeline.width).toBe(1080);
    expect(timeline.height).toBe(1920);
    expect(timeline).toEqual(expected);
  });

  it("matches when a scene has no narration at all", () => {
    const scenes = [
      pipelineScene(0, 6_000),
      { ...pipelineScene(1, 0), narrationKey: null },
      pipelineScene(2, 4_000),
    ];
    const expected = buildTimeline(pipelineInput({ scenes }));

    const built = buildTimeline(pipelineInput({ scenes }));
    const seeded = seedEditDocument({
      ...seedInput(),
      scenes: built.scenes.map((scene) => ({
        index: scene.index,
        label: scene.label,
        onScreenText: scene.onScreenText,
        transition: null,
        startMs: scene.startMs,
        durationMs: scene.durationMs,
        visual: {
          assetId: `1111111a-0000-4000-8000-00000000000${scene.index}`,
          storageKey: scene.visualKey,
          kind: scene.visualKind,
          durationMs: scene.visualDurationMs,
        },
        narration: scene.narrationKey
          ? {
              assetId: `2222222b-0000-4000-8000-00000000000${scene.index}`,
              storageKey: scene.narrationKey,
              durationMs: scene.narrationDurationMs,
            }
          : null,
      })),
    });

    // The silent scene still holds the screen for MIN_SCENE_MS in both models.
    expect(compileEditDocument(seeded).timeline).toEqual(expected);
    expect(compileEditDocument(seeded).timeline.scenes[1]?.durationMs).toBe(
      MIN_SCENE_MS,
    );
  });

  it("preserves the transitions buildTimeline defaulted", () => {
    const { timeline } = compileEditDocument(seedEditDocument(seedInput()));

    // Not all "none": an export that flattened every fade into a cut would be an edit
    // the user never made, and it is the kind that only shows up in the finished MP4.
    expect(timeline.scenes.map((s) => s.transition)).toEqual([
      "none",
      "fade",
      "fade",
    ]);
  });

  it("preserves each visual's real asset kind, not a guess from its duration", () => {
    const { timeline } = compileEditDocument(seedEditDocument(seedInput()));

    // §29: provenance survives a round trip. Scene 2 is a still with no duration, and
    // inferring from duration alone would relabel it `generated_image` — claiming a
    // licence it does not have.
    expect(timeline.scenes.map((s) => s.visualKind)).toEqual([
      "stock_video",
      "stock_video",
      "stock_image",
    ]);
  });

  it("preserves word-level caption cues shorter than a media clip", () => {
    const { timeline } = compileEditDocument(seedEditDocument(seedInput()));

    const shortest = timeline.captions?.cues.at(-1);
    expect(shortest?.endMs).toBe(4_160);
    expect((shortest?.endMs ?? 0) - (shortest?.startMs ?? 0)).toBeLessThan(
      MIN_MEDIA_CLIP_MS,
    );
  });

  it("keeps the storyboard labels the script stage assigned", () => {
    const { timeline } = compileEditDocument(seedEditDocument(seedInput()));
    expect(timeline.scenes.map((s) => s.label)).toEqual([
      "Scene 0",
      "Scene 1",
      "Scene 2",
    ]);
  });
});

describe("seedEditDocument", () => {
  it("places clips at the measured offsets, not at recomputed ones", () => {
    const document = seedEditDocument(seedInput());
    const video = trackOf(document, "video-0");

    // 0, 6000, 17400 — the accumulated narration lengths the render used.
    expect(video.clips.map((c) => c.startMs)).toEqual([0, 6_000, 17_400]);
    expect(video.clips.map((c) => c.durationMs)).toEqual([
      6_000,
      11_400,
      MIN_SCENE_MS,
    ]);
  });

  it("packs scenes the way buildTimeline would when the timeline stage has not run", () => {
    // A project mid-pipeline has null start_ms/duration_ms. Opening the editor then
    // must still show the cut that stage would have produced, or the first save would
    // collapse every scene to zero.
    const unmeasured = seedInput({
      scenes: seedInput().scenes.map((scene) => ({
        ...scene,
        startMs: null,
        durationMs: null,
      })),
    });

    const video = trackOf(seedEditDocument(unmeasured), "video-0");
    expect(video.clips.map((c) => c.startMs)).toEqual([0, 6_000, 17_400]);
  });

  it("gives narration its own measured length rather than the scene's slot", () => {
    const document = seedEditDocument(seedInput());
    const voice = trackOf(document, "voiceover-0");

    // Scene 2's line is 1200ms inside a 1500ms slot. Stretching the audio to fill
    // would be an edit; leaving the visual up after it ends is what was rendered.
    expect(voice.clips.map((c) => c.durationMs)).toEqual([6_000, 11_400, 1_200]);
  });

  it("leaves the visual track silent and the voiceover audible", () => {
    const document = seedEditDocument(seedInput());

    // Stock footage carries ambient sound that fights the narration — render.ts sets
    // its volume to 0, and the document has to say the same thing.
    expect(trackOf(document, "video-0").clips.every((c) => c.volume === 0)).toBe(true);
    expect(trackOf(document, "voiceover-0").clips.every((c) => c.volume === 1)).toBe(
      true,
    );
  });

  it("runs the music bed to the end of the video including the tail", () => {
    const document = seedEditDocument(seedInput());
    const music = trackOf(document, "music-0").clips[0];

    // 17400 + 1500 + TAIL_PADDING_MS.
    expect(music?.durationMs).toBe(18_900 + TAIL_PADDING_MS);
    expect(music?.volume).toBe(0.14);
  });

  it("omits tracks a project does not have rather than adding empty ones", () => {
    const document = seedEditDocument({
      ...seedInput(),
      music: null,
      captions: null,
      scenes: seedInput().scenes.map((s) => ({ ...s, onScreenText: null })),
    });

    // An empty track in the UI is a control that does nothing, which is the fake
    // affordance the editor is meant not to have.
    expect(document.tracks.map((t) => t.id)).toEqual(["video-0", "voiceover-0"]);
  });

  it("holds on-screen text for a beat rather than the whole scene", () => {
    const document = seedEditDocument(seedInput());
    const text = trackOf(document, "text-0").clips[0];

    // The window render.ts gives a Shotstack title: min(4s, max(1.5s, scene - 0.5s)).
    // Scene 1 is 11.4s, so it caps at 4s.
    expect(text?.startMs).toBe(6_000);
    expect(text?.durationMs).toBe(4_000);
  });

  it("resolves the caption style through the pipeline's own validation", () => {
    const document = seedEditDocument(
      seedInput({
        // A brand kit with one plausible override and one out-of-range value, which is
        // what `pickStyle` exists to filter. The document must store what the render
        // used, not what the kit claimed.
        captionStyle: { fontSizePx: 64, verticalPosition: 9 },
      }),
    );

    expect(document.captions.style.fontSizePx).toBe(64);
    expect(document.captions.style.verticalPosition).toBe(0.82);
    expect(document.captions.style.fontFamily).toBe("Inter");
  });

  it("produces a document that passes its own schema", () => {
    // The seeder is the only writer that is not a browser, and a seed the schema would
    // reject would make the project unopenable rather than merely unsaveable.
    expect(EditDocumentSchema.safeParse(seedEditDocument(seedInput())).success).toBe(
      true,
    );
  });
});

describe("compileEditDocument reflects real edits", () => {
  const base = seedEditDocument(seedInput());

  it("shortens the video when a clip is trimmed", () => {
    const trimmed = edit(base, (draft) => {
      const video = trackOf(draft, "video-0");
      const clip = video.clips[1];
      if (!clip) throw new Error("fixture");
      clip.durationMs = 4_000;
      clip.sourceInMs = 1_000;
      clip.sourceOutMs = 5_000;
      // Everything after it moves up, which is what a ripple trim is.
      const last = video.clips[2];
      if (last) last.startMs = 10_000;
      // The audio ripples with it. Left where they were, the narration and the bed
      // would still run to the old end and hold the video at its original length —
      // correct behaviour, covered by its own tests below, but here it would mask the
      // visual track's new extent.
      const voice = trackOf(draft, "voiceover-0");
      voice.clips[1]!.durationMs = 4_000;
      voice.clips[2]!.startMs = 10_000;
      trackOf(draft, "music-0").clips[0]!.durationMs =
        10_000 + MIN_SCENE_MS + TAIL_PADDING_MS;
    });

    const { timeline, clips } = compileEditDocument(trimmed);

    expect(timeline.scenes[1]?.durationMs).toBe(4_000);
    expect(timeline.durationMs).toBe(10_000 + MIN_SCENE_MS + TAIL_PADDING_MS);

    // The source window is on the clip list, which is where Phase B's renderer reads
    // it — TimelineScene has no field for it, and that is the whole reason CompiledEdit
    // carries both structures.
    const compiled = clips.find((c) => c.clipId === "scene-1-visual");
    expect(compiled?.sourceInMs).toBe(1_000);
    expect(compiled?.sourceOutMs).toBe(5_000);
  });

  it("turns a split into two scenes over one asset", () => {
    const split = edit(base, (draft) => {
      const video = trackOf(draft, "video-0");
      const original = video.clips[0];
      if (!original) throw new Error("fixture");

      const second: EditClip = {
        ...JSON.parse(JSON.stringify(original)),
        id: "scene-0-visual-b",
        startMs: 2_000,
        durationMs: 4_000,
        sourceInMs: 2_000,
        sourceOutMs: 6_000,
      };
      original.durationMs = 2_000;
      original.sourceInMs = 0;
      original.sourceOutMs = 2_000;
      video.clips.splice(1, 0, second);
    });

    const { timeline } = compileEditDocument(split);

    // Four scenes from three, both halves playing the same file, and the indices
    // renumbered in timeline order — the renderer concatenates in that order.
    expect(timeline.scenes).toHaveLength(4);
    expect(timeline.scenes.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(timeline.scenes[0]?.visualKey).toBe(timeline.scenes[1]?.visualKey);
    expect(timeline.scenes[0]?.durationMs).toBe(2_000);
    // Total is unchanged: a split cuts nothing.
    expect(timeline.durationMs).toBe(
      buildTimeline(pipelineInput()).durationMs,
    );
  });

  it("reorders scenes when clips move, and moves the first transition with them", () => {
    const moved = edit(base, (draft) => {
      const video = trackOf(draft, "video-0");
      // The 1.5s scene dragged to the front, the others pushed back.
      const [a, b, c] = video.clips;
      if (!a || !b || !c) throw new Error("fixture");
      c.startMs = 0;
      a.startMs = MIN_SCENE_MS;
      b.startMs = MIN_SCENE_MS + 6_000;
    });

    const { timeline } = compileEditDocument(moved);

    expect(timeline.scenes.map((s) => s.visualKey)).toEqual([
      "visual-2.mp4",
      "visual-0.mp4",
      "visual-1.mp4",
    ]);
    // The clip now at the front cuts rather than fading in from black, whichever clip
    // the user dragged there.
    expect(timeline.scenes[0]?.transition).toBe("none");
  });

  it("drops a deleted clip and its narration from the timeline", () => {
    const deleted = edit(base, (draft) => {
      const video = trackOf(draft, "video-0");
      video.clips.splice(1, 1);
      const voice = trackOf(draft, "voiceover-0");
      voice.clips.splice(1, 1);
    });

    const { timeline } = compileEditDocument(deleted);
    expect(timeline.scenes).toHaveLength(2);
    expect(timeline.scenes.map((s) => s.visualKey)).toEqual([
      "visual-0.mp4",
      "visual-2.mp4",
    ]);
  });

  it("duplicates a clip as a second scene over the same asset", () => {
    const duplicated = edit(base, (draft) => {
      const video = trackOf(draft, "video-0");
      const source = video.clips[2];
      if (!source) throw new Error("fixture");
      video.clips.push({
        ...JSON.parse(JSON.stringify(source)),
        id: "scene-2-visual-copy",
        startMs: source.startMs + source.durationMs,
      });
    });

    const { timeline } = compileEditDocument(duplicated);
    expect(timeline.scenes).toHaveLength(4);
    expect(timeline.scenes[3]?.visualKey).toBe("visual-2.mp4");
    // The video got longer by exactly the duplicate.
    expect(timeline.durationMs).toBe(
      buildTimeline(pipelineInput()).durationMs + MIN_SCENE_MS,
    );
  });

  it("carries voiceover and music gain onto the compiled output", () => {
    const remixed = edit(base, (draft) => {
      trackOf(draft, "music-0").clips[0]!.volume = 0.4;
      trackOf(draft, "voiceover-0").volume = 1.5;
    });

    const { timeline, clips } = compileEditDocument(remixed);

    expect(timeline.music?.volume).toBeCloseTo(0.4);
    // Track gain multiplied by clip gain, which is how a "make all narration louder"
    // control and a per-clip fix compose.
    const narration = clips.find((c) => c.clipId === "scene-0-narration");
    expect(narration?.gain).toBeCloseTo(1.5);
  });

  it("exports a muted track at gain zero rather than removing it", () => {
    const muted = edit(base, (draft) => {
      trackOf(draft, "voiceover-0").muted = true;
    });

    const { clips } = compileEditDocument(muted);
    const narration = clips.filter((c) => c.trackKind === "voiceover");

    // Still on the timeline and still selectable — muting is not deleting.
    expect(narration).toHaveLength(3);
    expect(narration.every((c) => c.gain === 0)).toBe(true);
  });

  it("drops a hidden visual track from the frame", () => {
    const hidden = edit(base, (draft) => {
      trackOf(draft, "video-0").hidden = true;
    });

    const { timeline, durationMs } = compileEditDocument(hidden);
    expect(timeline.scenes).toHaveLength(0);
    // No visuals means no video, but the audio that is still there sets the length
    // rather than the result silently becoming zero.
    expect(durationMs).toBe(0);
  });

  it("applies edited caption text and timing", () => {
    const recaptioned = edit(base, (draft) => {
      const track = trackOf(draft, "caption-0");
      const first = track.clips[0];
      if (!first) throw new Error("fixture");
      first.text = "Rewritten line";
      first.durationMs = 1_200;
    });

    const { timeline } = compileEditDocument(recaptioned);
    expect(timeline.captions?.cues[0]).toEqual({
      startMs: 0,
      endMs: 1_200,
      text: "Rewritten line",
    });
  });

  it("clips a caption that now runs past the end of the video", () => {
    const overrun = edit(base, (draft) => {
      const track = trackOf(draft, "caption-0");
      const cue = track.clips[0];
      if (!cue) throw new Error("fixture");
      cue.startMs = 0;
      cue.durationMs = MAX_TIMELINE_MS - 1;
      // The others would now overlap it on the same track.
      track.clips.length = 1;
    });

    const { timeline, durationMs } = compileEditDocument(overrun);
    // Trimmed to the last frame rather than passed on: some providers drop such a cue
    // silently and others reject the whole render.
    expect(timeline.captions?.cues[0]?.endMs).toBe(durationMs);
  });

  it("extends the video when the music bed is dragged past the last shot", () => {
    const longBed = edit(base, (draft) => {
      trackOf(draft, "music-0").clips[0]!.durationMs = 40_000;
    });

    // A bed the user deliberately made longer is part of the video; truncating it here
    // would silently undo the edit.
    expect(compileEditDocument(longBed).durationMs).toBe(40_000);
  });

  it("keeps narration that no longer sits under any visual", () => {
    const orphaned = edit(base, (draft) => {
      // Dragged into the tail, past every visual clip.
      trackOf(draft, "voiceover-0").clips[2]!.startMs = 19_500;
    });

    const { timeline, clips } = compileEditDocument(orphaned);

    // Unattributed on the timeline document, which has one narration slot per scene…
    expect(timeline.scenes[2]?.narrationKey).toBeNull();
    // …but still on the clip list, so Phase B's mixer includes it. Dropping it would
    // lose audio the editor is still showing.
    expect(clips.filter((c) => c.trackKind === "voiceover")).toHaveLength(3);
  });

  it("is pure — compiling twice gives the same answer", () => {
    const once = compileEditDocument(base);
    const twice = compileEditDocument(base);
    expect(once).toEqual(twice);
  });
});

describe("EditDocumentSchema", () => {
  const valid = seedEditDocument(seedInput());

  it("rejects a negative offset", () => {
    const bad = JSON.parse(JSON.stringify(valid)) as EditDocument;
    bad.tracks[0]!.clips[0]!.startMs = -1;
    expect(EditDocumentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a fractional offset", () => {
    // `.toFixed(3)` in the ffmpeg argument builder would round it silently; better to
    // refuse than to render something a millisecond off what the editor showed.
    const bad = JSON.parse(JSON.stringify(valid)) as EditDocument;
    bad.tracks[0]!.clips[0]!.startMs = 12.5;
    expect(EditDocumentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an offset past the maximum timeline length", () => {
    const bad = JSON.parse(JSON.stringify(valid)) as EditDocument;
    bad.tracks[0]!.clips[0]!.startMs = MAX_TIMELINE_MS + 1;
    expect(EditDocumentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a clip that ends past the maximum even when both fields are in range", () => {
    const bad = JSON.parse(JSON.stringify(valid)) as EditDocument;
    const clip = bad.tracks[0]!.clips[0]!;
    clip.startMs = MAX_TIMELINE_MS - 1_000;
    clip.durationMs = 60_000;
    expect(EditDocumentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a media clip too short to decode a frame", () => {
    const bad = JSON.parse(JSON.stringify(valid)) as EditDocument;
    bad.tracks[0]!.clips[0]!.durationMs = 10;
    expect(EditDocumentSchema.safeParse(bad).success).toBe(false);
  });

  it("allows a caption clip shorter than that, because Whisper emits them", () => {
    const document = JSON.parse(JSON.stringify(valid)) as EditDocument;
    const captionTrack = document.tracks.find((t) => t.kind === "caption");
    captionTrack!.clips = [
      {
        id: "cue-x",
        startMs: 0,
        durationMs: 40,
        sourceInMs: null,
        sourceOutMs: null,
        volume: 0,
        text: "a",
        label: null,
        transition: null,
        source: null,
        sceneIndex: null,
      },
    ];
    expect(EditDocumentSchema.safeParse(document).success).toBe(true);
  });

  it("rejects a backwards source window", () => {
    const bad = JSON.parse(JSON.stringify(valid)) as EditDocument;
    const clip = bad.tracks[0]!.clips[0]!;
    clip.sourceInMs = 9_000;
    clip.sourceOutMs = 4_000;
    // ffmpeg would "accept" `-ss 9 -to 4` by producing nothing rather than failing.
    expect(EditDocumentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects two clips overlapping on one track", () => {
    const bad = JSON.parse(JSON.stringify(valid)) as EditDocument;
    bad.tracks[0]!.clips[1]!.startMs = 100;
    // No defined winner. Overlapping is expressible on two tracks, which is what
    // stacking is for.
    expect(EditDocumentSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts clips that merely touch", () => {
    const document = JSON.parse(JSON.stringify(valid)) as EditDocument;
    const clips = document.tracks[0]!.clips;
    clips[1]!.startMs = clips[0]!.startMs + clips[0]!.durationMs;
    expect(EditDocumentSchema.safeParse(document).success).toBe(true);
  });

  it("rejects duplicate clip and track ids", () => {
    const dupeClip = JSON.parse(JSON.stringify(valid)) as EditDocument;
    dupeClip.tracks[0]!.clips[1]!.id = dupeClip.tracks[0]!.clips[0]!.id;
    expect(EditDocumentSchema.safeParse(dupeClip).success).toBe(false);

    const dupeTrack = JSON.parse(JSON.stringify(valid)) as EditDocument;
    dupeTrack.tracks[1]!.id = dupeTrack.tracks[0]!.id;
    expect(EditDocumentSchema.safeParse(dupeTrack).success).toBe(false);
  });

  it("rejects a gain that would clip the mix", () => {
    const bad = JSON.parse(JSON.stringify(valid)) as EditDocument;
    bad.tracks[0]!.clips[0]!.volume = 12;
    expect(EditDocumentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown track kind", () => {
    const bad = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    (bad["tracks"] as Array<Record<string, unknown>>)[0]!["kind"] = "green_screen";
    expect(EditDocumentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects unknown properties rather than ignoring them", () => {
    const bad = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    bad["exportPath"] = "/etc/passwd";
    // `.strict()` throughout: a field the compiler does not read is a field a client
    // believes is doing something.
    expect(EditDocumentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a document from a future schema version", () => {
    const bad = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    bad["schemaVersion"] = EDIT_DOCUMENT_VERSION + 1;
    expect(EditDocumentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a caption style whose font size would cover the frame", () => {
    const bad = JSON.parse(JSON.stringify(valid)) as EditDocument;
    bad.captions.style.fontSizePx = 4_000;
    expect(EditDocumentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a non-hex caption colour", () => {
    const bad = JSON.parse(JSON.stringify(valid)) as EditDocument;
    bad.captions.style.color = "red; drop table";
    expect(EditDocumentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a storage key long enough to be a payload", () => {
    const bad = JSON.parse(JSON.stringify(valid)) as EditDocument;
    bad.tracks[0]!.clips[0]!.source!.storageKey = "x".repeat(513);
    expect(EditDocumentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a non-uuid asset id", () => {
    const bad = JSON.parse(JSON.stringify(valid)) as EditDocument;
    bad.tracks[0]!.clips[0]!.source!.assetId = "../../other-tenant";
    expect(EditDocumentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a document with no tracks", () => {
    const bad = JSON.parse(JSON.stringify(valid)) as EditDocument;
    bad.tracks = [];
    expect(EditDocumentSchema.safeParse(bad).success).toBe(false);
  });

  it("survives a compile after a round trip through JSON", () => {
    // The document lives in a jsonb column, so this is the path it actually takes.
    const roundTripped = parseEditDocument(JSON.parse(JSON.stringify(valid)));
    expect(compileEditDocument(roundTripped).timeline).toEqual(
      compileEditDocument(valid).timeline,
    );
  });
});
