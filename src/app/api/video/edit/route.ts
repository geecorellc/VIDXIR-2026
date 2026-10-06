/**
 * The editor's document endpoint (§34, §35).
 *
 *  - `GET  /api/video/edit?projectId=…` — open the editor. Returns the stored cut, or
 *    seeds one from the project's real scenes, assets, voiceover, music and captions on
 *    first open, plus signed URLs for every asset the preview has to play.
 *  - `PUT  /api/video/edit` — autosave, with optimistic concurrency.
 *
 * Both delegate straight to `lib/video/edit-service`, which filters every query by
 * `userId`, so tenant isolation is a property of the query rather than of a check that
 * could be forgotten. `requireProjectAccess` runs first anyway: it gives a foreign
 * project id the same 403 as a nonexistent one, so this route cannot be used to probe
 * which projects exist.
 *
 * The signed URLs are the one thing here that is not simply the document. The preview
 * plays real Vidxir AI assets out of private storage, so the browser needs short-lived read
 * URLs — and it must never be given a key it can turn into one itself. They are minted
 * here, keyed by storage key, and only for keys the *stored document* references; a key
 * the client sends is never signed, because `saveEditDocument` rewrites every key from
 * the tenant's own asset rows before persisting.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  handle,
  parseJson,
  parseQuery,
  requireOnboarded,
  requireProjectAccess,
} from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { logger } from "@/lib/logger";
import { signedReadUrl } from "@/lib/storage";
import { compileEditDocument, type EditDocument } from "@/lib/video/edit-document";
import {
  getOrSeedEditDocument,
  saveEditDocument,
  type StoredEdit,
} from "@/lib/video/edit-service";

const log = logger.child({ component: "api-video-edit" });

/**
 * How long the preview's asset URLs stay valid.
 *
 * Twenty minutes: long enough to scrub through a cut without the player breaking
 * mid-session, short enough that a URL copied out of devtools is not a lasting grant.
 * The editor re-fetches the document — and therefore the URLs — when a save conflicts or
 * the page reloads, so expiry degrades to a reload rather than to a broken editor.
 */
const PREVIEW_URL_TTL_SECONDS = 20 * 60;

const QuerySchema = z.object({
  projectId: z.string().uuid(),
});

/**
 * The save body.
 *
 * `document` is `unknown` on purpose. `EditDocumentSchema` is the boundary for its
 * shape and `saveEditDocument` applies it — validating here as well would put two
 * schemas on one value, and the weaker one would eventually drift. What this schema
 * does own is the envelope: the project id and the version the client read.
 */
const SaveSchema = z.object({
  projectId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  document: z.unknown(),
});

export async function GET(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireOnboarded();
    const query = parseQuery(request, QuerySchema);

    await requireProjectAccess(user.id, query.projectId);
    await enforce(rules().read, `video-edit:${user.id}`);

    const stored = await getOrSeedEditDocument(user.id, query.projectId);
    return present(stored, await signDocumentAssets(user.id, stored.document));
  });
}

export async function PUT(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireOnboarded();
    const body = await parseJson(request, SaveSchema);

    await requireProjectAccess(user.id, body.projectId);
    // The autosave rule, not `generation`: a save spends a row update, not provider
    // credit. `mutation` is loose enough that debounced typing never reaches it and
    // tight enough that a scripted loop cannot hammer Postgres through this route.
    await enforce(rules().mutation, `video-edit-save:${user.id}`);

    const stored = await saveEditDocument(user.id, body.projectId, {
      document: body.document,
      expectedVersion: body.expectedVersion,
    });

    return present(stored, null);
  });
}

/**
 * The wire shape the editor reads.
 *
 * `durationMs` and the track/clip counts come from the compiler rather than from the
 * row, so the number the editor shows is the number the export will produce. The row's
 * own `durationMs` is a denormalised copy for listings; trusting it here would let the
 * two disagree after a schema change.
 */
function present(
  stored: StoredEdit,
  assetUrls: Record<string, string> | null,
): {
  projectId: string;
  version: number;
  document: EditDocument;
  durationMs: number;
  seeded: boolean;
  lastRenderedAt: string | null;
  updatedAt: string;
  assetUrls: Record<string, string> | null;
} {
  const { durationMs } = compileEditDocument(stored.document);
  return {
    projectId: stored.projectId,
    version: stored.version,
    document: stored.document,
    durationMs,
    seeded: stored.seeded,
    lastRenderedAt: stored.lastRenderedAt?.toISOString() ?? null,
    updatedAt: stored.updatedAt.toISOString(),
    assetUrls,
  };
}

/**
 * Mint a short-lived read URL for every asset the cut plays.
 *
 * Keyed by storage key because that is what a compiled clip carries, so the client can
 * look one up without ever being told a key it did not already have in its own document.
 *
 * A signing failure drops that one key rather than failing the request: the editor then
 * shows that clip as unplayable while the rest of the cut still opens, which is strictly
 * more useful than a blank screen. `signedReadUrl` already logs the cause.
 */
async function signDocumentAssets(
  userId: string,
  document: EditDocument,
): Promise<Record<string, string>> {
  const keys = new Set<string>();
  for (const clip of compileEditDocument(document).clips) {
    if (clip.storageKey) keys.add(clip.storageKey);
  }

  const entries = await Promise.all(
    [...keys].map(async (key) => {
      try {
        return [
          key,
          await signedReadUrl(key, { expiresInSeconds: PREVIEW_URL_TTL_SECONDS }),
        ] as const;
      } catch (error) {
        log.warn("could not sign a preview asset", { userId, error });
        return null;
      }
    }),
  );

  return Object.fromEntries(entries.filter((entry) => entry !== null));
}
