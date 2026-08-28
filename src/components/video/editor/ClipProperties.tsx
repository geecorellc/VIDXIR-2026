"use client";

/**
 * Properties for the selected clip.
 *
 * Reads the clip out of the document and writes back through operations, so there is no
 * form state to get out of step with the timeline: drag a clip and the start value here
 * moves, because both are rendering the same field.
 *
 * Text is the one exception, and deliberately. A controlled input bound straight to the
 * document would dispatch — and therefore schedule a save — on every keystroke, and
 * worse, a rejected intermediate value would fight the cursor. So the input holds a local
 * draft and commits on blur or Enter, re-seeding whenever the selection or the stored text
 * changes underneath it.
 */

import { useEffect, useState } from "react";
import { Copy, Scissors, Trash2 } from "lucide-react";
import { Btn } from "@/components/ui/Btn";
import { color, font, radius } from "@/lib/design/tokens";
import {
  isAudioTrack,
  type EditClip,
  type EditTrack,
} from "@/lib/video/edit-document";
import { clipEndMs, supportsText, type EditOperation } from "@/lib/video/edit-ops";
import { timecode, trackLabel } from "@/lib/video/editor-view";

export interface ClipPropertiesProps {
  clip: EditClip;
  track: EditTrack;
  playheadMs: number;
  dispatch: (operation: EditOperation) => void;
  onDelete: () => void;
}

export function ClipProperties({
  clip,
  track,
  playheadMs,
  dispatch,
  onDelete,
}: ClipPropertiesProps) {
  const audio = isAudioTrack(track.kind);
  const text = supportsText(track.kind);
  const splittable = playheadMs > clip.startMs && playheadMs < clipEndMs(clip);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <Label>Clip</Label>
        <div style={{ fontSize: 13, color: color.text }}>
          {clip.label ?? trackLabel(track.kind, track.label)}
        </div>
      </div>

      <Rows>
        <Row label="Start" value={timecode(clip.startMs)} />
        <Row label="Duration" value={timecode(clip.durationMs)} />
        <Row label="End" value={timecode(clipEndMs(clip))} />
      </Rows>

      {clip.source ? (
        <Rows>
          <Row
            label="Source in"
            value={clip.sourceInMs === null ? "—" : timecode(clip.sourceInMs)}
          />
          <Row
            label="Source out"
            value={clip.sourceOutMs === null ? "—" : timecode(clip.sourceOutMs)}
          />
          <Row
            label="Material"
            value={
              clip.source.sourceDurationMs === null
                ? "Still image"
                : timecode(clip.source.sourceDurationMs)
            }
          />
          <Row label="Asset" value={clip.source.assetId.slice(0, 8)} mono />
        </Rows>
      ) : (
        <Rows>
          <Row label="Asset" value="None — generated in the render" />
        </Rows>
      )}

      {audio && (
        <div>
          <Label>Volume · {Math.round(clip.volume * 100)}%</Label>
          <input
            type="range"
            min={0}
            max={200}
            step={5}
            value={Math.round(clip.volume * 100)}
            aria-label="Clip volume"
            onChange={(event) =>
              dispatch({
                type: "setClipVolume",
                clipId: clip.id,
                volume: Number(event.target.value) / 100,
              })
            }
            style={{ width: "100%", accentColor: color.accent }}
          />
          <p style={{ margin: "4px 0 0", fontSize: 11, color: color.textFaint, lineHeight: 1.5 }}>
            Above 100% boosts a quiet take, in the preview as well as the export. The note
            under the player says so if this browser cannot preview the boost.
          </p>
        </div>
      )}

      {text && <TextEditor clip={clip} track={track} dispatch={dispatch} />}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn
          size="sm"
          variant="ghost"
          icon={<Scissors size={13} />}
          disabled={!splittable}
          onClick={() => dispatch({ type: "splitClip", clipId: clip.id, atMs: playheadMs })}
        >
          Split
        </Btn>
        <Btn
          size="sm"
          variant="ghost"
          icon={<Copy size={13} />}
          onClick={() => dispatch({ type: "duplicateClip", clipId: clip.id })}
        >
          Duplicate
        </Btn>
        <Btn size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={onDelete}>
          Delete
        </Btn>
      </div>

      {!splittable && (
        <p style={{ margin: 0, fontSize: 11, color: color.textFaint, lineHeight: 1.5 }}>
          Move the playhead inside this clip to split it.
        </p>
      )}
    </div>
  );
}

/**
 * Text/caption editing.
 *
 * Draft-and-commit rather than fully controlled — see the note at the top of the file.
 * The `key`ed reset is what keeps the draft honest when the document changes for a reason
 * other than typing: selecting another clip, an undo, or a reload after a conflict.
 */
function TextEditor({
  clip,
  track,
  dispatch,
}: {
  clip: EditClip;
  track: EditTrack;
  dispatch: (operation: EditOperation) => void;
}) {
  const [draft, setDraft] = useState(clip.text ?? "");

  useEffect(() => {
    setDraft(clip.text ?? "");
  }, [clip.id, clip.text]);

  function commit() {
    if (draft === (clip.text ?? "")) return;
    dispatch({ type: "setClipText", clipId: clip.id, text: draft });
  }

  return (
    <div>
      <Label>{track.kind === "caption" ? "Caption line" : "On-screen text"}</Label>
      <textarea
        value={draft}
        rows={3}
        // The schema's own cap, so the field cannot accept what the server would reject.
        maxLength={500}
        aria-label={track.kind === "caption" ? "Caption text" : "On-screen text"}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            commit();
          }
          if (event.key === "Escape") setDraft(clip.text ?? "");
          // Editing keys must not reach the editor's own shortcuts — Delete would
          // otherwise remove the clip being captioned.
          event.stopPropagation();
        }}
        style={{
          width: "100%",
          background: color.inputBg,
          border: `1px solid ${color.border}`,
          borderRadius: radius.md,
          padding: "9px 10px",
          color: color.text,
          fontFamily: font.body,
          fontSize: 13,
          lineHeight: 1.5,
          outline: "none",
          resize: "vertical",
        }}
      />
      <p style={{ margin: "4px 0 0", fontSize: 11, color: color.textFaint }}>
        Enter saves · Shift+Enter for a new line · {draft.length}/500
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: font.display,
        fontSize: 10,
        letterSpacing: 1.2,
        textTransform: "uppercase",
        color: color.textFaint,
        marginBottom: 5,
      }}
    >
      {children}
    </div>
  );
}

function Rows({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 5,
        background: color.inputBg,
        border: `1px solid ${color.borderFaint}`,
        borderRadius: radius.md,
        padding: "9px 11px",
      }}
    >
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12 }}>
      <span style={{ color: color.textFaint }}>{label}</span>
      <span
        style={{
          color: color.textBright,
          fontFamily: mono ? font.mono : font.body,
          textAlign: "right",
        }}
      >
        {value}
      </span>
    </div>
  );
}
