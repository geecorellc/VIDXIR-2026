"use client";

/**
 * Per-channel actions: refresh statistics, disconnect (§25, §27).
 *
 * Both hit real endpoints and both report what actually happened. "Refresh" is
 * not a spinner that resolves after a delay — it waits on a YouTube Data API read
 * and surfaces the error if the channel needs re-authorising (§30, §42).
 *
 * Disconnect asks for confirmation because it revokes the Google grant. The
 * channel's publishing history survives, which the copy says explicitly so the
 * user is not guessing what they are about to lose.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { RefreshCw, Unlink } from "lucide-react";
import { Btn } from "@/components/ui/Btn";
import { color } from "@/lib/design/tokens";

export interface ChannelActionsProps {
  channelId: string;
  channelTitle: string;
}

export function ChannelActions({ channelId, channelTitle }: ChannelActionsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<"refresh" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function call(
    action: "refresh" | "disconnect",
    path: string,
    method: "POST" | "DELETE",
  ) {
    setBusy(action);
    setError(null);
    try {
      const response = await fetch(path, {
        method,
        // Same-origin so the guard's Origin/Sec-Fetch-Site check passes.
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? "That did not work. Try again.");
        return;
      }
      // The page is a server component; refreshing re-reads Postgres rather than
      // patching client state, so what is on screen is what was persisted.
      startTransition(() => router.refresh());
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn
          variant="subtle"
          size="sm"
          icon={<RefreshCw size={13} />}
          loading={busy === "refresh" || pending}
          disabled={busy !== null}
          onClick={() =>
            void call("refresh", `/api/channels/${channelId}/refresh`, "POST")
          }
        >
          Refresh stats
        </Btn>

        {confirming ? (
          <>
            <Btn
              variant="danger"
              size="sm"
              loading={busy === "disconnect"}
              disabled={busy !== null}
              onClick={() =>
                void call("disconnect", `/api/channels/${channelId}`, "DELETE")
              }
            >
              Yes, disconnect
            </Btn>
            <Btn
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() => setConfirming(false)}
            >
              Keep it
            </Btn>
          </>
        ) : (
          <Btn
            variant="ghost"
            size="sm"
            icon={<Unlink size={13} />}
            disabled={busy !== null}
            onClick={() => setConfirming(true)}
          >
            Disconnect
          </Btn>
        )}
      </div>

      {confirming && (
        <p
          style={{
            margin: "8px 0 0",
            fontSize: 11.5,
            lineHeight: 1.55,
            color: color.textFaint,
          }}
        >
          Revokes Tally&apos;s access to {channelTitle} at Google. Videos already
          published stay on YouTube, and their history stays here.
        </p>
      )}

      {error && (
        <p
          role="alert"
          style={{
            margin: "8px 0 0",
            fontSize: 11.5,
            lineHeight: 1.55,
            color: color.rose,
          }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
