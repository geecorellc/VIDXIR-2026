/**
 * Whether a project's stored title is a real title, and what to show when it is not.
 *
 * `projects.title` is `NOT NULL`, so a project started from a pasted link has to be
 * given something at insert time — long before Tally knows what the video is about.
 * `/api/projects/from-youtube` writes `New video from a YouTube link (<videoId>)`,
 * deliberately not the source video's own title, because naming a project after
 * somebody else's video is the first step of the copying §22 forbids. That placeholder
 * is replaced by the chosen angle's title in `configureProject` once research succeeds.
 *
 * The bug this module exists to prevent is what happens when research *doesn't* succeed.
 * The placeholder then survives, and every surface that reads `project.title` treats it
 * as a real, user-facing video name: the script screen offered to "write a script for
 * 'New video from a YouTube link (pBt_n-tjV_Y).'", the thumbnail screen offered to
 * design thumbnails for it, the editor used it as the document heading, and
 * `buildScriptBrief` passed it to the AI as `Working title`. So the raw eleven-character
 * video id was presented as this project's name across the product, and in one case was
 * about to be sent to a provider as though it described the video.
 *
 * The distinction that fixes the whole class of problem is between **a URL the user
 * submitted** and **a source Tally successfully analysed**. `source_video_id` is written
 * on paste and proves only the former. So a placeholder title is not a title at all: it
 * is the absence of one, and `displayTitle()` returns null for it so each caller renders
 * its own honest empty state instead of quoting an internal string.
 *
 * Matched by shape rather than by exact equality, because the id varies and because a
 * project created before this module existed carries the same format. The alternative —
 * a `title_is_placeholder` column — would need a migration and a backfill to describe
 * something the existing string already tells us unambiguously.
 */

/**
 * The placeholder `/api/projects/from-youtube` writes.
 *
 * Anchored at both ends and matching YouTube's own id alphabet (`[A-Za-z0-9_-]{11}`), so
 * a user who genuinely types "New video from a YouTube link (my best one yet)" as their
 * own title keeps it. The parenthesised group is what makes this recognisable, and an
 * arbitrary phrase is not an id.
 */
const LINK_PLACEHOLDER =
  /^New video from a YouTube link \([A-Za-z0-9_-]{11}\)$/;

/**
 * A bare YouTube id standing alone as a title.
 *
 * Not written by any current code path, and checked anyway: this is the shape the bug
 * produced downstream (`source.title ?? source.videoId`), and if any future caller
 * stores one, it must not become a heading either.
 */
const BARE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * True when the stored title is a system-generated placeholder rather than a name.
 *
 * Exported for the tests and for callers that need to branch on it directly rather than
 * on a null.
 */
export function isPlaceholderTitle(title: string | null | undefined): boolean {
  if (!title) return true;
  const trimmed = title.trim();
  if (trimmed.length === 0) return true;
  return LINK_PLACEHOLDER.test(trimmed) || BARE_VIDEO_ID.test(trimmed);
}

/**
 * The project's title if it has a real one, otherwise null.
 *
 * Null rather than a substituted string like "Untitled video", because the right words
 * differ per surface — the script screen says "this video", the editor says "Untitled
 * video" — and deciding that here would put the wrong copy on one of them. Callers
 * already have a `?? "…"` for the null case; this makes that branch reachable.
 */
export function displayTitle(title: string | null | undefined): string | null {
  return isPlaceholderTitle(title) ? null : (title as string).trim();
}
