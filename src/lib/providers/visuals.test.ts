/**
 * Stock rendition selection (§12, §42).
 *
 * This pins the behaviour behind a real pipeline failure: Pexels served a 1080p
 * encode of a matching clip at 123 MB, over the 120 MB clip ceiling, and the
 * whole VISUALS stage failed with `asset_missing` for scene 1 — while three
 * smaller encodes of that same clip, and fourteen other candidate clips, were
 * never tried.
 *
 * Two decisions are asserted, because resolution does not predict file size and
 * the ceiling is only discovered mid-download:
 *
 *  1. renditions are ranked so a smaller encode of the same clip is the next
 *     thing tried, rather than the search giving up;
 *  2. only *oversize* is stepped over. A refused host or a DNS answer pointing
 *     inside the network is an SSRF control doing its job, and retrying a
 *     different URL from the same hostile response would defeat it — so that
 *     propagates.
 *
 * `fetchRemoteAsset` is stubbed rather than called: the network behaviour it
 * implements is covered in `fetch.test.ts`, and what matters here is which URL
 * the selector reaches for next after a refusal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "@/lib/errors";

const TEST_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://vidxir:vidxir@127.0.0.1:5432/vidxir_test",
  REDIS_URL: "redis://127.0.0.1:6379",
  S3_BUCKET: "vidxir-test",
  S3_ACCESS_KEY_ID: "test",
  S3_SECRET_ACCESS_KEY: "test",
  ENCRYPTION_KEY: "a".repeat(64),
  SESSION_SECRET: "b".repeat(64),
  VIDXIR_USE_MOCK_PROVIDERS: "false",
  VISUAL_PROVIDERS: "pexels",
  PEXELS_API_KEY: "unit-placeholder",
} as const;

/** Every URL the selector attempted, in order. */
let attempted: string[] = [];
/** Bytes to refuse, keyed by URL, with the reason. */
let refuse: Map<string, ProviderError> = new Map();
/** Search payloads served by the stubbed Pexels client, in order. */
let searchResults: unknown[] = [];

vi.mock("@/lib/providers/http", () => ({
  providerJson: () =>
    Promise.resolve(searchResults.shift() ?? { videos: [], photos: [] }),
  providerBytes: () => Promise.reject(new Error("not used")),
}));

vi.mock("@/lib/providers/fetch", async (importOriginal) => {
  // `isOversizeAsset` is the real predicate — stubbing it would test nothing.
  const mod =
    await importOriginal<typeof import("@/lib/providers/fetch")>();
  return {
    ...mod,
    fetchRemoteAsset: (url: string) => {
      attempted.push(url);
      const refusal = refuse.get(url);
      if (refusal) return Promise.reject(refusal);
      return Promise.resolve({
        bytes: Buffer.alloc(2048),
        contentType: "video/mp4",
        finalUrl: url,
      });
    },
  };
});

vi.mock("@/lib/providers/usage", () => ({
  // Pass-through: `api_usage` accounting is covered by its own tests.
  withUsage: (_ctx: unknown, run: () => Promise<unknown>) => run(),
}));

const { acquireVisual } = await import("@/lib/providers/visuals");
const { isOversizeAsset } = await import("@/lib/providers/fetch");

/** One clip offered at four encodes, largest first as Pexels returns them. */
function clip(id: number) {
  return {
    id,
    width: 1920,
    height: 1080,
    duration: 12,
    url: `https://www.pexels.com/video/${id}/`,
    user: { name: "Someone" },
    video_files: [
      { id: 1, quality: "hd", file_type: "video/mp4", width: 1920, height: 1080, link: `https://videos.pexels.com/${id}/1920.mp4` },
      { id: 2, quality: "hls", file_type: "video/hls", width: 1920, height: 1080, link: `https://videos.pexels.com/${id}/stream.m3u8` },
      { id: 3, quality: "sd", file_type: "video/mp4", width: 1280, height: 720, link: `https://videos.pexels.com/${id}/1280.mp4` },
      { id: 4, quality: "sd", file_type: "video/mp4", width: 640, height: 360, link: `https://videos.pexels.com/${id}/640.mp4` },
    ],
  };
}

function oversize(): ProviderError {
  return new ProviderError("Pexels", "asset is 123MB, over the 120MB limit", {
    retryable: false,
    details: { bytes: 129_000_000, oversize: true },
  });
}

const REQUEST = {
  sceneIndex: 0,
  visualPrompt: "macro computer screen pixels",
  searchTerms: ["macro computer screen pixels"],
  durationMs: 6_000,
} as const;

const USAGE = {
  usage: {
    operation: "visuals.acquire",
    userId: null,
    projectId: null,
    jobId: null,
    traceId: "unit",
  },
} as const;

beforeEach(() => {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    process.env[key] = value;
  }
  attempted = [];
  refuse = new Map();
  searchResults = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("isOversizeAsset", () => {
  it("distinguishes a ceiling refusal from every other provider fault", () => {
    expect(isOversizeAsset(oversize())).toBe(true);
    expect(
      isOversizeAsset(
        new ProviderError("Pexels", "download failed with HTTP 503", {
          retryable: true,
        }),
      ),
    ).toBe(false);
    expect(isOversizeAsset(new Error("boom"))).toBe(false);
    expect(isOversizeAsset(undefined)).toBe(false);
  });
});

describe("Pexels rendition selection", () => {
  it("prefers the largest encode at or under 1080p and skips the HLS playlist", async () => {
    searchResults = [{ videos: [clip(100)] }];

    const visual = await acquireVisual(REQUEST, USAGE);

    expect(attempted).toEqual(["https://videos.pexels.com/100/1920.mp4"]);
    expect(visual.width).toBe(1920);
    // An `.m3u8` is a playlist, not a file; a renderer handed one fails late.
    expect(attempted.some((u) => u.endsWith(".m3u8"))).toBe(false);
  });

  it("falls back to a smaller encode of the same clip when the best is oversize", async () => {
    // The live failure: 1080p over the ceiling, 720p of the same clip fine.
    searchResults = [{ videos: [clip(200)] }];
    refuse.set("https://videos.pexels.com/200/1920.mp4", oversize());

    const visual = await acquireVisual(REQUEST, USAGE);

    expect(attempted).toEqual([
      "https://videos.pexels.com/200/1920.mp4",
      "https://videos.pexels.com/200/1280.mp4",
    ]);
    expect(visual.width).toBe(1280);
    expect(visual.provider).toBe("pexels");
  });

  it("moves to the next clip when every encode of the first is oversize", async () => {
    searchResults = [{ videos: [clip(300), clip(400)] }];
    for (const width of [1920, 1280, 640]) {
      refuse.set(`https://videos.pexels.com/300/${width}.mp4`, oversize());
    }

    const visual = await acquireVisual(REQUEST, USAGE);

    expect(attempted).toEqual([
      "https://videos.pexels.com/300/1920.mp4",
      "https://videos.pexels.com/300/1280.mp4",
      "https://videos.pexels.com/300/640.mp4",
      "https://videos.pexels.com/400/1920.mp4",
    ]);
    expect(visual.providerAssetId).toBe("pexels:video:400");
  });

  it("does not try another rendition after a non-size failure", async () => {
    /**
     * A blocked host is the SSRF allow-list refusing the URL. Quietly downloading
     * a different link from the same response would be the selector working
     * around a security control, so the refusal has to stop the search for this
     * clip rather than being stepped over like an oversize encode.
     *
     * The error the *caller* sees is `AssetMissingError`, not the allow-list
     * message: `acquireVisual` deliberately reports a non-retryable source fault
     * as "this scene has no visual" (the retryable case is re-thrown instead), and
     * §33 keeps provider detail out of the response — the real reason is in the
     * `visual source failed` log line. What is pinned here is the search
     * behaviour: one attempt, then stop.
     */
    searchResults = [{ videos: [clip(500), clip(600)] }];
    refuse.set(
      "https://videos.pexels.com/500/1920.mp4",
      new ProviderError("Pexels", "asset host evil.test is not allow-listed", {
        retryable: false,
      }),
    );

    await expect(acquireVisual(REQUEST, USAGE)).rejects.toThrow(
      /Required asset is missing/,
    );
    // Not the 1280 encode, and not the second clip either.
    expect(attempted).toEqual(["https://videos.pexels.com/500/1920.mp4"]);
  });
});
