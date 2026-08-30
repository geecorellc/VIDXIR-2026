/**
 * Continuity panel — the layer's visible surface on the video screen (§18, §19).
 *
 * A read-only report, deliberately. Everything on it is either a stored fact or a
 * computed score, and the two things it is careful never to do are:
 *
 *  - **Claim more than the check measured.** The validator reads prompts, not frames
 *    (there is no vision capability in this repository), so the copy says "prompt"
 *    wherever it means prompt. A panel that said "characters look consistent" would be
 *    asserting something nothing in Tally verified.
 *  - **Invent a state.** No bible means "no continuity for this video", which is the
 *    correct state for every project built before this layer and for every stock-footage
 *    project. The panel says the level and the reason rather than showing an empty score.
 *
 * A server component: the whole view is already resolved by `continuityView`, there is
 * nothing to poll (the check runs once, after the render), and keeping it on the server
 * means the bible never has to cross into a client bundle.
 */
import { AlertTriangle, Check, Info, Mic, Users } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { color, font, radius } from "@/lib/design/tokens";
import { hasCanonicalVoice, type Character } from "@/lib/continuity/bible";
import type { ContinuityView } from "@/lib/continuity/read";

export interface ContinuityPanelProps {
  view: ContinuityView;
}

/** Findings shown before the list is truncated. */
const MAX_FINDINGS = 6;

export function ContinuityPanel({ view }: ContinuityPanelProps) {
  /**
   * Nothing to show at all.
   *
   * Not an empty card: on a stock-footage project or with the engine switched off,
   * continuity is genuinely not part of this build, and a panel explaining that it
   * scored nothing would read as a failure.
   */
  if (!view.active && view.bible === null) return null;

  const findings = view.check?.findings ?? [];
  const failures = findings.filter((f) => f.severity === "fail");
  const warnings = findings.filter((f) => f.severity === "warn");
  const regenerated = view.scenes.filter((s) => s.regenerations > 0);

  return (
    <Card style={{ marginBottom: 16 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Users size={17} color={color.accent} aria-hidden="true" />
          <span style={{ fontSize: 14, fontWeight: 600 }}>Story continuity</span>
          <span
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              color: color.textFaint,
              background: color.subtle,
              border: `1px solid ${color.border}`,
              borderRadius: radius.pill,
              padding: "2px 8px",
            }}
          >
            {view.level}
          </span>
        </div>

        {/* The score, or an honest absence. Never a zero standing in for "not run". */}
        {view.score !== null ? (
          <span
            style={{
              fontFamily: font.display,
              fontSize: 22,
              lineHeight: 1,
              color: verdictColour(view.check?.verdict ?? null),
            }}
          >
            {view.score}
            <span style={{ fontSize: 12, color: color.textFaint }}>/100</span>
          </span>
        ) : (
          <span style={{ fontSize: 12, color: color.textFaint }}>Not checked yet</span>
        )}
      </div>

      <p
        style={{
          margin: "0 0 12px",
          fontSize: 12.5,
          color: color.textDim,
          lineHeight: 1.6,
        }}
      >
        {view.reason}
      </p>

      {view.bible && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            marginBottom: findings.length > 0 ? 12 : 0,
          }}
        >
          {view.bible.characters.map((character) => (
            <CastChip key={character.id} character={character} />
          ))}
          {view.bible.environments.map((environment) => (
            <Chip key={environment.id} label={environment.name} sub="place" />
          ))}
          {view.bible.style.medium && (
            <Chip label={view.bible.style.medium} sub="look" />
          )}
        </div>
      )}

      {view.check && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12.5,
            marginBottom: findings.length > 0 ? 8 : 0,
            color:
              failures.length > 0
                ? color.danger
                : warnings.length > 0
                  ? color.warning
                  : color.positive,
          }}
        >
          {failures.length > 0 ? (
            <>
              <AlertTriangle size={13} aria-hidden="true" />
              {failures.length} {failures.length === 1 ? "break" : "breaks"} in the
              scene prompts
            </>
          ) : warnings.length > 0 ? (
            <>
              <Info size={13} aria-hidden="true" />
              {warnings.length} {warnings.length === 1 ? "note" : "notes"}
            </>
          ) : (
            <>
              <Check size={13} aria-hidden="true" />
              Every scene carried its continuity constraints
            </>
          )}
        </div>
      )}

      {findings.length > 0 && (
        <ul
          style={{
            margin: 0,
            padding: "0 0 0 16px",
            fontSize: 12,
            lineHeight: 1.6,
            color: color.textDim,
          }}
        >
          {findings
            // The summary row carries the score, which the header already shows.
            .filter((finding) => finding.code !== "continuity.score")
            .slice(0, MAX_FINDINGS)
            .map((finding, i) => (
              <li key={`${finding.code}:${i}`}>
                <span
                  style={{
                    color:
                      finding.severity === "fail"
                        ? color.danger
                        : finding.severity === "warn"
                          ? color.warning
                          : color.textDim,
                  }}
                >
                  {finding.message}
                </span>
              </li>
            ))}
        </ul>
      )}

      {regenerated.length > 0 && (
        <p
          style={{
            margin: "10px 0 0",
            fontSize: 11.5,
            color: color.textFaint,
            lineHeight: 1.55,
          }}
        >
          {regenerated.length} {regenerated.length === 1 ? "scene" : "scenes"}{" "}
          regenerated for continuity. Re-export from the editor to put the new shots
          into an MP4 — the existing render still holds the originals.
        </p>
      )}

      {view.editedByUser && (
        <p
          style={{
            margin: "10px 0 0",
            fontSize: 11.5,
            color: color.textFaint,
            lineHeight: 1.55,
          }}
        >
          You have edited this story bible, so rebuilds will keep your version.
        </p>
      )}
    </Card>
  );
}

function Chip({ label, sub }: { label: string; sub: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: 5,
        background: color.inputBg,
        border: `1px solid ${color.border}`,
        borderRadius: radius.sm,
        padding: "4px 8px",
        fontSize: 12,
        color: color.textBright,
      }}
    >
      {label}
      <span style={{ fontSize: 10.5, color: color.textFaint }}>{sub}</span>
    </span>
  );
}

/**
 * A cast chip, marked when the character has a canonical voice.
 *
 * The whole of voice continuity's UI, and deliberately that small. Appearance already
 * appears here as the character's presence in the cast row; a voice is the same kind
 * of fact about the same character, so it belongs on the same chip rather than in a
 * section of its own. A character with no canonical voice renders exactly the chip
 * this panel rendered before — no empty slot, no "voice: none", because most projects
 * legitimately have none and an absence shown as a gap reads as a defect.
 *
 * The mark asserts only what is stored: that a voice id is assigned. It does not claim
 * the audio was produced in that voice — the findings list says that, from the check,
 * which is the only thing that measured it.
 */
function CastChip({ character }: { character: Character }) {
  if (!hasCanonicalVoice(character.voice)) {
    return <Chip label={character.name} sub="cast" />;
  }

  // The operator's label if the bible carries one, otherwise the bare word: the
  // provider voice id is not shown, being meaningless to a human and provider detail.
  const voice = character.voice?.name?.trim() || "voice";

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        background: color.inputBg,
        border: `1px solid ${color.border}`,
        borderRadius: radius.sm,
        padding: "4px 8px",
        fontSize: 12,
        color: color.textBright,
      }}
    >
      {character.name}
      <span style={{ fontSize: 10.5, color: color.textFaint }}>cast</span>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
          fontSize: 10.5,
          color: color.accent,
        }}
        title={`Always voiced as ${voice}`}
      >
        <Mic size={10} aria-hidden="true" />
        {voice}
      </span>
    </span>
  );
}

function verdictColour(verdict: string | null): string {
  if (verdict === "fail") return color.danger;
  if (verdict === "warn") return color.warning;
  if (verdict === "pass") return color.positive;
  return color.textDim;
}
