/**
 * One thumbnail A/B test (Phase 9 §10, §14).
 *
 * The card's job is to be honest about certainty. A running test with two clicks
 * shows its numbers *and* an "Not enough data" state; a concluded tie says the
 * thumbnails are equivalent rather than showing a leader; a winner names the arm
 * and the margin. What no state does is present a ranking as a result before the
 * policy's minimums are met, which is the specific failure §10 rules out.
 *
 * The footer note is deliberate: no significance test has been run, because the
 * impression data a real one needs is not available from YouTube's API. Saying so
 * is better than a confidence figure Tally cannot compute.
 */
import { Card } from "@/components/ui/Card";
import { color, font } from "@/lib/design/tokens";
import type {
  ExperimentDecision,
  ExperimentRecord,
} from "@/lib/analytics/experiments";
import { integer, percent } from "./MetricRow";

const OUTCOME_LABEL: Record<string, string> = {
  winner: "Winner",
  no_winner: "No winner",
  tie: "Too close to call",
  insufficient_data: "Not enough data",
  stopped: "Stopped",
};

const OUTCOME_COLOR: Record<string, string> = {
  winner: color.positive,
  no_winner: color.textDim,
  tie: color.warning,
  insufficient_data: color.textFaint,
  stopped: color.textFaint,
};

export interface ExperimentCardProps {
  experiment: ExperimentRecord;
  /** The standing as computed now. Separate from the stored outcome. */
  standing: ExperimentDecision;
}

export function ExperimentCard({ experiment, standing }: ExperimentCardProps) {
  /**
   * A concluded test shows what it concluded; a running one shows the live
   * standing. Never the other way round — a stored `winner` must not be
   * overwritten in the UI by a later read, and a running test must not display a
   * decision it has not reached.
   */
  const isConcluded =
    experiment.status === "completed" || experiment.status === "cancelled";
  const outcome = isConcluded
    ? (experiment.outcome ?? "no_winner")
    : standing.outcome;
  const winningArmId = isConcluded ? experiment.winningArmId : null;

  return (
    <Card style={{ marginBottom: 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontFamily: font.display,
              fontSize: 13,
              letterSpacing: 0.9,
              textTransform: "uppercase",
              color: color.text,
            }}
          >
            {experiment.arms.length} thumbnails
          </div>
          <div
            style={{
              fontFamily: font.mono,
              fontSize: 11,
              color: color.textFaint,
              marginTop: 3,
            }}
          >
            {experiment.youtubeVideoId}
          </div>
        </div>
        <span
          style={{
            fontFamily: font.display,
            fontSize: 11,
            letterSpacing: 1.1,
            textTransform: "uppercase",
            color: OUTCOME_COLOR[outcome] ?? color.textDim,
          }}
        >
          {experiment.status === "running" && outcome === "insufficient_data"
            ? "Running"
            : (OUTCOME_LABEL[outcome] ?? outcome)}
        </span>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead>
          <tr style={{ color: color.textFaint, textAlign: "right" }}>
            <th style={{ ...headStyle, textAlign: "left" }}>Thumbnail</th>
            <th style={headStyle}>Impressions</th>
            <th style={headStyle}>Clicks</th>
            <th style={headStyle}>CTR</th>
            <th style={headStyle}>Days</th>
          </tr>
        </thead>
        <tbody>
          {experiment.arms.map((arm) => {
            const summary = standing.arms.find((a) => a.armId === arm.id);
            const isWinner = winningArmId === arm.id;
            return (
              <tr key={arm.id}>
                <td style={{ ...cellStyle, textAlign: "left" }}>
                  <span style={{ color: isWinner ? color.positive : color.text }}>
                    {arm.headline ?? `Variant ${arm.position + 1}`}
                  </span>
                  {arm.isControl && (
                    <span style={{ color: color.textFaint, marginLeft: 6 }}>
                      (current)
                    </span>
                  )}
                </td>
                {/* A dash rather than 0: nothing observed is not zero impressions. */}
                <td style={cellStyle}>
                  {arm.impressions === null ? "—" : integer(arm.impressions)}
                </td>
                <td style={cellStyle}>
                  {arm.clicks === null ? "—" : integer(arm.clicks)}
                </td>
                <td style={cellStyle}>{arm.ctr === null ? "—" : percent(arm.ctr)}</td>
                <td
                  style={{
                    ...cellStyle,
                    // Dimmed while the arm is below the policy's minimums, so an
                    // eligible row is visually distinct from one that only looks
                    // comparable.
                    color: summary?.eligible ? color.text : color.textFaint,
                  }}
                >
                  {arm.observationDays}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p
        style={{
          margin: "12px 0 0",
          fontSize: 12,
          lineHeight: 1.6,
          color: color.textDim,
        }}
      >
        {isConcluded && experiment.outcome
          ? conclusionText(experiment, standing)
          : standing.rationale}
      </p>

      <p
        style={{
          margin: "8px 0 0",
          fontSize: 11,
          lineHeight: 1.55,
          color: color.textFaint,
        }}
      >
        Compared on click-through rate against a{" "}
        {Math.round(standing.policy.minRelativeLift * 100)}% minimum margin, after{" "}
        {integer(standing.policy.minImpressionsPerArm)} impressions and{" "}
        {standing.policy.minObservationDays} days per thumbnail. No statistical
        significance test is applied — YouTube&rsquo;s API does not expose the
        impression data one would need.
      </p>
    </Card>
  );
}

/**
 * What a finished test concluded.
 *
 * Prefers the *stored* rationale, so a decision made under an older policy is
 * reported as it was made rather than re-narrated under today's thresholds. Falls
 * back to the live standing only when no decision was recorded — a cancelled test,
 * for instance.
 */
function conclusionText(
  experiment: ExperimentRecord,
  standing: ExperimentDecision,
): string {
  const when = experiment.decidedAt
    ? `Decided ${experiment.decidedAt.toISOString().slice(0, 10)}. `
    : "";
  return `${when}${experiment.decision?.rationale ?? standing.rationale}`;
}

const headStyle = {
  fontFamily: font.display,
  fontSize: 10,
  letterSpacing: 1,
  textTransform: "uppercase" as const,
  fontWeight: 500,
  padding: "0 0 7px",
  borderBottom: `1px solid ${color.borderFaint}`,
};

const cellStyle = {
  padding: "8px 0",
  textAlign: "right" as const,
  borderBottom: `1px solid ${color.borderFaint}`,
  color: color.textBright,
};
