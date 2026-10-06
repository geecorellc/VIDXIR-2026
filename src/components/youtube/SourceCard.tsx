"use client";

/**
 * "SOURCE ANALYSIS" — what Vidxir AI understood about the pasted video (§5, §18, §22).
 *
 * Read-only, metadata only, and deliberately unable to be anything else: it takes
 * a `SourceView`, whose fields are numbers, strings and a thumbnail *URL*. There
 * is no field a media file could arrive in, so this panel cannot become a
 * downloader (§22).
 *
 * Two honesty rules shape the display. A figure YouTube did not report shows as
 * "not reported" rather than 0 — comments disabled and zero comments are different
 * facts (§42). And the transcript line says why there is no transcript rather than
 * implying one was read: `captions.download` needs the video owner's own OAuth
 * credentials, so a third party cannot legitimately read another creator's
 * captions, and Vidxir AI does not try.
 */
import { Clock, Eye, MessageSquare, ThumbsUp, Youtube } from "lucide-react";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { compact, formatTime } from "@/lib/dashboard/format";
import { color, font, radius } from "@/lib/design/tokens";

/**
 * The subset of `SourceView` this renders.
 *
 * Declared structurally rather than importing `SourceView` so the same component
 * can render a freshly-analysed link (whose `publishedAt` is a JSON string) and a
 * stored one (whose `publishedAt` is a `Date` from the loader).
 */
export interface SourceCardData {
  videoId: string;
  url: string | null;
  title: string | null;
  channelTitle: string | null;
  durationSeconds: number | null;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  viewsPerHour: number | null;
  thumbnailUrl: string | null;
  categoryTitle: string | null;
  topics: string[];
  niche: string | null;
  transcript: string | null;
  missingFields: string[];
}

const UNKNOWN_TRANSCRIPT = "YouTube did not say whether this video has captions.";

const TRANSCRIPT_NOTE: Record<string, string> = {
  owner_only:
    "This video has captions, but YouTube only serves them to the channel that " +
    "owns it. Vidxir AI does not read another creator's captions.",
  none: "YouTube reports no captions on this video.",
  unknown: UNKNOWN_TRANSCRIPT,
};

export function SourceCard({ source }: { source: SourceCardData }) {
  return (
    <Card>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {source.thumbnailUrl && (
          /*
            Displayed straight from YouTube's own CDN, exactly as an embed would.
            Vidxir AI never fetches, stores or re-encodes it (§22), which is also why
            this is a plain <img>: next/image would proxy and cache the bytes.
          */
          // eslint-disable-next-line @next/next/no-img-element -- remote YouTube thumbnail, displayed not stored (§22)
          <img
            src={source.thumbnailUrl}
            alt=""
            width={192}
            style={{
              width: 192,
              maxWidth: "100%",
              aspectRatio: "16 / 9",
              objectFit: "cover",
              borderRadius: radius.md,
              border: `1px solid ${color.border}`,
              flexShrink: 0,
            }}
          />
        )}

        <div style={{ flex: 1, minWidth: 240 }}>
          <div
            style={{
              fontFamily: font.display,
              fontSize: 10.5,
              letterSpacing: 1.3,
              textTransform: "uppercase",
              color: color.textFaint,
              marginBottom: 7,
              display: "flex",
              alignItems: "center",
              gap: 7,
            }}
          >
            <Youtube size={12} aria-hidden="true" /> Research source
          </div>

          <div style={{ fontSize: 15, lineHeight: 1.4, marginBottom: 5 }}>
            {source.url ? (
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: color.text, textDecoration: "none" }}
              >
                {source.title ?? source.videoId}
              </a>
            ) : (
              (source.title ?? source.videoId)
            )}
          </div>

          <div style={{ fontSize: 12.5, color: color.textFaint }}>
            {source.channelTitle ?? "channel not reported"}
            {source.categoryTitle ? ` · ${source.categoryTitle}` : ""}
          </div>

          <div
            style={{
              display: "flex",
              gap: 18,
              flexWrap: "wrap",
              marginTop: 14,
            }}
          >
            <Stat
              icon={<Eye size={13} aria-hidden="true" />}
              label="Views"
              value={source.viewCount === null ? null : compact(source.viewCount)}
            />
            <Stat
              icon={<ThumbsUp size={13} aria-hidden="true" />}
              label="Likes"
              value={source.likeCount === null ? null : compact(source.likeCount)}
            />
            <Stat
              icon={<MessageSquare size={13} aria-hidden="true" />}
              label="Comments"
              value={
                source.commentCount === null ? null : compact(source.commentCount)
              }
            />
            <Stat
              icon={<Clock size={13} aria-hidden="true" />}
              label="Length"
              value={
                source.durationSeconds === null
                  ? null
                  : formatTime(source.durationSeconds)
              }
            />
            <Stat
              icon={null}
              label="Views / hour"
              value={
                source.viewsPerHour === null
                  ? null
                  : compact(Math.round(source.viewsPerHour))
              }
            />
          </div>
        </div>
      </div>

      {(source.niche || source.topics.length > 0) && (
        <div
          style={{
            marginTop: 16,
            paddingTop: 14,
            borderTop: `1px solid ${color.borderFaint}`,
          }}
        >
          <div
            style={{
              fontFamily: font.display,
              fontSize: 10.5,
              letterSpacing: 1.3,
              textTransform: "uppercase",
              color: color.textFaint,
              marginBottom: 9,
            }}
          >
            Topic Vidxir AI will research
          </div>

          {source.niche && (
            <p
              style={{
                margin: "0 0 10px",
                fontSize: 13.5,
                color: color.textBright,
              }}
            >
              {source.niche}
            </p>
          )}

          {source.topics.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {source.topics.map((topic) => (
                <span
                  key={topic}
                  style={{
                    fontSize: 11.5,
                    padding: "4px 9px",
                    borderRadius: radius.pill,
                    background: color.inputBg,
                    border: `1px solid ${color.border}`,
                    color: color.textDim,
                  }}
                >
                  {topic}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <p
        style={{
          margin: "14px 0 0",
          fontSize: 11.5,
          lineHeight: 1.6,
          color: color.textFaint,
        }}
      >
        {(source.transcript === null
          ? UNKNOWN_TRANSCRIPT
          : TRANSCRIPT_NOTE[source.transcript]) ?? UNKNOWN_TRANSCRIPT}{" "}
        Vidxir AI researches the topic and writes something original — it never
        reproduces this video&apos;s script, title or footage.
      </p>

      {source.missingFields.length > 0 && (
        <p
          style={{
            margin: "8px 0 0",
            fontSize: 11.5,
            lineHeight: 1.6,
            color: color.textFaint,
          }}
        >
          YouTube did not return: {source.missingFields.join(", ")}. The research
          seed is thinner than usual, and the angles will lean on the title and
          category.
        </p>
      )}
    </Card>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  /** Null renders "not reported" — never a substituted zero (§42). */
  value: string | null;
}) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          fontSize: 10.5,
          fontFamily: font.display,
          letterSpacing: 1.1,
          textTransform: "uppercase",
          color: color.textFaint,
          marginBottom: 3,
        }}
      >
        {icon}
        {label}
      </div>
      <div
        style={{
          fontSize: 14,
          color: value === null ? color.textFaint : color.textBright,
        }}
      >
        {value ?? "not reported"}
      </div>
    </div>
  );
}
