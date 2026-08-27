/**
 * YouTube URL normalisation (Phase 11 §4, §23 cases 1–3).
 *
 * §4's rule is short and load-bearing: *do not trust arbitrary user-provided ids*.
 * Everything downstream of this parser — a Google API request, a `projects`
 * column, a job payload crossing Redis — treats the id it produces as safe, so the
 * cases here are about the boundary rather than about string formatting:
 *
 *  - **Every form a human actually pastes resolves to the same id.** watch,
 *    youtu.be, shorts, embed, live, legacy `/v/`, a bare id, mobile, music,
 *    nocookie, scheme-less, `http://`, and a watch link copied from inside a
 *    playlist.
 *  - **The canonical URL is regenerated, never echoed.** A tracking parameter or
 *    an affiliate tag in the paste must not survive into anything Tally stores or
 *    renders as a link.
 *  - **Host matching is exact.** `youtu.be.evil.invalid` and `notyoutube.com` are
 *    the two failures a suffix check would wave through, and both are asserted.
 *  - **Not-a-video links are refused by name.** A playlist, a channel, a handle
 *    and a search page all parse as URLs; a user who pasted one needs to be told
 *    which mistake they made, not "invalid URL".
 *
 * No network, no environment, no database — the module has no dependencies but
 * `ValidationError`, which is exactly why the id boundary is testable in isolation.
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import {
  isValidVideoId,
  parseYouTubeLink,
  tryParseYouTubeLink,
  type YouTubeLinkForm,
} from "@/lib/youtube/url";

/** A real-shaped id: 11 characters of base64url, including both extra symbols. */
const ID = "dQw4w9WgXcQ";
const CANONICAL = `https://www.youtube.com/watch?v=${ID}`;

describe("isValidVideoId", () => {
  it("accepts exactly eleven base64url characters", () => {
    expect(isValidVideoId(ID)).toBe(true);
    expect(isValidVideoId("_-aA09zZ123")).toBe(true);
  });

  it("rejects anything else", () => {
    // The length rule is the one an attacker would probe first, so both sides of
    // it are asserted rather than just "too short".
    expect(isValidVideoId("dQw4w9WgXc")).toBe(false);
    expect(isValidVideoId("dQw4w9WgXcQQ")).toBe(false);
    expect(isValidVideoId("")).toBe(false);
    // Outside the alphabet: `+`, `/` and `=` are base64 but not base64url, and a
    // space or a quote is the shape an injection attempt takes.
    expect(isValidVideoId("dQw4w9WgXc+")).toBe(false);
    expect(isValidVideoId("dQw4w9WgXc/")).toBe(false);
    expect(isValidVideoId("dQw4w9WgX'Q")).toBe(false);
    expect(isValidVideoId("dQw4w9 gXcQ")).toBe(false);
    expect(isValidVideoId("../../etc/pa")).toBe(false);
  });
});

describe("parseYouTubeLink — accepted forms (§23 cases 1, 3)", () => {
  const cases: ReadonlyArray<[string, YouTubeLinkForm, string]> = [
    ["https://www.youtube.com/watch?v=" + ID, "watch", "the canonical desktop form"],
    ["https://youtube.com/watch?v=" + ID, "watch", "no www"],
    ["http://www.youtube.com/watch?v=" + ID, "watch", "http is accepted"],
    ["www.youtube.com/watch?v=" + ID, "watch", "scheme-less, as copied from an omnibox"],
    ["youtube.com/watch?v=" + ID, "watch", "scheme-less and bare host"],
    ["https://m.youtube.com/watch?v=" + ID, "watch", "the mobile front end"],
    ["https://music.youtube.com/watch?v=" + ID, "watch", "the music front end"],
    ["https://youtu.be/" + ID, "short_link", "the share form"],
    ["https://youtu.be/" + ID + "?t=42", "short_link", "share form with a timestamp"],
    ["https://www.youtube.com/shorts/" + ID, "shorts", "a Short"],
    ["https://m.youtube.com/shorts/" + ID, "shorts", "a Short on mobile"],
    ["https://www.youtube.com/embed/" + ID, "embed", "an embed"],
    ["https://www.youtube-nocookie.com/embed/" + ID, "embed", "the privacy embed host"],
    ["https://www.youtube.com/live/" + ID, "live", "a live stream"],
    ["https://www.youtube.com/v/" + ID, "legacy_v", "the legacy player path"],
    [ID, "bare_id", "a bare id"],
    ["  " + ID + "  ", "bare_id", "a bare id with pasted whitespace"],
  ];

  for (const [input, form, why] of cases) {
    it(`accepts ${why}`, () => {
      const parsed = parseYouTubeLink(input);
      expect(parsed.videoId).toBe(ID);
      expect(parsed.form).toBe(form);
      expect(parsed.canonicalUrl).toBe(CANONICAL);
    });
  }

  it("is case-insensitive about the host but not the id", () => {
    // Hosts are case-insensitive per RFC 3986; video ids are not, and lowercasing
    // one would silently resolve to a different video.
    expect(parseYouTubeLink("HTTPS://WWW.YouTube.COM/watch?v=" + ID).videoId).toBe(ID);
    expect(() => parseYouTubeLink("https://www.youtube.com/watch?v=" + ID.toLowerCase()))
      .not.toThrow();
    expect(
      parseYouTubeLink("https://www.youtube.com/watch?v=" + ID.toLowerCase()).videoId,
    ).toBe(ID.toLowerCase());
  });

  it("keeps the video when a watch link was copied from inside a playlist", () => {
    // The single most common real paste. `list` and `index` identify the playlist,
    // `v` identifies the video, and refusing this would refuse a valid video link.
    const parsed = parseYouTubeLink(
      `https://www.youtube.com/watch?v=${ID}&list=PLabc123&index=4&t=90s`,
    );
    expect(parsed.videoId).toBe(ID);
    expect(parsed.form).toBe("watch");
  });

  it("regenerates the canonical URL instead of echoing the paste (§23 case 1)", () => {
    // The point of `canonicalUrl`: a tracking parameter, an affiliate tag or a
    // `redirect` target in the paste must not survive into a stored row or into an
    // anchor Tally renders.
    const parsed = parseYouTubeLink(
      `https://www.youtube.com/watch?v=${ID}&utm_source=evil&si=trackingtoken&redirect=https://evil.invalid`,
    );
    expect(parsed.canonicalUrl).toBe(CANONICAL);
    expect(parsed.canonicalUrl).not.toContain("utm_source");
    expect(parsed.canonicalUrl).not.toContain("evil.invalid");
  });
});

describe("parseYouTubeLink — rejected input (§23 case 2)", () => {
  /** Assert the refusal is a `ValidationError` (a 400) carrying a stated reason. */
  function refuses(input: string, match: RegExp): void {
    let thrown: unknown;
    try {
      parseYouTubeLink(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    const error = thrown as ValidationError;
    expect(error.status).toBe(400);
    expect(error.message).toMatch(match);
  }

  it("refuses an empty paste", () => {
    refuses("", /paste a youtube video link/i);
    refuses("   ", /paste a youtube video link/i);
  });

  it("refuses input longer than a URL", () => {
    refuses(`https://www.youtube.com/watch?v=${ID}&pad=${"x".repeat(2_100)}`, /too long/i);
  });

  it("refuses a lookalike host — the failure a suffix check would allow", () => {
    // Both of these end with a YouTube domain as a *string*. Neither is YouTube.
    refuses(`https://youtu.be.evil.invalid/${ID}`, /not a youtube link/i);
    refuses(`https://notyoutube.com/watch?v=${ID}`, /not a youtube link/i);
    refuses(`https://youtube.com.evil.invalid/watch?v=${ID}`, /not a youtube link/i);
    refuses(`https://evil.invalid/youtube.com/watch?v=${ID}`, /not a youtube link/i);
    // A subdomain Tally has not listed is refused too: an exact list means an
    // attacker cannot invent `anything.youtube.com` and be trusted.
    refuses(`https://studio.youtube.com/watch?v=${ID}`, /not a youtube link/i);
  });

  it("refuses a non-http scheme", () => {
    // These all parse as URLs, which is exactly why the scheme is checked.
    refuses(`javascript:alert(1)//youtube.com/watch?v=${ID}`, /http\(s\)/i);
    refuses(`data:text/html,<script>1</script>`, /http\(s\)/i);
    refuses(`file:///etc/passwd`, /http\(s\)/i);
    refuses(`ftp://youtube.com/watch?v=${ID}`, /http\(s\)/i);
  });

  it("refuses a YouTube link that is not a single video, by name", () => {
    // Each of these is a different user mistake and gets its own sentence — "that
    // is a playlist link" tells the user what to do; "invalid URL" does not.
    refuses("https://www.youtube.com/playlist?list=PLabc123", /playlist link/i);
    refuses("https://www.youtube.com/channel/UCabc123def456", /channel link/i);
    refuses("https://www.youtube.com/c/SomeCreator", /channel link/i);
    refuses("https://www.youtube.com/user/SomeCreator", /channel link/i);
    refuses("https://www.youtube.com/@somecreator", /channel link/i);
    refuses("https://www.youtube.com/results?search_query=cats", /search results link/i);
  });

  it("refuses a YouTube URL carrying no video id", () => {
    refuses("https://www.youtube.com/", /does not point at a video/i);
    refuses("https://www.youtube.com/watch", /does not point at a video/i);
    refuses("https://www.youtube.com/shorts/", /does not point at a video/i);
    refuses("https://youtu.be/", /does not point at a video/i);
    refuses("https://www.youtube.com/feed/subscriptions", /does not point at a video/i);
  });

  it("refuses a malformed id in an otherwise valid YouTube URL", () => {
    // The core of §4: the host being right does not make the id trustworthy.
    refuses("https://www.youtube.com/watch?v=short", /does not contain a youtube video id/i);
    refuses(`https://www.youtube.com/watch?v=${ID}extra`, /does not contain a youtube video id/i);
    refuses("https://www.youtube.com/watch?v=../../../etc/pw", /does not contain a youtube video id/i);
    refuses("https://youtu.be/notanid", /does not contain a youtube video id/i);
    refuses(
      "https://www.youtube.com/shorts/%2E%2E%2F%2E%2E%2Fadmin",
      /does not contain a youtube video id/i,
    );
    refuses(
      `https://www.youtube.com/watch?v=${ID}%27%20or%201%3D1`,
      /does not contain a youtube video id/i,
    );
  });

  it("refuses a bare string that is not a valid id", () => {
    // A word is not an id and not a URL. It reaches the host check because
    // `https://` is prepended for scheme-less pastes, and "cocomelon" is not a
    // YouTube host — which is the more useful of the two possible refusals.
    refuses("cocomelon", /not a youtube link/i);
    refuses("how to grow on youtube", /not a youtube link|not a valid url/i);
  });
});

describe("tryParseYouTubeLink", () => {
  it("returns the parse for a good link and null for a bad one", () => {
    // The non-throwing variant exists for as-you-type hinting, where a refusal is
    // not yet an error the user should see.
    expect(tryParseYouTubeLink(`https://youtu.be/${ID}`)?.videoId).toBe(ID);
    expect(tryParseYouTubeLink("https://www.youtube.com/playlist?list=PL1")).toBeNull();
    expect(tryParseYouTubeLink("")).toBeNull();
  });
});
