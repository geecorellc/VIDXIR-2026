/**
 * Analytics, revenue attribution and thumbnail A/B testing (Phase 9 §17).
 *
 * Everything asserted here is a property of the SQL that actually runs, which is
 * why it is an integration test rather than a mocked one. Three of the four
 * families below cannot be proven any other way:
 *
 *  1. **Idempotence, and the NULL-distinct defect specifically.** Before Phase 9
 *     the channel-level snapshot index was `(channel_id, published_video_id,
 *     date)` unconditionally, and because Postgres treats NULLs as distinct,
 *     `(channel, NULL, date)` never conflicted with itself — so a re-pull
 *     duplicated every channel row and `ON CONFLICT` had no arbiter to match.
 *     `ingests the same window twice without duplicating` is the test that would
 *     have caught it: it fails against the old index and passes against the two
 *     partial ones. A mocked database would have happily reported success.
 *
 *  2. **Absence versus zero, through a real round-trip.** `sum()` over an empty
 *     set is SQL NULL and `Number(null)` is 0, so the difference between "no rows"
 *     and "measured zero" is destroyed by any naive read. The assertions go
 *     through `numeric` columns and the postgres.js driver, because that is where
 *     the distinction is actually at risk.
 *
 *  3. **Exact money.** Revenue is summed in Postgres `numeric` and compared as a
 *     string. A float pipeline passes a one-row test and fails a thirty-row one,
 *     so the revenue cases use values chosen to drift: 0.1, 0.2, and thirds of a
 *     cent.
 *
 *  4. **Tenant isolation.** Every read is asserted from the wrong tenant's
 *     perspective as well as the right one, and the A/B service is asserted to
 *     drop foreign arm ids rather than write them.
 *
 * ## What is real here, and what is not
 *
 * Real: Postgres, the migrations, both partial unique indexes, the `numeric`
 * columns and their driver round-trip, `ingestChannelAnalytics`'s upserts, the
 * whole reporting layer, the experiment service including its transaction and its
 * unique-violation translation, and `recomputeArmTotals`'s correlated UPDATE.
 *
 * Mocked: `fetchAnalytics` only — the single network call. §17 permits stubbing the
 * provider transport, and the alternative is not "a better test", it is either no
 * test or live YouTube quota spend against a channel this repository does not own.
 * Stated plainly for the §20 report: **these tests do not prove Tally can reach the
 * YouTube Analytics API.** They prove that every row it writes and every figure it
 * reports is correct on Tally's side of that boundary, which is the half YouTube
 * cannot verify for us.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  createChannel,
  createUser,
  hasDatabase,
  jar,
  resetDatabase,
  useDatabase,
  type TestUser,
} from "./setup";

vi.mock("next/headers", () => ({
  cookies: async () => jar,
}));

// ---------------------------------------------------------------------------
// Provider boundary
// ---------------------------------------------------------------------------

/**
 * Hoisted so the `vi.mock` factory can close over it: vitest lifts the factory
 * above the imports, and a plain `const` would not exist yet when it runs.
 */
const google = vi.hoisted(() => ({ fetchAnalytics: vi.fn() }));

vi.mock("@/lib/providers/youtube", async (importOriginal) => {
  // `importOriginal` rather than a dynamic import of the same path, which would
  // resolve back to the mock and deadlock. Everything except the network call —
  // scope helpers, the currency constant, the error classes — stays real.
  const actual = await importOriginal<typeof import("@/lib/providers/youtube")>();
  return { ...actual, fetchAnalytics: google.fetchAnalytics };
});

const MONETARY_SCOPE =
  "https://www.googleapis.com/auth/youtube.upload " +
  "https://www.googleapis.com/auth/yt-analytics.readonly " +
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly";

/** A provider row with everything absent, so each test states only what it means. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    date: "2026-06-01",
    videoId: null,
    views: null,
    likes: null,
    comments: null,
    shares: null,
    subscribersGained: null,
    subscribersLost: null,
    watchTimeMinutes: null,
    averageViewDurationSeconds: null,
    averageViewPercentage: null,
    estimatedRevenue: null,
    revenueRequested: false,
    currency: null,
    ...overrides,
  };
}

/** Channel-level metrics for a day, with no revenue. */
function metricsRow(date: string, overrides: Record<string, unknown> = {}) {
  return row({
    date,
    views: 1_000,
    likes: 40,
    comments: 5,
    shares: 3,
    subscribersGained: 12,
    subscribersLost: 2,
    watchTimeMinutes: 2_400,
    averageViewDurationSeconds: 144,
    averageViewPercentage: 48.5,
    ...overrides,
  });
}

/** A day with revenue, as the API returns it once the monetary scope is granted. */
function revenueRow(date: string, amount: string | null) {
  return metricsRow(date, {
    estimatedRevenue: amount,
    revenueRequested: true,
    currency: "USD",
  });
}

/**
 * Program the two `fetchAnalytics` calls the ingest makes — channel totals first,
 * per-video second — by inspecting the query rather than by call order, so a
 * reordering inside the ingest cannot make a test pass for the wrong reason.
 */
function respondWith(channelRows: unknown[], videoRows: unknown[] = []) {
  google.fetchAnalytics.mockImplementation(
    async (_token: string, query: { byVideo?: boolean }) =>
      query.byVideo ? videoRows : channelRows,
  );
}

const RANGE = {
  start: new Date("2026-05-01T00:00:00Z"),
  end: new Date("2026-07-01T00:00:00Z"),
};

const suite = hasDatabase ? describe : describe.skip;

suite("analytics and thumbnail A/B testing (integration)", () => {
  useDatabase();

  beforeEach(async () => {
    await resetDatabase();
    google.fetchAnalytics.mockReset();
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  /**
   * A user with a channel, and optionally the monetary scope.
   *
   * `createChannel` writes the Phase 2 grant (`youtube.upload` only), so the
   * revenue tests widen it explicitly — which is also the point: whether Tally
   * asks YouTube for money is decided by the stored grant, never by an argument
   * (§12).
   */
  async function tenant(
    email: string,
    options: { monetary?: boolean } = {},
  ): Promise<{ user: TestUser; channelId: string }> {
    const user = await createUser({ email });
    const channelId = await createChannel(user.id, {
      youtubeChannelId: `UC${email.replace(/\W/g, "").padEnd(22, "0").slice(0, 22)}`,
    });
    if (options.monetary) {
      const { db } = await import("@/lib/db");
      const { channels } = await import("@/lib/db/schema");
      await db
        .update(channels)
        .set({ grantedScopes: MONETARY_SCOPE })
        .where(eq(channels.id, channelId));
    }
    return { user, channelId };
  }

  /** A published video row, which is what an experiment attaches to (§42). */
  async function publishedVideo(
    userId: string,
    channelId: string,
    youtubeVideoId: string,
  ): Promise<{ id: string; projectId: string }> {
    const { db } = await import("@/lib/db");
    const { publishedVideos } = await import("@/lib/db/schema");
    const { createProject } = await import("@/lib/projects/service");

    const project = await createProject({
      userId,
      channelId,
      title: `Video ${youtubeVideoId}`,
    });
    const [published] = await db
      .insert(publishedVideos)
      .values({
        projectId: project.id,
        userId,
        channelId,
        youtubeVideoId,
        url: `https://youtu.be/${youtubeVideoId}`,
        uploadStatus: "processed",
        privacyStatus: "public",
        publishedAt: new Date("2026-06-01T10:00:00Z"),
      })
      .returning({ id: publishedVideos.id });
    if (!published) throw new Error("failed to insert published video");
    return { id: published.id, projectId: project.id };
  }

  /**
   * Thumbnail variants with rendered images, as Phase 6a leaves them.
   *
   * Written directly rather than by running the generator: the A/B service only
   * requires that the rows exist, belong to the user and carry an
   * `imageAssetId`, and re-running the render pipeline here would test Phase 6a
   * rather than Phase 9.
   */
  async function variants(
    userId: string,
    projectId: string,
    count: number,
    options: { withImage?: boolean } = {},
  ): Promise<string[]> {
    const { db } = await import("@/lib/db");
    const { assets, thumbnails, thumbnailVariants } = await import(
      "@/lib/db/schema"
    );
    const withImage = options.withImage !== false;

    const [thumbnail] = await db
      .insert(thumbnails)
      // `thumbnails.status` is the shared `job_status` enum, so a finished
      // generation is `succeeded` rather than a thumbnail-specific "ready".
      .values({ projectId, userId, status: "succeeded" })
      .returning({ id: thumbnails.id });
    if (!thumbnail) throw new Error("failed to insert thumbnail");

    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      let imageAssetId: string | null = null;
      if (withImage) {
        const [asset] = await db
          .insert(assets)
          .values({
            userId,
            projectId,
            // The kind Phase 6a's compositor writes for a finished thumbnail.
            kind: "thumbnail",
            storageKey: `test/thumb-${projectId}-${index}.png`,
            mimeType: "image/png",
            bytes: 1024,
          })
          .returning({ id: assets.id });
        imageAssetId = asset?.id ?? null;
      }
      const [variant] = await db
        .insert(thumbnailVariants)
        .values({
          thumbnailId: thumbnail.id,
          userId,
          index,
          headline: `Headline ${index}`,
          imageAssetId,
        })
        .returning({ id: thumbnailVariants.id });
      if (!variant) throw new Error("failed to insert thumbnail variant");
      ids.push(variant.id);
    }
    return ids;
  }

  async function snapshotRows(channelId: string, videoScoped: boolean) {
    const { db } = await import("@/lib/db");
    const { analyticsSnapshots } = await import("@/lib/db/schema");
    return db
      .select()
      .from(analyticsSnapshots)
      .where(
        and(
          eq(analyticsSnapshots.channelId, channelId),
          videoScoped
            ? sql`${analyticsSnapshots.publishedVideoId} is not null`
            : isNull(analyticsSnapshots.publishedVideoId),
        ),
      );
  }

  // -------------------------------------------------------------------------
  // 1. Ingestion and idempotence (§5)
  // -------------------------------------------------------------------------

  describe("ingestion", () => {
    it("writes one channel row per day", async () => {
      const { user, channelId } = await tenant("ingest-basic@tally.test");
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");
      respondWith([metricsRow("2026-06-01"), metricsRow("2026-06-02")]);

      const result = await ingestChannelAnalytics(user.id, channelId, {
        startDate: "2026-06-01",
        endDate: "2026-06-02",
      });

      expect(result.channelRows).toBe(2);
      const rows = await snapshotRows(channelId, false);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.views).sort()).toEqual([1_000, 1_000]);
    });

    it("ingests the same window twice without duplicating channel rows", async () => {
      /**
       * The NULL-distinct regression test.
       *
       * With the pre-Phase-9 index this inserts four rows for two days and
       * `ON CONFLICT` matches nothing, because `(channel, NULL, date)` is never
       * equal to itself under Postgres' NULL semantics. With the partial index it
       * upserts. There is no way to observe the difference without a real
       * database.
       */
      const { user, channelId } = await tenant("ingest-idem@tally.test");
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");
      const window = { startDate: "2026-06-01", endDate: "2026-06-02" };

      respondWith([metricsRow("2026-06-01"), metricsRow("2026-06-02")]);
      await ingestChannelAnalytics(user.id, channelId, window);
      // YouTube revised the second day upward, which is the normal case.
      respondWith([
        metricsRow("2026-06-01"),
        metricsRow("2026-06-02", { views: 1_800 }),
      ]);
      await ingestChannelAnalytics(user.id, channelId, window);

      const rows = await snapshotRows(channelId, false);
      expect(rows).toHaveLength(2);
      // Converged on the revised figure rather than accumulating to 2,800.
      expect(rows.map((r) => r.views).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
        1_000, 1_800,
      ]);
    });

    it("survives two concurrent ingests of the same window", async () => {
      /**
       * §5: conflict-safe writes rather than a read-then-write race. The old
       * implementation deleted the window before inserting, so two concurrent
       * ingests could both delete and both insert. Here they both upsert, and the
       * outcome is the same as one ingest.
       */
      const { user, channelId } = await tenant("ingest-race@tally.test");
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");
      const window = { startDate: "2026-06-01", endDate: "2026-06-01" };
      respondWith([metricsRow("2026-06-01")]);

      await Promise.all([
        ingestChannelAnalytics(user.id, channelId, window),
        ingestChannelAnalytics(user.id, channelId, window),
      ]);

      expect(await snapshotRows(channelId, false)).toHaveLength(1);
    });

    it("upserts per-video rows and reports videos it does not own", async () => {
      const { user, channelId } = await tenant("ingest-video@tally.test");
      const video = await publishedVideo(user.id, channelId, "vidOWNED0001");
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");

      respondWith(
        [metricsRow("2026-06-01")],
        [
          metricsRow("2026-06-01", { videoId: "vidOWNED0001", views: 700 }),
          // A video on the channel that Tally did not publish. Inventing a
          // `published_videos` row for it would claim Tally uploaded it.
          metricsRow("2026-06-01", { videoId: "vidFOREIGN01", views: 300 }),
        ],
      );

      const first = await ingestChannelAnalytics(user.id, channelId, {
        startDate: "2026-06-01",
        endDate: "2026-06-01",
      });
      expect(first.videoRows).toBe(1);
      expect(first.unmatchedVideoIds).toEqual(["vidFOREIGN01"]);

      // Re-ingest: still one row, so the video path upserts too.
      await ingestChannelAnalytics(user.id, channelId, {
        startDate: "2026-06-01",
        endDate: "2026-06-01",
      });
      const rows = await snapshotRows(channelId, true);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.publishedVideoId).toBe(video.id);
    });

    it("keeps a channel row and its video row distinct for the same day", async () => {
      // The two partial indexes must not interfere: one day produces one
      // channel-scoped row and one video-scoped row, and neither displaces the
      // other.
      const { user, channelId } = await tenant("ingest-both@tally.test");
      await publishedVideo(user.id, channelId, "vidBOTH00001");
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");

      respondWith(
        [metricsRow("2026-06-01", { views: 1_000 })],
        [metricsRow("2026-06-01", { videoId: "vidBOTH00001", views: 700 })],
      );
      await ingestChannelAnalytics(user.id, channelId, {
        startDate: "2026-06-01",
        endDate: "2026-06-01",
      });

      expect(await snapshotRows(channelId, false)).toHaveLength(1);
      expect(await snapshotRows(channelId, true)).toHaveLength(1);
    });

    it("records why CTR is absent instead of storing a plausible number", async () => {
      /**
       * §6, and the reason the whole `ctr_source` column exists: YouTube
       * Analytics v2 does not expose impression CTR at all, so the honest row has
       * a null `ctr` and a source that says the provider does not offer it —
       * which a reader can tell apart from "never ingested" (null source) and
       * from a measured zero.
       */
      const { user, channelId } = await tenant("ingest-ctr@tally.test");
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");
      respondWith([metricsRow("2026-06-01")]);
      await ingestChannelAnalytics(user.id, channelId, {
        startDate: "2026-06-01",
        endDate: "2026-06-01",
      });

      const [stored] = await snapshotRows(channelId, false);
      expect(stored?.ctr).toBeNull();
      expect(stored?.impressions).toBeNull();
      expect(stored?.ctrSource).toBe("provider_unsupported");
    });

    it("does not ask YouTube for revenue without the monetary scope", async () => {
      /**
       * §12: the grant is re-read from the database, so no caller argument can
       * cause a revenue request. Asserted on the actual query the provider
       * received, because the failure mode is a 403 that takes the view counts
       * down with it.
       */
      const { user, channelId } = await tenant("ingest-noscope@tally.test");
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");
      respondWith([metricsRow("2026-06-01")]);

      const result = await ingestChannelAnalytics(user.id, channelId, {
        startDate: "2026-06-01",
        endDate: "2026-06-01",
      });

      for (const call of google.fetchAnalytics.mock.calls) {
        expect(call[1].includeRevenue).toBe(false);
      }
      expect(result.revenue).toEqual({
        requested: false,
        state: "scope_missing",
        currency: null,
      });
      const [stored] = await snapshotRows(channelId, false);
      // Not 0.00 — the row says revenue was never asked for.
      expect(stored?.estimatedRevenue).toBeNull();
      expect(stored?.revenueState).toBe("not_requested");
    });

    it("asks for revenue once the monetary scope is granted", async () => {
      const { user, channelId } = await tenant("ingest-scope@tally.test", {
        monetary: true,
      });
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");
      respondWith([revenueRow("2026-06-01", "12.345600")]);

      const result = await ingestChannelAnalytics(user.id, channelId, {
        startDate: "2026-06-01",
        endDate: "2026-06-01",
      });

      expect(google.fetchAnalytics.mock.calls[0]?.[1].includeRevenue).toBe(true);
      expect(result.revenue.requested).toBe(true);
      const [stored] = await snapshotRows(channelId, false);
      expect(stored?.estimatedRevenue).toBe("12.345600");
      expect(stored?.revenueCurrency).toBe("USD");
      expect(stored?.revenueState).toBe("reported");
    });

    it("distinguishes a measured zero from an absent figure", async () => {
      // §6's three-way distinction, on the write path. Two days: one earned
      // nothing, one has no figure at all.
      const { user, channelId } = await tenant("ingest-zero@tally.test", {
        monetary: true,
      });
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");
      respondWith([
        revenueRow("2026-06-01", "0.000000"),
        revenueRow("2026-06-02", null),
      ]);
      await ingestChannelAnalytics(user.id, channelId, {
        startDate: "2026-06-01",
        endDate: "2026-06-02",
      });

      const rows = await snapshotRows(channelId, false);
      const byState = new Map(rows.map((r) => [r.revenueState, r]));
      expect(byState.get("reported_zero")?.estimatedRevenue).toBe("0.000000");
      // Absent, not zero.
      expect(byState.get("unavailable")?.estimatedRevenue).toBeNull();
    });

    it("refuses to ingest a channel belonging to another tenant", async () => {
      const owner = await tenant("ingest-owner@tally.test");
      const other = await tenant("ingest-other@tally.test");
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");
      respondWith([metricsRow("2026-06-01")]);

      await expect(
        ingestChannelAnalytics(other.user.id, owner.channelId, {
          startDate: "2026-06-01",
          endDate: "2026-06-01",
        }),
      ).rejects.toThrow();
      expect(await snapshotRows(owner.channelId, false)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Reporting: absence versus zero (§6)
  // -------------------------------------------------------------------------

  describe("reporting", () => {
    it("reports unavailable rather than zero when nothing was ingested", async () => {
      /**
       * The specific trap: `sum()` over no rows is SQL NULL and `Number(null)` is
       * 0, so a naive read turns "no data" into "zero views" — a claim about
       * performance rather than about collection.
       */
      const { user, channelId } = await tenant("report-empty@tally.test");
      const { channelPerformance } = await import("@/lib/analytics/report");

      const performance = await channelPerformance(user.id, channelId, RANGE);
      expect(performance.views.state).toBe("unavailable");
      expect(performance.views.value).toBeNull();
      expect(performance.measuredDays).toBe(0);
    });

    it("reports a measured zero as an available zero", async () => {
      // The other half of the same distinction: a day that genuinely had no views
      // must read back as 0, not as unavailable.
      const { user, channelId } = await tenant("report-zero@tally.test");
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");
      const { channelPerformance } = await import("@/lib/analytics/report");
      respondWith([metricsRow("2026-06-01", { views: 0, likes: 0 })]);
      await ingestChannelAnalytics(user.id, channelId, {
        startDate: "2026-06-01",
        endDate: "2026-06-01",
      });

      const performance = await channelPerformance(user.id, channelId, RANGE);
      expect(performance.views.state).toBe("available");
      expect(performance.views.value).toBe(0);
    });

    it("reports CTR as unsupported, not as unavailable", async () => {
      /**
       * §6 separates these because the wording differs: "unavailable" implies the
       * figure is coming later, and impression CTR never is — it is not in the
       * API at any scope.
       */
      const { user, channelId } = await tenant("report-ctr@tally.test");
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");
      const { channelPerformance } = await import("@/lib/analytics/report");
      respondWith([metricsRow("2026-06-01")]);
      await ingestChannelAnalytics(user.id, channelId, {
        startDate: "2026-06-01",
        endDate: "2026-06-01",
      });

      const performance = await channelPerformance(user.id, channelId, RANGE);
      expect(performance.ctr.state).toBe("unsupported");
      expect(performance.ctr.value).toBeNull();
      expect(performance.ctr.reason).toBe("provider_unsupported");
    });

    it("sums revenue exactly, through numeric and the driver", async () => {
      /**
       * §4. The values are chosen so a float pipeline drifts: 0.1 + 0.2 is
       * 0.30000000000000004 in IEEE-754, and thirds of a cent accumulate error
       * over thirty days. The assertion is on the string, so a float anywhere in
       * the path — Postgres column, driver, or the JS sum — shows up.
       */
      const { user, channelId } = await tenant("report-money@tally.test", {
        monetary: true,
      });
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");
      const { revenueSummary } = await import("@/lib/analytics/report");

      respondWith([
        revenueRow("2026-06-01", "0.100000"),
        revenueRow("2026-06-02", "0.200000"),
        revenueRow("2026-06-03", "0.003333"),
        revenueRow("2026-06-04", "1234.567891"),
      ]);
      await ingestChannelAnalytics(user.id, channelId, {
        startDate: "2026-06-01",
        endDate: "2026-06-04",
      });

      const revenue = await revenueSummary(user.id, { channelId, range: RANGE });
      expect(revenue.total.state).toBe("available");
      expect(revenue.total.value).toBe("1234.871224");
      expect(revenue.currency).toBe("USD");
      expect(revenue.measuredDays).toBe(4);
    });

    it("says why revenue is missing rather than reporting zero", async () => {
      const { user, channelId } = await tenant("report-noscope@tally.test");
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");
      const { revenueSummary } = await import("@/lib/analytics/report");
      respondWith([metricsRow("2026-06-01")]);
      await ingestChannelAnalytics(user.id, channelId, {
        startDate: "2026-06-01",
        endDate: "2026-06-01",
      });

      const revenue = await revenueSummary(user.id, { channelId, range: RANGE });
      expect(revenue.total.state).not.toBe("available");
      expect(revenue.total.value).toBeNull();
      // A permission fact, not $0.00.
      expect(revenue.state).toBe("not_requested");
    });

    it("marks a recent total as an estimate and an old one as final", async () => {
      /**
       * §7: YouTube revises recent earnings for weeks. A provisional total that
       * renders as settled is a small lie the UI would repeat every day.
       */
      const { user, channelId } = await tenant("report-final@tally.test", {
        monetary: true,
      });
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");
      const { revenueSummary } = await import("@/lib/analytics/report");
      const { analyticsDate, REVENUE_FINALISE_DAYS } = await import(
        "@/lib/channels/analytics"
      );

      const recent = analyticsDate(new Date(Date.now() - 2 * 86_400_000));
      const settled = analyticsDate(
        new Date(Date.now() - (REVENUE_FINALISE_DAYS + 10) * 86_400_000),
      );
      const wide = {
        start: new Date(Date.now() - 400 * 86_400_000),
        end: new Date(Date.now() + 86_400_000),
      };

      respondWith([revenueRow(settled, "5.000000")]);
      await ingestChannelAnalytics(user.id, channelId, {
        startDate: settled,
        endDate: settled,
      });
      const first = await revenueSummary(user.id, { channelId, range: wide });
      expect(first.final).toBe(true);

      respondWith([revenueRow(recent, "1.000000")]);
      await ingestChannelAnalytics(user.id, channelId, {
        startDate: recent,
        endDate: recent,
      });
      const second = await revenueSummary(user.id, { channelId, range: wide });
      // One unsettled day makes the whole total an estimate.
      expect(second.final).toBe(false);
      expect(second.total.value).toBe("6.000000");
    });

    it("refuses to total across currencies rather than converting", async () => {
      /**
       * §7. Converting would need a rate Tally does not have and would produce a
       * figure YouTube never reported. The honest answer is a refusal with a
       * stated reason.
       */
      const { user, channelId } = await tenant("report-mixed@tally.test", {
        monetary: true,
      });
      const { db } = await import("@/lib/db");
      const { analyticsSnapshots } = await import("@/lib/db/schema");
      const { revenueSummary } = await import("@/lib/analytics/report");

      await db.insert(analyticsSnapshots).values([
        {
          userId: user.id,
          channelId,
          date: new Date("2026-06-01T00:00:00Z"),
          estimatedRevenue: "10.000000",
          revenueCurrency: "USD",
          revenueState: "reported",
          revenueFinal: true,
        },
        {
          userId: user.id,
          channelId,
          date: new Date("2026-06-02T00:00:00Z"),
          estimatedRevenue: "10.000000",
          revenueCurrency: "EUR",
          revenueState: "reported",
          revenueFinal: true,
        },
      ]);

      const revenue = await revenueSummary(user.id, { channelId, range: RANGE });
      expect(revenue.state).toBe("mixed");
      expect(revenue.total.state).toBe("unavailable");
      expect(revenue.total.reason).toBe("mixed_currency");
      expect(revenue.total.value).toBeNull();
    });

    it("does not double-count video revenue into the channel total", async () => {
      /**
       * A video-level figure is a *component* of its channel's, so summing both
       * roughly doubles the total. Asserted by ingesting both scopes for one day
       * and checking the total is the channel figure alone.
       */
      const { user, channelId } = await tenant("report-double@tally.test", {
        monetary: true,
      });
      await publishedVideo(user.id, channelId, "vidDOUBLE001");
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");
      const { revenueSummary } = await import("@/lib/analytics/report");

      respondWith(
        [revenueRow("2026-06-01", "10.000000")],
        [
          {
            ...revenueRow("2026-06-01", "6.000000"),
            videoId: "vidDOUBLE001",
          },
        ],
      );
      await ingestChannelAnalytics(user.id, channelId, {
        startDate: "2026-06-01",
        endDate: "2026-06-01",
      });

      const revenue = await revenueSummary(user.id, { channelId, range: RANGE });
      expect(revenue.total.value).toBe("10.000000");
    });

    it("lists per-video attribution, and includes a video with no analytics", async () => {
      // A left join, deliberately: a published video with nothing ingested yet
      // must still appear, with unavailable metrics rather than zeroes.
      const { user, channelId } = await tenant("report-pervideo@tally.test", {
        monetary: true,
      });
      await publishedVideo(user.id, channelId, "vidHASDATA01");
      await publishedVideo(user.id, channelId, "vidNODATA001");
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");
      const { videoRevenueAttribution } = await import("@/lib/analytics/report");

      respondWith(
        [revenueRow("2026-06-01", "10.000000")],
        [{ ...revenueRow("2026-06-01", "4.500000"), videoId: "vidHASDATA01" }],
      );
      await ingestChannelAnalytics(user.id, channelId, {
        startDate: "2026-06-01",
        endDate: "2026-06-01",
      });

      const videos = await videoRevenueAttribution(user.id, channelId, RANGE, 10);
      expect(videos).toHaveLength(2);
      const withData = videos.find((v) => v.youtubeVideoId === "vidHASDATA01");
      const without = videos.find((v) => v.youtubeVideoId === "vidNODATA001");
      expect(withData?.revenue.value).toBe("4.500000");
      expect(without?.revenue.state).toBe("unavailable");
      expect(without?.views.state).toBe("unavailable");
    });

    it("preserves gaps in the daily series rather than zero-filling them", async () => {
      // A zero-filled gap draws a chart that says traffic stopped; a gap says
      // Tally has no figure. §6.
      const { user, channelId } = await tenant("report-series@tally.test");
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");
      const { dailySeries } = await import("@/lib/analytics/report");
      respondWith([metricsRow("2026-06-01"), metricsRow("2026-06-03")]);
      await ingestChannelAnalytics(user.id, channelId, {
        startDate: "2026-06-01",
        endDate: "2026-06-03",
      });

      const series = await dailySeries(user.id, channelId, RANGE);
      expect(series).toHaveLength(2);
      expect(series.map((p) => p.date)).toEqual(["2026-06-01", "2026-06-03"]);
      // Impression CTR is not in the API, so every point's ctr is null.
      expect(series.every((p) => p.ctr === null)).toBe(true);
    });

    it("does not read another tenant's analytics", async () => {
      const owner = await tenant("report-owner@tally.test", { monetary: true });
      const other = await tenant("report-intruder@tally.test");
      const { ingestChannelAnalytics } = await import("@/lib/channels/analytics");
      const { channelPerformance, revenueSummary } = await import(
        "@/lib/analytics/report"
      );
      respondWith([revenueRow("2026-06-01", "99.000000")]);
      await ingestChannelAnalytics(owner.user.id, owner.channelId, {
        startDate: "2026-06-01",
        endDate: "2026-06-01",
      });

      /**
       * The channel id is the *owner's*, supplied by the wrong user. The read
       * layer filters on `user_id` in SQL, so the answer is empty rather than the
       * owner's figures — the tenant predicate is not a route-level check that a
       * direct service call could bypass (§12).
       */
      const performance = await channelPerformance(
        other.user.id,
        owner.channelId,
        RANGE,
      );
      expect(performance.views.state).toBe("unavailable");
      const revenue = await revenueSummary(other.user.id, {
        channelId: owner.channelId,
        range: RANGE,
      });
      expect(revenue.total.value).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Thumbnail A/B testing (§8, §9, §10)
  // -------------------------------------------------------------------------

  describe("thumbnail experiments", () => {
    /** A running experiment over `armCount` variants of one published video. */
    async function runningExperiment(
      email: string,
      armCount = 2,
    ): Promise<{
      user: TestUser;
      channelId: string;
      experimentId: string;
      armIds: string[];
    }> {
      const { user, channelId } = await tenant(email);
      const video = await publishedVideo(
        user.id,
        channelId,
        `vid${email.replace(/\W/g, "").slice(0, 9).padEnd(9, "0")}`,
      );
      const variantIds = await variants(user.id, video.projectId, armCount);
      const { createExperiment, startExperiment } = await import(
        "@/lib/analytics/experiments"
      );

      const created = await createExperiment({
        userId: user.id,
        publishedVideoId: video.id,
        variantIds,
        controlVariantId: variantIds[0] as string,
      });
      await startExperiment(user.id, created.id);
      return {
        user,
        channelId,
        experimentId: created.id,
        armIds: created.arms.map((a) => a.id),
      };
    }

    it("creates a draft over existing variants without generating anything", async () => {
      /**
       * §8: no second thumbnail pipeline. The arms reference the Phase 6a rows,
       * and the count of `thumbnail_variants` is unchanged by creating a test.
       */
      const { user, channelId } = await tenant("exp-create@tally.test");
      const video = await publishedVideo(user.id, channelId, "vidCREATE001");
      const variantIds = await variants(user.id, video.projectId, 3);
      const { db } = await import("@/lib/db");
      const { thumbnailVariants } = await import("@/lib/db/schema");
      const { createExperiment } = await import("@/lib/analytics/experiments");

      const before = await db
        .select({ n: sql<string>`count(*)` })
        .from(thumbnailVariants)
        .where(eq(thumbnailVariants.userId, user.id));

      const experiment = await createExperiment({
        userId: user.id,
        publishedVideoId: video.id,
        variantIds,
        controlVariantId: variantIds[1] as string,
      });

      const after = await db
        .select({ n: sql<string>`count(*)` })
        .from(thumbnailVariants)
        .where(eq(thumbnailVariants.userId, user.id));

      expect(experiment.status).toBe("draft");
      expect(experiment.arms).toHaveLength(3);
      expect(experiment.arms.filter((a) => a.isControl)).toHaveLength(1);
      // Positions are assigned server-side from the list order.
      expect(experiment.arms.map((a) => a.position)).toEqual([0, 1, 2]);
      expect(after[0]?.n).toBe(before[0]?.n);
    });

    it("refuses a second live test on the same video", async () => {
      /**
       * §5: the partial unique index is the guard, and the violation is
       * translated — not pre-checked, which would be a read-then-write race.
       * Asserted with two *concurrent* creates, where a pre-check would let both
       * through.
       */
      const { user, channelId } = await tenant("exp-conflict@tally.test");
      const video = await publishedVideo(user.id, channelId, "vidCONFLIC01");
      const variantIds = await variants(user.id, video.projectId, 2);
      const { createExperiment } = await import("@/lib/analytics/experiments");
      const { ConflictError } = await import("@/lib/errors");

      const attempt = () =>
        createExperiment({
          userId: user.id,
          publishedVideoId: video.id,
          variantIds,
          controlVariantId: variantIds[0] as string,
        });

      const results = await Promise.allSettled([attempt(), attempt()]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        ConflictError,
      );
    });

    it("refuses variants from another project", async () => {
      // Testing another project's thumbnails on this video would attribute one
      // video's impressions to an unrelated image.
      const { user, channelId } = await tenant("exp-crossproj@tally.test");
      const video = await publishedVideo(user.id, channelId, "vidCROSSPR01");
      const other = await publishedVideo(user.id, channelId, "vidOTHERPR01");
      const foreign = await variants(user.id, other.projectId, 2);
      const { createExperiment } = await import("@/lib/analytics/experiments");
      const { ForbiddenError } = await import("@/lib/errors");

      await expect(
        createExperiment({
          userId: user.id,
          publishedVideoId: video.id,
          variantIds: foreign,
          controlVariantId: foreign[0] as string,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("refuses another tenant's variants and another tenant's video", async () => {
      const owner = await tenant("exp-owner@tally.test");
      const other = await tenant("exp-thief@tally.test");
      const ownerVideo = await publishedVideo(
        owner.user.id,
        owner.channelId,
        "vidOWNVID001",
      );
      const ownerVariants = await variants(owner.user.id, ownerVideo.projectId, 2);
      const otherVideo = await publishedVideo(
        other.user.id,
        other.channelId,
        "vidTHFVID001",
      );
      await variants(other.user.id, otherVideo.projectId, 2);
      const { createExperiment } = await import("@/lib/analytics/experiments");

      // Someone else's video.
      await expect(
        createExperiment({
          userId: other.user.id,
          publishedVideoId: ownerVideo.id,
          variantIds: ownerVariants,
          controlVariantId: ownerVariants[0] as string,
        }),
      ).rejects.toThrow();

      // Own video, someone else's variants.
      await expect(
        createExperiment({
          userId: other.user.id,
          publishedVideoId: otherVideo.id,
          variantIds: ownerVariants,
          controlVariantId: ownerVariants[0] as string,
        }),
      ).rejects.toThrow();
    });

    it("refuses a variant with no rendered image", async () => {
      // An arm with no image can never earn an impression, so the test would be
      // permanently insufficient rather than merely slow.
      const { user, channelId } = await tenant("exp-noimage@tally.test");
      const video = await publishedVideo(user.id, channelId, "vidNOIMAGE01");
      const variantIds = await variants(user.id, video.projectId, 2, {
        withImage: false,
      });
      const { createExperiment } = await import("@/lib/analytics/experiments");
      const { ValidationError } = await import("@/lib/errors");

      await expect(
        createExperiment({
          userId: user.id,
          publishedVideoId: video.id,
          variantIds,
          controlVariantId: variantIds[0] as string,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("records observations idempotently and recomputes totals from them", async () => {
      /**
       * §5. Totals are recomputed with SUM over the observation rows rather than
       * incremented, so posting the same day twice converges. An incrementing
       * implementation would double the impressions here.
       */
      const { user, experimentId, armIds } = await runningExperiment(
        "exp-obs@tally.test",
      );
      const { getExperiment, recordObservations } = await import(
        "@/lib/analytics/experiments"
      );
      const day = (n: number) => new Date(`2026-06-0${n}T00:00:00.000Z`);

      const observations = [
        {
          armId: armIds[0] as string,
          date: day(1),
          impressions: 1_000,
          clicks: 100,
          views: 90,
          source: "derived_views_impressions" as const,
        },
        {
          armId: armIds[1] as string,
          date: day(1),
          impressions: 1_000,
          clicks: 50,
          views: 45,
          source: "derived_views_impressions" as const,
        },
      ];

      await recordObservations(user.id, experimentId, observations);
      await recordObservations(user.id, experimentId, observations);

      const experiment = await getExperiment(user.id, experimentId);
      const arms = experiment?.arms ?? [];
      expect(arms[0]?.impressions).toBe(1_000);
      expect(arms[0]?.clicks).toBe(100);
      expect(arms[0]?.observationDays).toBe(1);
      // Exact, from `numeric`: 100/1000.
      expect(arms[0]?.ctr).toBe("0.100000");
      expect(arms[1]?.ctr).toBe("0.050000");
    });

    it("drops an arm id from another experiment instead of writing it", async () => {
      // §12: arm ids are re-resolved against the experiment and the user, so a
      // foreign id is skipped rather than stored under this test.
      const mine = await runningExperiment("exp-mine@tally.test");
      const theirs = await runningExperiment("exp-theirs@tally.test");
      const { getExperiment, recordObservations } = await import(
        "@/lib/analytics/experiments"
      );

      const result = await recordObservations(mine.user.id, mine.experimentId, [
        {
          armId: mine.armIds[0] as string,
          date: new Date("2026-06-01T00:00:00.000Z"),
          impressions: 500,
          clicks: 20,
          views: 18,
          source: "derived_views_impressions",
        },
        {
          armId: theirs.armIds[0] as string,
          date: new Date("2026-06-01T00:00:00.000Z"),
          impressions: 999_999,
          clicks: 999_999,
          views: 999_999,
          source: "derived_views_impressions",
        },
      ]);

      expect(result.written).toBe(1);
      expect(result.skipped).toBe(1);
      const victim = await getExperiment(theirs.user.id, theirs.experimentId);
      expect(victim?.arms[0]?.impressions).toBeNull();
    });

    it("leaves a test running when the data is insufficient", async () => {
      /**
       * §10, end to end through the database: the arms have a 2× CTR difference
       * on 20 impressions, and the test stays open with no winner recorded.
       */
      const { user, experimentId, armIds } = await runningExperiment(
        "exp-insuff@tally.test",
      );
      const { concludeExperiment, getExperiment, recordObservations } =
        await import("@/lib/analytics/experiments");

      await recordObservations(user.id, experimentId, [
        {
          armId: armIds[0] as string,
          date: new Date("2026-06-01T00:00:00.000Z"),
          impressions: 20,
          clicks: 4,
          views: 4,
          source: "derived_views_impressions",
        },
        {
          armId: armIds[1] as string,
          date: new Date("2026-06-01T00:00:00.000Z"),
          impressions: 20,
          clicks: 2,
          views: 2,
          source: "derived_views_impressions",
        },
      ]);

      const outcome = await concludeExperiment(user.id, experimentId);
      expect(outcome.concluded).toBe(false);
      expect(outcome.decision.outcome).toBe("insufficient_data");

      const experiment = await getExperiment(user.id, experimentId);
      expect(experiment?.status).toBe("running");
      expect(experiment?.winningArmId).toBeNull();
      expect(experiment?.outcome).toBeNull();
    });

    it("concludes with a winner once the minimums are met, without touching the thumbnail", async () => {
      /**
       * §8's hard rule: declaring a winner records a decision and does **not**
       * swap the live thumbnail. Asserted on `published_videos.thumbnailVariantId`,
       * which must be exactly what it was before the test concluded.
       */
      const { user, experimentId, armIds } = await runningExperiment(
        "exp-winner@tally.test",
      );
      const { db } = await import("@/lib/db");
      const { publishedVideos, thumbnailExperiments } = await import(
        "@/lib/db/schema"
      );
      const { concludeExperiment, getExperiment, recordObservations } =
        await import("@/lib/analytics/experiments");

      // Four days per arm, comfortably over the 1,000-impression minimum, with a
      // 2× CTR gap.
      const observations = [];
      for (let day = 1; day <= 4; day += 1) {
        const date = new Date(`2026-06-0${day}T00:00:00.000Z`);
        observations.push(
          {
            armId: armIds[0] as string,
            date,
            impressions: 500,
            clicks: 50,
            views: 45,
            source: "derived_views_impressions" as const,
          },
          {
            armId: armIds[1] as string,
            date,
            impressions: 500,
            clicks: 25,
            views: 22,
            source: "derived_views_impressions" as const,
          },
        );
      }
      await recordObservations(user.id, experimentId, observations);

      const [videoBefore] = await db
        .select({ variant: publishedVideos.thumbnailVariantId })
        .from(publishedVideos)
        .where(eq(publishedVideos.userId, user.id));

      const outcome = await concludeExperiment(user.id, experimentId);
      expect(outcome.concluded).toBe(true);
      expect(outcome.decision.outcome).toBe("winner");
      expect(outcome.decision.winningArmId).toBe(armIds[0]);
      expect(outcome.decision.statisticalConfidence).toBe("not_established");

      const experiment = await getExperiment(user.id, experimentId);
      expect(experiment?.status).toBe("completed");
      expect(experiment?.winningArmId).toBe(armIds[0]);
      // The decision is stored so a later read reports it as it was made.
      expect(experiment?.decision?.outcome).toBe("winner");
      expect(experiment?.decidedAt).not.toBeNull();

      const [videoAfter] = await db
        .select({ variant: publishedVideos.thumbnailVariantId })
        .from(publishedVideos)
        .where(eq(publishedVideos.userId, user.id));
      // Unchanged. Applying a winner is a separate, explicit act (§8).
      expect(videoAfter?.variant).toBe(videoBefore?.variant ?? null);

      // And the stored policy travelled with the row.
      const [stored] = await db
        .select({ policy: thumbnailExperiments.decisionPolicy })
        .from(thumbnailExperiments)
        .where(eq(thumbnailExperiments.id, experimentId));
      expect(stored?.policy).toMatchObject({ minImpressionsPerArm: 1_000 });
    });

    it("calls a narrow margin a tie rather than a winner", async () => {
      const { user, experimentId, armIds } = await runningExperiment(
        "exp-tie@tally.test",
      );
      const { concludeExperiment, getExperiment, recordObservations } =
        await import("@/lib/analytics/experiments");

      const observations = [];
      for (let day = 1; day <= 4; day += 1) {
        const date = new Date(`2026-06-0${day}T00:00:00.000Z`);
        // 10.4% vs 10.0% — a 4% relative lift, under the 10% margin.
        observations.push(
          {
            armId: armIds[0] as string,
            date,
            impressions: 500,
            clicks: 52,
            views: 50,
            source: "derived_views_impressions" as const,
          },
          {
            armId: armIds[1] as string,
            date,
            impressions: 500,
            clicks: 50,
            views: 48,
            source: "derived_views_impressions" as const,
          },
        );
      }
      await recordObservations(user.id, experimentId, observations);

      const outcome = await concludeExperiment(user.id, experimentId);
      expect(outcome.decision.outcome).toBe("tie");
      expect(outcome.decision.winningArmId).toBeNull();
      const experiment = await getExperiment(user.id, experimentId);
      expect(experiment?.winningArmId).toBeNull();
    });

    it("cannot be concluded by another tenant", async () => {
      const mine = await runningExperiment("exp-secure@tally.test");
      const other = await tenant("exp-outsider@tally.test");
      const {
        cancelExperiment,
        concludeExperiment,
        getExperiment,
        recordObservations,
      } = await import("@/lib/analytics/experiments");

      // Not readable.
      expect(await getExperiment(other.user.id, mine.experimentId)).toBeNull();
      // Not writable, by any of the three verbs.
      await expect(
        concludeExperiment(other.user.id, mine.experimentId),
      ).rejects.toThrow();
      await expect(
        cancelExperiment(other.user.id, mine.experimentId),
      ).rejects.toThrow();
      await expect(
        recordObservations(other.user.id, mine.experimentId, [
          {
            armId: mine.armIds[0] as string,
            date: new Date("2026-06-01T00:00:00.000Z"),
            impressions: 5_000,
            clicks: 5_000,
            views: 5_000,
            source: "derived_views_impressions",
          },
        ]),
      ).resolves.toMatchObject({ written: 0, skipped: 1 });

      const experiment = await getExperiment(mine.user.id, mine.experimentId);
      expect(experiment?.status).toBe("running");
      expect(experiment?.arms[0]?.impressions).toBeNull();
    });

    it("records a cancellation as stopped, with no winner", async () => {
      const { user, experimentId } = await runningExperiment(
        "exp-cancel@tally.test",
      );
      const { cancelExperiment, getExperiment } = await import(
        "@/lib/analytics/experiments"
      );

      await cancelExperiment(user.id, experimentId);
      const experiment = await getExperiment(user.id, experimentId);
      expect(experiment?.status).toBe("cancelled");
      expect(experiment?.outcome).toBe("stopped");
      expect(experiment?.winningArmId).toBeNull();
    });

    it("lists only the caller's own tests", async () => {
      const mine = await runningExperiment("exp-list-mine@tally.test");
      const theirs = await runningExperiment("exp-list-theirs@tally.test");
      const { listExperiments } = await import("@/lib/analytics/experiments");

      const listed = await listExperiments(mine.user.id, mine.channelId, 10);
      expect(listed.map((e) => e.id)).toEqual([mine.experimentId]);
      const other = await listExperiments(mine.user.id, theirs.channelId, 10);
      expect(other).toHaveLength(0);
    });
  });
});
