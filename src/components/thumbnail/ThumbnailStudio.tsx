"use client";

/**
 * Thumbnail studio — the prototype's Thumbnail tab (STAGE 04, §16).
 *
 * Preserved: the hero 16:9 preview with the red play badge, the four-variant grid
 * with a red border and check on the selection, "Use this thumbnail" /
 * "Regenerate" / "Continue to publish", and the four footer hints (Hook visual /
 * Bold text / Color & contrast / Emotion).
 *
 * Changed: the prototype's variants were four hard-coded strings rendered as CSS
 * text. Real variants are composited images produced by a background job; the
 * headline is shown as the concept label, but the picture the user is judging is
 * the actual file that will be uploaded to YouTube. A variant whose image has not
 * been rendered yet says so instead of displaying a styled substitute (§42).
 */
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  Check,
  ChevronRight,
  Eye,
  ImageIcon,
  Loader2,
  Palette,
  RefreshCw,
  Sparkles,
  Type as TypeIcon,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Btn } from "@/components/ui/Btn";
import { EmptyCTA } from "@/components/ui/SectionHeader";
import { color, font, radius } from "@/lib/design/tokens";
import type { ThumbnailVariantView } from "@/lib/dashboard/stage";
import type { ProjectStatus } from "@/lib/projects/state-machine";
import { api, messageOf } from "@/services/api-client";

const POLL_MS = 4000;

export interface ThumbnailVariantWithUrl extends ThumbnailVariantView {
  /** Signed URL for the composited image, or null before it exists. */
  imageUrl: string | null;
}

export interface ThumbnailStudioProps {
  projectId: string | null;
  status: ProjectStatus | null;
  baseTitle: string | null;
  variants: ThumbnailVariantWithUrl[];
  selectedVariantId: string | null;
  /** Whether the plan includes thumbnail A/B testing (§23). */
  abTestingAvailable: boolean;
  canGenerate: boolean;
  error: { message: string; code: string | null } | null;
}

export function ThumbnailStudio({
  projectId,
  status,
  baseTitle,
  variants,
  selectedVariantId,
  abTestingAvailable,
  canGenerate,
  error,
}: ThumbnailStudioProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<"generate" | "select" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Which card the user is looking at. Local by design — a preview click is not
  // a commitment. Committing is "Use this thumbnail", which writes to the server.
  const [previewId, setPreviewId] = useState<string | null>(
    selectedVariantId ?? variants[0]?.id ?? null,
  );

  const generating = status === "THUMBNAIL_GENERATING";

  useEffect(() => {
    if (!generating) return;
    const id = setInterval(() => startTransition(() => router.refresh()), POLL_MS);
    return () => clearInterval(id);
  }, [generating, router, startTransition]);

  // Follow the server when new variants arrive, unless the user has already
  // picked something in this session.
  useEffect(() => {
    setPreviewId((current) =>
      current && variants.some((v) => v.id === current)
        ? current
        : (selectedVariantId ?? variants[0]?.id ?? null),
    );
  }, [variants, selectedVariantId]);

  async function generate() {
    setActionError(null);
    setBusy("generate");
    try {
      await api.post("/api/thumbnails/generate", { projectId });
      startTransition(() => router.refresh());
    } catch (e) {
      setActionError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  async function select() {
    if (!previewId) return;
    setActionError(null);
    setBusy("select");
    try {
      await api.post("/api/thumbnails/select", { projectId, variantId: previewId });
      startTransition(() => router.refresh());
    } catch (e) {
      setActionError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  const notice = actionError ?? error?.message ?? null;
  const preview = variants.find((v) => v.id === previewId) ?? null;
  const isCommitted = previewId !== null && previewId === selectedVariantId;

  if (!projectId) {
    return (
      <EmptyCTA
        icon={<ImageIcon size={22} />}
        title="No video started"
        body="Thumbnails are designed for a specific video. Start one in Research and Vidxir AI will design four concepts for it."
        action={
          <Btn onClick={() => router.push("/dashboard/research")}>
            Find an idea <ChevronRight size={15} />
          </Btn>
        }
      />
    );
  }

  return (
    <div>
      {notice && (
        <Card tone="warning" pad={14} style={{ marginBottom: 16 }}>
          <p style={{ margin: 0, fontSize: 13, color: color.warning, lineHeight: 1.6 }}>
            {notice}
          </p>
        </Card>
      )}

      {generating && (
        <Card style={{ textAlign: "center", padding: 40, marginBottom: 16 }}>
          <Loader2
            size={20}
            color={color.accent}
            className="vidxir-spin"
            style={{ marginBottom: 12 }}
            aria-hidden="true"
          />
          <p style={{ color: color.textDim, fontSize: 14, margin: 0 }}>
            Designing four variations…
          </p>
        </Card>
      )}

      {!generating && variants.length === 0 && (
        <EmptyCTA
          icon={<ImageIcon size={22} />}
          title="No thumbnails yet"
          body={
            canGenerate
              ? baseTitle
                ? `Ready to design thumbnails for “${baseTitle}.”`
                : "Ready to design four thumbnail concepts for this video."
              : "Thumbnail generation needs the AI, visuals and thumbnail-text providers to be configured."
          }
          action={
            <Btn onClick={generate} loading={busy === "generate"} disabled={!canGenerate}>
              Generate thumbnails <ChevronRight size={15} />
            </Btn>
          }
        />
      )}

      {variants.length > 0 && (
        <>
          <Card style={{ marginBottom: 16 }}>
            <div
              style={{
                background: `linear-gradient(135deg, ${color.accentDark}, ${color.mediaBg})`,
                borderRadius: radius.md,
                aspectRatio: "16/9",
                display: "flex",
                alignItems: "center",
                justifyContent: preview?.imageUrl ? "center" : "flex-start",
                padding: preview?.imageUrl ? 0 : 24,
                position: "relative",
                overflow: "hidden",
              }}
            >
              {preview?.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived storage URL
                <img
                  src={preview.imageUrl}
                  alt={preview.headline}
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              ) : (
                <div style={{ maxWidth: "78%" }}>
                  <div
                    style={{
                      fontFamily: font.display,
                      fontSize: 24,
                      fontWeight: 700,
                      lineHeight: 1.1,
                      textTransform: "uppercase",
                      color: color.textBright,
                    }}
                  >
                    {preview?.headline ?? "No concept selected"}
                  </div>
                  <p
                    style={{
                      margin: "12px 0 0",
                      fontSize: 12.5,
                      lineHeight: 1.55,
                      color: color.textFaint,
                    }}
                  >
                    This concept has no rendered image yet. What you see is the
                    headline text, not the thumbnail — the picture appears once the
                    image has actually been composited.
                  </p>
                </div>
              )}
              <div
                style={{
                  position: "absolute",
                  right: 20,
                  bottom: 20,
                  width: 46,
                  height: 46,
                  borderRadius: "50%",
                  background: color.accent,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  pointerEvents: "none",
                }}
                aria-hidden="true"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill={color.onMedia}>
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
            </div>
            {preview?.concept && (
              <p
                style={{
                  margin: "12px 0 0",
                  fontSize: 12.5,
                  lineHeight: 1.55,
                  color: color.textDim,
                }}
              >
                {preview.concept}
              </p>
            )}
          </Card>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 10,
              marginBottom: 16,
            }}
          >
            {variants.map((variant) => {
              const active = variant.id === previewId;
              const committed = variant.id === selectedVariantId;
              return (
                <button
                  key={variant.id}
                  type="button"
                  onClick={() => setPreviewId(variant.id)}
                  aria-pressed={active}
                  style={{
                    all: "unset",
                    boxSizing: "border-box",
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    padding: 12,
                    background: color.card,
                    borderRadius: radius.lg,
                    border: `1px solid ${active ? color.accent : color.border}`,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: font.display,
                        fontSize: 13,
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: 0.4,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {variant.headline}
                    </span>
                    {committed && (
                      <Check size={15} color={color.accent} style={{ flexShrink: 0 }} />
                    )}
                  </div>
                  <span style={{ fontSize: 11.5, color: color.textFaint }}>
                    {variant.imageAssetId === null
                      ? "Image not rendered"
                      : abTestingAvailable && variant.ctr !== null
                        ? `CTR ${(variant.ctr * 100).toFixed(1)}%`
                        : (variant.emotion ?? "Concept")}
                  </span>
                </button>
              );
            })}
          </div>

          <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
            <Btn
              onClick={select}
              loading={busy === "select" || pending}
              disabled={isCommitted || previewId === null}
              icon={isCommitted ? <Check size={15} /> : undefined}
            >
              {isCommitted ? "Selected" : "Use this thumbnail"}
            </Btn>
            <Btn
              variant="ghost"
              onClick={generate}
              loading={busy === "generate"}
              disabled={!canGenerate}
            >
              <RefreshCw size={14} /> Regenerate
            </Btn>
            {selectedVariantId && (
              <Btn variant="ghost" onClick={() => router.push("/dashboard/publish")}>
                Continue to publish <ChevronRight size={15} />
              </Btn>
            )}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 10,
            }}
          >
            {(
              [
                [Eye, "Hook visual"],
                [TypeIcon, "Bold text"],
                [Palette, "Color & contrast"],
                [Sparkles, "Emotion"],
              ] as const
            ).map(([Icon, label]) => (
              <div
                key={label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13,
                  color: color.textDim,
                }}
              >
                <Icon size={14} color={color.accent} aria-hidden="true" /> {label}
              </div>
            ))}
          </div>

          {!abTestingAvailable && (
            <p
              style={{
                margin: "16px 0 0",
                fontSize: 11.5,
                lineHeight: 1.55,
                color: color.textFaint,
              }}
            >
              Thumbnail A/B testing — rotating variants and measuring click-through
              — is part of the Studio plan.
            </p>
          )}
        </>
      )}
    </div>
  );
}
