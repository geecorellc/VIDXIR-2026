/**
 * The continuity validator and its score (§11, §12).
 *
 * Deterministic, in the strong sense `research/scoring.ts` established: pure
 * functions over plain structs, no clock, no randomness, no provider call. The
 * same scene plan scores the same number every time, on every machine. That is
 * what makes the threshold in `config.ts` a decision rather than a guess, and it
 * is what lets a test pin the arithmetic.
 *
 * What it can and cannot check is worth being exact about, because the honest
 * version of this is more useful than an ambitious one:
 *
 *  - It **can** check that a scene's prompt actually carries the constraints its
 *    state committed to, that entity references resolve, that established state is
 *    respected, and that shots are not repeated. All of these are properties of the
 *    plan, and the plan is text.
 *  - It **cannot** check the rendered frames. There is no vision capability in the
 *    repository — no image analysis, no frame comparison — so a model that was
 *    given "brown coat" and drew a blue one is invisible here. The score never
 *    claims otherwise, and the finding codes say `prompt` where they mean prompt.
 *
 * Six components, per §12, each 0–100, combined by fixed weights.
 */

import {
  findCharacter,
  findEnvironment,
  findProp,
  hasCanonicalVoice,
  hasStyle,
  type StoryBible,
} from "@/lib/continuity/bible";
import type { ContinuityThresholds, LevelCapabilities } from "@/lib/continuity/config";
import {
  actionableRepetitions,
  findRepetitions,
  type RepetitionFinding,
  type SceneVisual,
} from "@/lib/continuity/duplicate";
import {
  changesBefore,
  type IndexedSceneState,
  type SceneStateGraph,
} from "@/lib/continuity/scene-state";
import {
  assignSceneVoice,
  leadCharacterFor,
  sameVoice,
  usesCharacterVoices,
  wasVoiced,
  type SceneVoiceRecord,
} from "@/lib/continuity/voice";

/**
 * Severity, matching `quality_checks.findings` exactly.
 *
 * Not a new vocabulary: the findings this produces are written to the existing
 * `qualityChecks` table and read by the existing dashboard reader, so the shape is
 * that table's shape.
 */
export type FindingSeverity = "info" | "warn" | "fail";

export interface ContinuityIssue {
  /** Stable machine code, e.g. `continuity.character.missing_constraint`. */
  code: string;
  severity: FindingSeverity;
  message: string;
  detail?: string;
  /** Scene this concerns, or null for a whole-video issue. */
  sceneIndex: number | null;
  /** Bible entity this concerns, or null. */
  entityId: string | null;
}

/** The six components §12 names. Each 0–100, higher is better. */
export interface ContinuityComponents {
  characterConsistency: number;
  environmentConsistency: number;
  propContinuity: number;
  storyContinuity: number;
  styleConsistency: number;
  /** Inverted, like the others: 100 means no unwanted repetition. */
  duplicateRisk: number;
}

export type ContinuityStatus = "pass" | "warn" | "fail";

export interface ContinuityReport {
  /** 0–100, integer. */
  score: number;
  status: ContinuityStatus;
  components: ContinuityComponents;
  issues: readonly ContinuityIssue[];
  /** Scenes with at least one `fail` issue — the regeneration candidates. */
  affectedScenes: readonly number[];
  /** Bible entities named by at least one issue. */
  affectedEntities: readonly string[];
  repetitions: readonly RepetitionFinding[];
}

/**
 * Component weights.
 *
 * Characters carry the most because a face changing is what a viewer notices
 * first; style is next because it is present in every frame. `duplicateRisk` is
 * weighted low — repetition is a quality problem rather than a continuity break,
 * and it is the component most likely to be a false positive given the textual
 * comparison behind it.
 *
 * Components a level does not ask for are excluded and their weight redistributed,
 * so a `style`-level video is not marked down for having no cast.
 */
const WEIGHTS: Record<keyof ContinuityComponents, number> = {
  characterConsistency: 30,
  environmentConsistency: 15,
  propContinuity: 10,
  storyContinuity: 15,
  styleConsistency: 20,
  duplicateRisk: 10,
};

export interface ValidateInput {
  bible: StoryBible;
  states: readonly IndexedSceneState[];
  graph: SceneStateGraph;
  capabilities: LevelCapabilities;
  thresholds: ContinuityThresholds;
  /**
   * The prompt each scene was actually built with, and its search terms.
   *
   * The prompt as *sent*, not as planned: this is what checks that the continuity
   * block survived into the request. Passing the pre-continuity prompt here would
   * make the check pass for a bug that dropped it.
   */
  visuals: readonly SceneVisual[];
  /**
   * The voice each scene's narration was actually synthesised in.
   *
   * Optional, and absent is the ordinary case: a project whose cast carries no
   * canonical voices has no voice contract, and every project built before voice
   * continuity existed has no record to read. When omitted, the voice check still
   * reports a character who *should* have a voice and does not — that is a property
   * of the bible — but cannot report drift, because drift is a claim about audio
   * that was produced.
   *
   * The voice as *used*, for the same reason `visuals` is the prompt as sent:
   * recomputing the assignment from the current bible would compare the bible with
   * itself and pass even if the voiceover stage had ignored it entirely.
   */
  voices?: readonly SceneVoiceRecord[];
}

/**
 * Validate a scene plan against its bible.
 *
 * Every component starts at 100 and loses points for concrete findings, which is
 * the same shape as `research/scoring.ts` and has the same property: a video with
 * nothing wrong scores 100 without needing a model to agree that it is good.
 */
export function validateContinuity(input: ValidateInput): ContinuityReport {
  const issues: ContinuityIssue[] = [];
  const visualBy = new Map(input.visuals.map((v) => [v.sceneIndex, v]));

  /**
   * Appearance and voice are one component, not two.
   *
   * Both are answers to "is this the same character as last time", and §12 fixes the
   * six components and their weights. A seventh would force every existing weight to
   * be re-decided, and would score a video with no character voices out of a
   * denominator it cannot contribute to. Combining the tallies instead means a
   * project without voices deducts exactly what it deducted before, and a project
   * with them treats a wrong voice as the same order of break as a wrong coat —
   * which, to a viewer, it is.
   */
  const appearance = checkCharacters(input, visualBy, issues);
  const voice = checkVoices(input, issues);
  const character = penalise(
    100,
    appearance.misses + voice.misses,
    appearance.expected + voice.expected,
    100,
  );

  const environment = checkEnvironments(input, visualBy, issues);
  const props = checkProps(input, visualBy, issues);
  const story = checkStory(input, issues);
  const style = checkStyle(input, issues);

  const repetitions = input.capabilities.duplicates
    ? findRepetitions({
        visuals: input.visuals,
        states: input.states,
        thresholds: input.thresholds,
      })
    : [];

  const duplicates = actionableRepetitions(repetitions);
  for (const finding of duplicates) {
    issues.push({
      code: "continuity.duplicate.shot",
      severity: "fail",
      message: finding.reason,
      detail: `Similarity ${finding.similarity.toFixed(3)}.`,
      sceneIndex: finding.sceneIndex,
      entityId: null,
    });
  }
  for (const finding of repetitions.filter((f) => f.classification === "suspicious")) {
    issues.push({
      code: "continuity.duplicate.suspected",
      severity: "warn",
      message: finding.reason,
      detail: `Similarity ${finding.similarity.toFixed(3)}.`,
      sceneIndex: finding.sceneIndex,
      entityId: null,
    });
  }

  const sceneCount = Math.max(1, input.visuals.length);
  const components: ContinuityComponents = {
    characterConsistency: character,
    environmentConsistency: environment,
    propContinuity: props,
    storyContinuity: story,
    styleConsistency: style,
    duplicateRisk: penalise(100, duplicates.length, sceneCount, 100),
  };

  const score = combine(components, input.capabilities);
  const status = statusFor(score, input.thresholds);

  /**
   * The regeneration candidates — failed scenes a regeneration could actually fix.
   *
   * Voice failures are excluded, and this is the one place it matters that they are.
   * `scenesToRegenerate` reads this list and `executeSceneRegeneration` regenerates a
   * scene's **visual**; re-drawing a shot cannot change which voice narrated it, so a
   * voice mismatch here would spend a paid image generation on a problem it has no
   * bearing on. §22's spirit: continuity is a quality feature, and one that quietly
   * bills for work that cannot help is worse than one that reports and waits.
   *
   * The findings themselves are untouched and still `fail`, so the panel, the verdict
   * and the score all treat a wrong voice as the break it is. What changes is only what
   * gets automatically re-billed; each voice finding's `detail` names the action that
   * does fix it, which is a rebuild.
   */
  const affectedScenes = [
    ...new Set(
      issues
        .filter(
          (issue) =>
            issue.severity === "fail" &&
            issue.sceneIndex !== null &&
            !isVoiceCode(issue.code),
        )
        .map((issue) => issue.sceneIndex as number),
    ),
  ].sort((a, b) => a - b);

  const affectedEntities = [
    ...new Set(
      issues
        .filter((issue) => issue.entityId !== null)
        .map((issue) => issue.entityId as string),
    ),
  ].sort();

  return {
    score,
    status,
    components,
    issues,
    affectedScenes,
    affectedEntities,
    repetitions,
  };
}

// ---------------------------------------------------------------------------
// Component checks
// ---------------------------------------------------------------------------

type VisualIndex = ReadonlyMap<number, SceneVisual>;

/**
 * Codes a *visual* regeneration cannot fix.
 *
 * A prefix test rather than a list of three, so a voice finding added later is
 * excluded from the regeneration set by default rather than by remembering to.
 *
 * Exported because the exclusion has to hold in two places, and only one of them is
 * in this module. `affectedScenes` and `issuesForScene` decide what a *fresh* report
 * regenerates; `executeSceneRegeneration` re-reads the findings back out of
 * `quality_checks` and rebuilds a prompt from them, so it needs the same predicate.
 * A second copy of "starts with continuity.voice." in the pipeline would be the
 * obvious way for the two to drift apart.
 */
export const VOICE_CODE_PREFIX = "continuity.voice.";

export function isVoiceCode(code: string): boolean {
  return code.startsWith(VOICE_CODE_PREFIX);
}

/**
 * A check's raw tally, before it becomes a score.
 *
 * Returned instead of a component value by the two checks that share one component,
 * so the deduction is computed once over both tallies rather than by averaging two
 * scores — which would let a video with one voiced scene and eighty broken ones
 * score the same as the reverse.
 */
interface Tally {
  expected: number;
  misses: number;
}

/**
 * Does each scene's prompt carry the appearance facts its character needs?
 *
 * The check that catches the failure mode this layer exists for: a scene state
 * says Mara is present, the bible says Mara wears a brown coat, and the prompt
 * that went to the provider mentions neither. That scene will draw a different
 * Mara, and no amount of instruction elsewhere prevents it.
 *
 * Matching is on the character's *name* plus at least one distinguishing fact. Name
 * alone is not enough — a generator has never heard of Mara — and requiring every
 * fact would fail on the truncation `buildContinuityPrompt` legitimately performs.
 */
function checkCharacters(
  input: ValidateInput,
  visuals: VisualIndex,
  issues: ContinuityIssue[],
): Tally {
  if (!input.capabilities.characters) return { expected: 0, misses: 0 };

  let expected = 0;
  let missing = 0;

  for (const entry of ordered(input.states)) {
    const visual = visuals.get(entry.sceneIndex);

    for (const id of entry.state.characters) {
      const character = findCharacter(input.bible, id);

      if (!character) {
        issues.push({
          code: "continuity.character.unknown",
          severity: "warn",
          message: `Scene ${entry.sceneIndex} references a character that is not in the story bible.`,
          detail: `Character id: ${id}.`,
          sceneIndex: entry.sceneIndex,
          entityId: id,
        });
        continue;
      }

      const facts = [...character.appearance, ...character.wardrobe];
      if (facts.length === 0) continue;

      expected += 1;

      const prompt = (visual?.visualPrompt ?? "").toLowerCase();
      const named = prompt.includes(character.name.toLowerCase());
      const described = facts.some((fact) => containsFact(prompt, fact));

      if (!named || !described) {
        missing += 1;
        issues.push({
          code: "continuity.character.missing_constraint",
          severity: "fail",
          message:
            `Scene ${entry.sceneIndex} features ${character.name} but its prompt does not ` +
            "carry that character's fixed appearance.",
          detail: named
            ? `None of ${facts.length} appearance facts appear in the prompt.`
            : `The name "${character.name}" does not appear in the prompt.`,
          sceneIndex: entry.sceneIndex,
          entityId: character.id,
        });
      }
    }
  }

  return { expected, misses: missing };
}

/**
 * Is each scene spoken in the voice its character is established with?
 *
 * The audio half of character consistency, and the same kind of claim as the visual
 * half — a comparison of opaque ids, not an opinion about audio. What it can and
 * cannot see is worth stating as plainly as the module docblock does for frames:
 *
 *  - It **can** check that a scene led by a character with a canonical voice was
 *    synthesised with *that* voice id, that a scene's voice did not change between
 *    the assignment and the request, and that the same character was not voiced two
 *    different ways across a video. All three are string comparisons over recorded
 *    facts.
 *  - It **cannot** hear the audio. A provider that returned the wrong voice for a
 *    correct id is invisible here, and no finding claims otherwise.
 *
 * Three findings, per the mandate's vocabulary:
 *
 *  - `continuity.voice.missing` — a character with no canonical voice in a project
 *    that uses them. A `warn`: the project voice narrated the scene, which is what
 *    Tally has always done, so it is a gap rather than a break.
 *  - `continuity.voice.drift` — one character voiced two different ways across the
 *    video. A `fail`: this is the failure the feature exists to prevent.
 *  - `continuity.voice.assignment_mismatch` — the voice used is not the voice the
 *    bible names. A `fail`: something between the bible and the provider changed the
 *    decision.
 *
 * A `fail` here is deliberately **not** a regeneration trigger the way a visual
 * failure is: `executeSceneRegeneration` regenerates a scene's *visual* and never
 * re-synthesises audio. See `scenesToRegenerate`, which filters on the scenes a visual
 * regeneration can fix, and `isVoiceCode`, which keeps these codes out of the prompt a
 * regeneration is built from.
 *
 * So the outcome is a recorded finding, and the action each one names is a **rebuild**.
 * Not a voiceover re-run: the voiceover stage chains into visuals, and its segment
 * durations are what the timeline, the captions and the render are built from, so there
 * is no audio-only path to offer and the findings do not pretend there is. A rebuild is
 * a real fix rather than a shrug, because `sceneVoicesFor` resolves the assignment from
 * the bible deterministically on every run — correcting the bible is enough.
 */
function checkVoices(input: ValidateInput, issues: ContinuityIssue[]): Tally {
  if (!input.capabilities.characters) return { expected: 0, misses: 0 };

  /**
   * A project whose cast carries no canonical voices is not checked at all.
   *
   * §25's requirement in one line: every project built before voice continuity
   * existed, and every project whose owner has not assigned a voice, scores exactly
   * what it scored before — an empty tally deducts nothing.
   */
  if (!usesCharacterVoices(input.bible)) return { expected: 0, misses: 0 };

  const recorded = new Map(
    (input.voices ?? []).map((record) => [record.sceneIndex, record]),
  );

  let expected = 0;
  let misses = 0;

  /**
   * The voice each character was first heard in, and where.
   *
   * The audio counterpart of `graph.establishedBy`: the first scene to voice a
   * character defines what the rest of the video has to match, so a later scene that
   * differs is the one at fault. Built from the records rather than the bible, so
   * this catches a video whose scenes disagree with each other even when every one
   * of them disagrees with the bible in the same way.
   */
  const heardAs = new Map<string, { voiceId: string; sceneIndex: number }>();

  for (const entry of ordered(input.states)) {
    const leadId = leadCharacterFor(entry.state);
    if (!leadId) continue;

    const assignment = assignSceneVoice(
      {
        bible: input.bible,
        states: input.states,
        capabilities: input.capabilities,
      },
      entry.sceneIndex,
    );

    if (assignment.source === "project" && assignment.characterName !== null) {
      /**
       * A named character in the bible with no voice of their own.
       *
       * Counted once per scene they lead, because that is how many scenes are
       * narrated by a voice nobody chose for them — and reported per scene so the
       * panel can say which. `warn`, not `fail`: nothing is broken, and the
       * fallback is the behaviour this project had yesterday.
       */
      expected += 1;
      misses += 1;
      issues.push({
        code: "continuity.voice.missing",
        severity: "warn",
        message:
          `Scene ${entry.sceneIndex} is led by ${assignment.characterName}, who has no ` +
          "canonical voice, so the project's voice narrated it.",
        detail:
          "Other characters in this story bible have canonical voices, so this one " +
          "will not sound consistent with them.",
        sceneIndex: entry.sceneIndex,
        entityId: assignment.characterId,
      });
      continue;
    }

    if (assignment.source !== "character" || assignment.providerVoiceId === null) {
      // No voice contract for this scene — an unknown character id, or a level that
      // does not track them. Reported elsewhere, or not a finding at all.
      continue;
    }

    expected += 1;

    const record = recorded.get(entry.sceneIndex);
    if (!record) {
      /**
       * No record of what this scene was voiced with.
       *
       * Not a finding. A project checked before its voiceover ran, or one built
       * before voice records were kept, has nothing to compare — and inventing a
       * break out of an absent measurement is exactly what §42 forbids. The scene
       * still counts towards `expected`, so a video with a full contract and no
       * records at all does not read as perfectly consistent.
       */
      continue;
    }

    if (!wasVoiced(record) || record.providerVoiceId === null) {
      // A silent scene — a title card. Legitimately has no voice.
      continue;
    }

    const usedVoiceId = record.providerVoiceId;

    /**
     * Two independent questions about the same scene, asked in this order.
     *
     * `mismatch` compares the audio with the *contract* — the bible. `drift` compares
     * it with the rest of the *video* — what this character was first heard as. They
     * are not the same question, and neither subsumes the other:
     *
     *  - Every scene voiced with the wrong id, consistently, is a mismatch on each and
     *    a drift on none. The video is internally consistent and disobeys the bible.
     *  - A voiceover run half-way through a bible edit is a mismatch on the old scenes
     *    and a drift on the boundary. The character audibly changes mid-video.
     *
     * So the earlier version's `continue` after a mismatch was wrong: it made drift
     * unreachable whenever the bible was also disobeyed, which is most of the time.
     * Both findings are emitted, and the scene is counted as **one** miss regardless —
     * two descriptions of one wrong voice are not two wrong voices.
     */
    const mismatch = !sameVoice(usedVoiceId, assignment.providerVoiceId);
    const established = heardAs.get(leadId);
    const drift =
      established !== undefined && !sameVoice(established.voiceId, usedVoiceId);

    if (established === undefined) {
      // The first scene to voice this character defines what the rest must match, so
      // it is recorded whether or not it matched the bible.
      heardAs.set(leadId, { voiceId: usedVoiceId, sceneIndex: entry.sceneIndex });
    }

    if (mismatch || drift) misses += 1;

    if (mismatch) {
      issues.push({
        code: "continuity.voice.assignment_mismatch",
        severity: "fail",
        message:
          `Scene ${entry.sceneIndex} was narrated in a different voice from the one ` +
          `the story bible assigns to ${assignment.characterName}.`,
        /**
         * The action named here is the one that exists.
         *
         * This said "re-run the voiceover stage", which no surface offers: the voiceover
         * stage chains into visuals, so re-running it regenerates every scene's clip at
         * full provider cost, and its new durations invalidate the timeline, the captions
         * and the render. There is therefore no narrower audio-only path today, and a
         * finding that instructs an operator to take one is a finding they cannot act on.
         *
         * Rebuilding is what actually fixes it, and it fixes it for the stated reason:
         * the voice assignment is resolved from the bible on every run, so the corrected
         * bible is obeyed by the next build without anything else being changed.
         */
        detail:
          "Rebuilding this video will narrate the scene in the character's canonical " +
          "voice — the assignment is read from the story bible on every build. There is " +
          "no way to re-narrate one scene on its own.",
        sceneIndex: entry.sceneIndex,
        entityId: assignment.characterId,
      });
    }

    if (drift && established !== undefined) {
      issues.push({
        code: "continuity.voice.drift",
        severity: "fail",
        message:
          `${assignment.characterName} is narrated in a different voice in scene ` +
          `${entry.sceneIndex} than in scene ${established.sceneIndex}.`,
        // Same correction as the mismatch above: the fix is a rebuild, and the reason it
        // works is that the assignment is deterministic given the bible, so one rebuild
        // re-narrates every scene from the same contract.
        detail:
          "The same character sounds like two different people in one video. Rebuilding " +
          "will narrate every scene from the story bible's single assignment.",
        sceneIndex: entry.sceneIndex,
        entityId: assignment.characterId,
      });
    }
  }

  /**
   * A character with a canonical voice who never leads a scene.
   *
   * Whole-video rather than per-scene, and `info` rather than a deduction: an
   * assigned voice that is never used is a casting decision the operator may want to
   * know about, not a continuity break. It contributes nothing to the tally, so it
   * cannot move the score.
   */
  const leads = new Set(
    input.states
      .map((entry) => leadCharacterFor(entry.state))
      .filter((id): id is string => id !== null),
  );

  for (const character of input.bible.characters) {
    if (!hasCanonicalVoice(character.voice)) continue;
    if (leads.has(character.id)) continue;

    issues.push({
      code: "continuity.voice.unused",
      severity: "info",
      message: `${character.name} has a canonical voice but never leads a scene.`,
      sceneIndex: null,
      entityId: character.id,
    });
  }

  return { expected, misses };
}

/** The same check for places. */
function checkEnvironments(
  input: ValidateInput,
  visuals: VisualIndex,
  issues: ContinuityIssue[],
): number {
  if (!input.capabilities.environments) return 100;

  let expected = 0;
  let missing = 0;

  for (const entry of ordered(input.states)) {
    const id = entry.state.environment;
    if (!id) continue;

    const environment = findEnvironment(input.bible, id);
    if (!environment) {
      issues.push({
        code: "continuity.environment.unknown",
        severity: "warn",
        message: `Scene ${entry.sceneIndex} references a location that is not in the story bible.`,
        detail: `Location id: ${id}.`,
        sceneIndex: entry.sceneIndex,
        entityId: id,
      });
      continue;
    }

    const facts = [
      ...environment.description,
      ...(environment.lighting ? [environment.lighting] : []),
    ];
    if (facts.length === 0) continue;

    expected += 1;

    const prompt = (visuals.get(entry.sceneIndex)?.visualPrompt ?? "").toLowerCase();
    if (!facts.some((fact) => containsFact(prompt, fact))) {
      missing += 1;
      issues.push({
        code: "continuity.environment.missing_constraint",
        severity: "fail",
        message:
          `Scene ${entry.sceneIndex} is set in ${environment.name} but its prompt does not ` +
          "describe that location.",
        sceneIndex: entry.sceneIndex,
        entityId: environment.id,
      });
    }
  }

  return penalise(100, missing, expected, 100);
}

/**
 * Props, and whether established state is carried forward.
 *
 * A missing prop is a warning rather than a failure: a prop that is in a scene's
 * state but not in its prompt is often a planner listing something incidental, and
 * regenerating a paid clip over an unmentioned teacup is the wrong trade. Losing an
 * established *change* is the harder finding, because it is the one that reads as
 * an error on screen.
 */
function checkProps(
  input: ValidateInput,
  visuals: VisualIndex,
  issues: ContinuityIssue[],
): number {
  if (!input.capabilities.props) return 100;

  let expected = 0;
  let missing = 0;

  for (const entry of ordered(input.states)) {
    const prompt = (visuals.get(entry.sceneIndex)?.visualPrompt ?? "").toLowerCase();

    for (const id of entry.state.props) {
      const prop = findProp(input.bible, id);
      if (!prop) {
        issues.push({
          code: "continuity.prop.unknown",
          severity: "warn",
          message: `Scene ${entry.sceneIndex} references an object that is not in the story bible.`,
          detail: `Object id: ${id}.`,
          sceneIndex: entry.sceneIndex,
          entityId: id,
        });
        continue;
      }

      if (prop.description.length === 0) continue;
      expected += 1;

      if (
        !prompt.includes(prop.name.toLowerCase()) &&
        !prop.description.some((fact) => containsFact(prompt, fact))
      ) {
        missing += 1;
        issues.push({
          code: "continuity.prop.missing_constraint",
          severity: "warn",
          message: `Scene ${entry.sceneIndex} lists ${prop.name} but its prompt does not mention it.`,
          sceneIndex: entry.sceneIndex,
          entityId: prop.id,
        });
      }
    }
  }

  return penalise(100, missing, expected, 60);
}

/**
 * Story continuity: does the plan hold together as a sequence?
 *
 * Three deterministic claims, and no more. Anything further — whether the plot
 * makes sense, whether the arc lands — is a judgement, and §29 is explicit that
 * deterministic checks must not be replaced by an LLM's opinion. So this checks
 * structure, not quality:
 *
 *  1. A scene may not depend on a scene that was never planned.
 *  2. An entity may not first appear at the climax with no setup, when the level
 *     tracks characters.
 *  3. A change established earlier must not be contradicted by a later scene
 *     re-establishing the same thing.
 */
function checkStory(input: ValidateInput, issues: ContinuityIssue[]): number {
  const states = ordered(input.states);
  if (states.length === 0) return 100;

  const planned = new Set(states.map((entry) => entry.sceneIndex));
  let problems = 0;

  for (const entry of states) {
    const echo = entry.state.echoesSceneIndex;
    if (echo !== null && !planned.has(echo)) {
      problems += 1;
      issues.push({
        code: "continuity.story.dangling_echo",
        severity: "warn",
        message: `Scene ${entry.sceneIndex} echoes scene ${echo}, which is not in the plan.`,
        sceneIndex: entry.sceneIndex,
        entityId: null,
      });
    }

    // A change repeated verbatim after it was already established means two scenes
    // both claim to be the moment it happened.
    const earlier = new Set(
      changesBefore(states, entry.sceneIndex).map((c) => c.trim().toLowerCase()),
    );
    for (const change of entry.state.changes) {
      if (earlier.has(change.trim().toLowerCase())) {
        problems += 1;
        issues.push({
          code: "continuity.story.restated_change",
          severity: "warn",
          message:
            `Scene ${entry.sceneIndex} establishes something an earlier scene already ` +
            "established.",
          detail: change,
          sceneIndex: entry.sceneIndex,
          entityId: null,
        });
      }
    }
  }

  if (input.capabilities.characters) {
    for (const entry of states) {
      if (entry.state.beat !== "climax") continue;

      for (const id of entry.state.characters) {
        const origin = input.graph.establishedBy.get(`character:${id}`);
        if (origin === entry.sceneIndex) {
          problems += 1;
          issues.push({
            code: "continuity.story.late_introduction",
            severity: "warn",
            message:
              `${findCharacter(input.bible, id)?.name ?? id} first appears at the climax ` +
              `in scene ${entry.sceneIndex}, with no earlier setup.`,
            sceneIndex: entry.sceneIndex,
            entityId: id,
          });
        }
      }
    }
  }

  return penalise(100, problems, states.length, 50);
}

/**
 * Style consistency: is the video's look asserted in every scene?
 *
 * Whole-video rather than per-entity, because that is what style is. A scene whose
 * prompt carries none of the style facts will be drawn in whatever the model's
 * default is, and one photoreal frame in a hand-drawn video is the most visible
 * continuity failure of all.
 */
function checkStyle(input: ValidateInput, issues: ContinuityIssue[]): number {
  if (!input.capabilities.style || !hasStyle(input.bible.style)) return 100;

  const style = input.bible.style;
  const facts = [
    ...(style.medium ? [style.medium] : []),
    ...style.palette,
    ...(style.lighting ? [style.lighting] : []),
    ...(style.camera ? [style.camera] : []),
  ];
  if (facts.length === 0) return 100;

  const scenes = input.visuals.length;
  if (scenes === 0) return 100;

  let missing = 0;

  for (const visual of [...input.visuals].sort((a, b) => a.sceneIndex - b.sceneIndex)) {
    const prompt = (visual.visualPrompt ?? "").toLowerCase();
    if (!facts.some((fact) => containsFact(prompt, fact))) {
      missing += 1;
      issues.push({
        code: "continuity.style.missing_constraint",
        severity: "fail",
        message: `Scene ${visual.sceneIndex}'s prompt does not carry the video's visual style.`,
        detail: `Expected one of: ${facts.join("; ")}.`,
        sceneIndex: visual.sceneIndex,
        entityId: null,
      });
    }
  }

  return penalise(100, missing, scenes, 100);
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

function ordered(states: readonly IndexedSceneState[]): IndexedSceneState[] {
  return [...states].sort((a, b) => a.sceneIndex - b.sceneIndex);
}

/**
 * Is a fact present in a prompt?
 *
 * A fact is a phrase like "long brown coat"; the prompt may have written "a long,
 * brown coat". Whole-phrase matching would miss that, and single-word matching
 * would match "coat" against "coat of paint". So the test is: every word of the
 * fact longer than three characters appears somewhere in the prompt.
 *
 * Both sides are already lowercased by the callers.
 */
function containsFact(prompt: string, fact: string): boolean {
  const words = fact
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3);

  if (words.length === 0) {
    // A fact of only short words ("red hat") — fall back to substring.
    return prompt.includes(fact.toLowerCase().trim());
  }

  return words.every((word) => prompt.includes(word));
}

/**
 * Deduct proportionally, capped.
 *
 * `misses / expected` scaled by `maxPenalty`, so one bad scene in eighty barely
 * moves the component while half the video failing takes it to the floor. Integer
 * result: a component of 87.33333 is not more informative than 87, and rounding at
 * the component keeps `combine` from accumulating float noise.
 */
function penalise(
  base: number,
  misses: number,
  expected: number,
  maxPenalty: number,
): number {
  if (expected <= 0 || misses <= 0) return base;
  const ratio = Math.min(1, misses / expected);
  return Math.max(0, Math.round(base - ratio * maxPenalty));
}

/**
 * Weighted mean over the components this level actually asks for.
 *
 * Excluded components are dropped from both the numerator and the denominator
 * rather than scored 100, which would let a `style`-level video reach 100 with a
 * broken style by averaging in four irrelevant perfect scores.
 */
function combine(
  components: ContinuityComponents,
  capabilities: LevelCapabilities,
): number {
  const active: Array<keyof ContinuityComponents> = [];

  if (capabilities.characters) active.push("characterConsistency");
  if (capabilities.environments) active.push("environmentConsistency");
  if (capabilities.props) active.push("propContinuity");
  if (capabilities.style) active.push("styleConsistency");
  if (capabilities.duplicates) active.push("duplicateRisk");
  // Story structure is checked whenever anything is, because it needs no entity
  // support — it is a property of the scene sequence itself.
  if (active.length > 0) active.push("storyContinuity");

  if (active.length === 0) return 100;

  const totalWeight = active.reduce((sum, key) => sum + WEIGHTS[key], 0);
  const weighted = active.reduce(
    (sum, key) => sum + components[key] * WEIGHTS[key],
    0,
  );

  return Math.round(weighted / totalWeight);
}

export function statusFor(
  score: number,
  thresholds: ContinuityThresholds,
): ContinuityStatus {
  if (score >= thresholds.pass) return "pass";
  if (score < thresholds.fail) return "fail";
  return "warn";
}

/**
 * The issues for one scene, as plain messages.
 *
 * Feeds `regenerationPrompt`: a regenerated scene is told what was wrong with it,
 * which is §13's requirement and the difference between a fix and a second dice
 * roll.
 */
export function issuesForScene(
  report: ContinuityReport,
  sceneIndex: number,
): string[] {
  return report.issues
    .filter(
      (issue) =>
        issue.sceneIndex === sceneIndex &&
        issue.severity === "fail" &&
        // These become a *visual* regeneration prompt. "Narrated in a different
        // voice" is a true finding and a useless instruction to an image model, and
        // a scene with both a wrong coat and a wrong voice must not have the second
        // one steering the redraw.
        !isVoiceCode(issue.code),
    )
    .map((issue) => (issue.detail ? `${issue.message} ${issue.detail}` : issue.message));
}

/**
 * The report as `quality_checks.findings` rows.
 *
 * The existing table's exact shape — `{code, severity, message, detail?}` — so the
 * dashboard reader that already renders quality findings renders these with no
 * change. The scene index rides in `detail` rather than in a new column, because
 * adding a column to a completed migration is not on the table and the findings
 * blob is where per-item context already lives.
 */
export function toQualityFindings(report: ContinuityReport): Array<{
  code: string;
  severity: FindingSeverity;
  message: string;
  detail?: string;
}> {
  const summary = {
    code: "continuity.score",
    severity:
      report.status === "fail"
        ? ("fail" as const)
        : report.status === "warn"
          ? ("warn" as const)
          : ("info" as const),
    message: `Continuity score ${report.score}/100 (${report.status}).`,
    detail: Object.entries(report.components)
      .map(([key, value]) => `${key} ${value}`)
      .join(", "),
  };

  return [
    summary,
    ...report.issues.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
      detail: [
        issue.sceneIndex !== null ? `scene ${issue.sceneIndex}` : null,
        issue.entityId !== null ? `entity ${issue.entityId}` : null,
        issue.detail ?? null,
      ]
        .filter((part): part is string => part !== null)
        .join(" · "),
    })),
  ];
}

/**
 * The scene a stored finding is about, read back out of its `detail`.
 *
 * The inverse of the `scene N` field `toQualityFindings` writes above, and it lives
 * here for that reason: the format is one decision, and a reader that re-derives it
 * by hand is how `scene 1` comes to match `scene 19`.
 *
 * Anchored, and only ever the *leading* field — which is where `toQualityFindings`
 * puts it whenever there is one. The alternative, searching the whole string, would
 * match a scene number that happened to appear in a finding's own free text.
 *
 * Returns null for a finding with no scene: the summary row, a whole-video style
 * failure, an unused voice. Null means "not about a scene", never "scene 0".
 */
export function sceneOfFinding(detail: string | undefined | null): number | null {
  if (!detail) return null;
  const match = SCENE_DETAIL_RE.exec(detail);
  if (!match?.[1]) return null;
  const index = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(index) ? index : null;
}

/**
 * The stored findings a scene's regeneration should be told to correct.
 *
 * `issuesForScene` is the same decision made against a live `ContinuityReport`; this is
 * it made against the rows read back out of `quality_checks`, which is what the
 * regeneration stage actually has — the report that failed the scene belongs to a job
 * that has already finished. The two are separate functions because their inputs are
 * different shapes, and they are in one module because they must not disagree.
 *
 * Three filters, and each one prevents a specific way of paying for a wrong instruction:
 *
 *  - **`fail` only.** A warning is recorded and shown; regenerating for one would make
 *    the middle band cost the same as a failure.
 *  - **No voice codes.** "Narrated in a different voice" is true and useless to an image
 *    model, and a scene with a wrong coat *and* a wrong voice must not have the second
 *    steering the redraw.
 *  - **`sceneOfFinding`, not a substring search.** `detail.includes("scene 1")` also
 *    matched scenes 10–19 and 100–119, so near `MAX_SCENES` a redraw of scene 1 was
 *    handed twenty other shots' failures to correct.
 */
export function storedIssuesForScene(
  findings: readonly {
    code: string;
    severity: FindingSeverity;
    message: string;
    detail?: string;
  }[],
  sceneIndex: number,
): string[] {
  return findings
    .filter(
      (finding) =>
        finding.severity === "fail" &&
        !isVoiceCode(finding.code) &&
        sceneOfFinding(finding.detail) === sceneIndex,
    )
    .map((finding) => finding.message);
}

/**
 * `scene 12` at the start of a detail, terminated by the end of the string or the
 * separator `toQualityFindings` joins its fields with. The terminator is what makes
 * this exact: without it, `scene 1` is a prefix of `scene 12`.
 */
const SCENE_DETAIL_RE = /^scene (\d+)(?: ·|$)/;
