/**
 * Metadata formatting — the rules YouTube enforces at upload time (§17).
 *
 * Split from `service.ts` because these are pure functions over strings and the
 * service is `server-only`: keeping them here means the constraints that decide
 * whether an upload is *accepted* can be tested without a database, and the
 * publish stage can compose a description without importing generation logic.
 *
 * Every limit below is YouTube's, not a preference. A tag list over 500 characters
 * fails the whole upload; chapters that are not strictly increasing, or whose
 * first marker is not exactly `0:00`, are silently ignored. Both are worth
 * catching before an upload rather than after.
 */

/** YouTube's hard caps. Exceeding either is a rejected upload, not a warning. */
export const MAX_TITLE_CHARS = 100;
export const MAX_DESCRIPTION_CHARS = 5_000;
/** YouTube's combined tag budget is 500 characters; 15 tags stays inside it. */
export const MAX_TAGS = 15;
export const MAX_TAG_CHARS = 40;
/** The total character budget across all tags, separators included. */
const TAG_BUDGET = 500;
/** Chapters below this count do not activate the feature at all. */
export const MIN_CHAPTERS = 3;

export interface MetadataChapter {
  startMs: number;
  label: string;
}

/**
 * Clean a tag list for YouTube.
 *
 * Over-long tags are skipped rather than truncated, and the loop continues, so a
 * short tag after a huge one still makes it in. Truncating would change what was
 * asked for; dropping spends the remaining budget on something intact.
 */
export function normaliseTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let budget = TAG_BUDGET;

  for (const raw of tags) {
    const tag = raw.trim().replace(/^#+/, "").slice(0, MAX_TAG_CHARS);
    if (tag.length < 2) continue;

    const key = tag.toLowerCase();
    if (seen.has(key)) continue;

    // +1 for the comma YouTube counts between tags.
    const cost = tag.length + 1;
    if (cost > budget) continue;

    seen.add(key);
    out.push(tag);
    budget -= cost;

    if (out.length >= MAX_TAGS) break;
  }

  return out;
}

/** Strip leading hashes and duplicates; YouTube shows at most 3 above the title. */
export function normaliseHashtags(hashtags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of hashtags) {
    const tag = raw.trim().replace(/^#+/, "").replace(/\s+/g, "");
    if (tag.length < 2) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 3) break;
  }

  return out;
}

/**
 * `0:00` / `1:02:03` — the format YouTube parses as a chapter marker.
 *
 * Floors rather than rounds: 1.9s is still inside the first second of a chapter,
 * and rounding up would point at a moment the chapter has not reached.
 */
export function timecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return `${hours > 0 ? `${hours}:` : ""}${mm}:${String(seconds).padStart(2, "0")}`;
}

export interface DescriptionParts {
  description: string;
  chapters: MetadataChapter[];
  hashtags: string[];
}

/**
 * The description as YouTube will receive it: body, then chapters, then hashtags.
 *
 * Assembled at publish time rather than stored, so a re-timed chapter list is
 * reflected without rewriting the user's prose — and so an edited description
 * never has generated boilerplate baked into the text the user is editing.
 */
export function composeDescription(parts: DescriptionParts): string {
  const sections = [parts.description.trim()];

  if (parts.chapters.length >= MIN_CHAPTERS) {
    sections.push(
      [
        "Chapters",
        ...parts.chapters.map((c) => `${timecode(c.startMs)} ${c.label}`),
      ].join("\n"),
    );
  }

  if (parts.hashtags.length > 0) {
    sections.push(parts.hashtags.map((h) => `#${h}`).join(" "));
  }

  return sections.join("\n\n").slice(0, MAX_DESCRIPTION_CHARS);
}
