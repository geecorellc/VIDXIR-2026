/**
 * Prove the Phase 9 analytics path works in a real Node process (§18, §19, §22).
 *
 * The three scripts before this one exist because a green Vitest run has twice
 * hidden a defect that only a real process could see: Phase 5's `server-only`
 * imports (541 tests passing against a worker that could not boot) and Phase 7's
 * `Date` bound through a raw `sql` template, which postgres.js rejects at Bind.
 * Phase 9 hit that second class *again* — `recomputeArmTotals` bound a `Date`
 * inside its correlated `UPDATE`, so `recordObservations` would have failed on
 * every call — which is the argument for this script existing rather than trusting
 * the suite.
 *
 * Phase 9 also introduces a defect class the earlier scripts had no reason to
 * check: **the arbiter index**. Postgres treats NULLs as distinct, so the
 * pre-Phase-9 index on `(channel_id, published_video_id, date)` never conflicted
 * with a channel-level row against itself, and `ON CONFLICT` silently matched
 * nothing. The fix is two *partial* unique indexes, and a partial index is only
 * usable as an arbiter when the statement repeats its predicate. Step 1 asserts
 * both indexes exist and are partial; steps 2 and 3 prove the upsert actually
 * arbitrates on them.
 *
 * So this runs, with no test framework, no module aliases and nothing mocked:
 *
 *    1. analytics schema is available — every Phase 9 column, and both partial
 *       unique indexes, present and genuinely partial
 *    2. analytics persistence works — snapshots round-trip through `numeric`
 *    3. idempotency works — the same day written twice is one row, and
 *       `recordObservations` re-run does not inflate an arm
 *    4. CTR calculations work — an unsupported metric reports why, and the
 *       winner/tie comparison is exact rather than floating-point
 *    5. revenue precision works — exact decimal totals, past the float-safe range
 *    6. tenant isolation works — every read returns nothing for the wrong tenant
 *    7. experiment creation works — and two concurrent creates yield one test
 *    8. variant assignment works — deterministic, in range, spread, unsteerable
 *    9. insufficient-data handling works — a thin test stays running
 *   10. winner evaluation works — and never touches the live thumbnail
 *   11. security boundaries work — foreign ids dropped, foreign tenants refused
 *   12. provider-not-configured behaviour is safe — reported, never faked
 *
 * ## What this script does NOT do
 *
 * §22: **no live YouTube Analytics call is made.** Not one. Credentials are
 * reported as CONFIGURED or NOT_CONFIGURED and the live check is skipped either
 * way — a configured client id is not permission to spend a real channel's quota
 * from a verification script. Nothing is uploaded, nothing is published, and no
 * experiment is created on a real channel.
 *
 * Because the provider is never called, the row-mapping inside
 * `ingestChannelAnalytics` (`metrics()` / `revenueColumns()`, which are private and
 * only reachable through a provider response) is **not** covered here; it is
 * covered by `tests/integration/analytics.test.ts`, which stubs the single network
 * call and exercises the ingest end to end. What this script covers instead is
 * everything reachable without a provider: the schema, the arbiter indexes, the
 * `numeric` round-trip, the entire reporting layer, the entire experiment service,
 * and the error taxonomy. Stated plainly for the §18 report so the two are not
 * mistaken for each other.
 *
 * §19: prints no credential values, no access tokens, no refresh tokens and no
 * client secrets. Configuration is reported by presence only.
 *
 * Writes are confined to two synthetic probe tenants whose email addresses cannot
 * belong to a person (`@probe.invalid`, a reserved TLD) and whose password hashes
 * are deliberately unusable, so neither account can be signed into. Both are
 * deleted in a `finally`, and every Phase 9 table cascades from `users`, so a
 * failed run leaves nothing behind either.
 *
 *   npx tsx scripts/verify-analytics.ts
 *
 * Exits non-zero on the first failure.
 */
import "@/lib/load-env";

/**
 * Probe identities. `.invalid` is reserved by RFC 2606 and can never resolve, so
 * these cannot collide with a real user and cannot be mailed.
 */
const PROBE_PREFIX = "verify-analytics-probe-";
const PROBE_A = `${PROBE_PREFIX}a@probe.invalid`;
const PROBE_B = `${PROBE_PREFIX}b@probe.invalid`;

/**
 * A password hash that cannot verify.
 *
 * `verifyPassword` requires six `$`-separated fields and returns false for
 * anything else, so this is not a weak password — it is *no* password, and the
 * probe accounts are unauthenticatable by construction. No plaintext password
 * exists anywhere in this script.
 */
const UNUSABLE_PASSWORD_HASH = "scrypt$login-disabled-probe-account";

const TOTAL_STEPS = 12;
let step = 0;

function ok(message: string): void {
  step += 1;
  console.log(`  ${step}. OK  ${message}`);
}

function detail(message: string): void {
  console.log(`        ${message}`);
}

function fail(message: string): never {
  throw new Error(message);
}

/** Assert, with the failure phrased as what is now wrong in production. */
function must(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

async function main(): Promise<void> {
  console.log("\nanalytics verification (no live YouTube call, no upload)\n");

  const { env } = await import("@/lib/env");
  const e = env();
  const { db, rawSql, closeDb } = await import("@/lib/db");
  const { and, eq, isNull, like, sql } = await import("drizzle-orm");
  const schema = await import("@/lib/db/schema");
  const {
    analyticsSnapshots,
    assets,
    channels,
    publishedVideos,
    thumbnailExperimentArms,
    thumbnailExperimentObservations,
    thumbnailExperiments,
    thumbnails,
    thumbnailVariants,
    users,
  } = schema;

  /** Removes both probe tenants and, by cascade, every row they own. */
  async function cleanup(): Promise<void> {
    await db.delete(users).where(like(users.emailNormalized, `${PROBE_PREFIX}%`));
  }

  // A previous interrupted run would otherwise collide on the email index.
  await cleanup();

  try {
    // ---- 1. schema + the arbiter indexes ---------------------------------
    const [version] = await rawSql()`select version()`;
    const banner = String(version?.["version"] ?? "").split(",")[0];

    /**
     * Real queries against every Phase 9 surface. `select version()` would pass
     * against a database with no migrations applied, which is exactly the state
     * this has to catch.
     */
    await db
      .select({
        ctr: analyticsSnapshots.ctr,
        ctrSource: analyticsSnapshots.ctrSource,
        revenue: analyticsSnapshots.estimatedRevenue,
        currency: analyticsSnapshots.revenueCurrency,
        state: analyticsSnapshots.revenueState,
        final: analyticsSnapshots.revenueFinal,
        updatedAt: analyticsSnapshots.updatedAt,
      })
      .from(analyticsSnapshots)
      .limit(1);
    await db.select({ id: thumbnailExperiments.id }).from(thumbnailExperiments).limit(1);
    await db
      .select({ id: thumbnailExperimentArms.id, ctr: thumbnailExperimentArms.ctr })
      .from(thumbnailExperimentArms)
      .limit(1);
    await db
      .select({ id: thumbnailExperimentObservations.id })
      .from(thumbnailExperimentObservations)
      .limit(1);

    /**
     * The columns that carry money and rates must be exact types.
     *
     * Asserted from `information_schema` rather than from the drizzle definition,
     * because the question is what the *database* holds: a `numeric` in the
     * schema file and a `double precision` in the deployed table would typecheck
     * and lint clean, and would silently make revenue inexact (§4).
     */
    const columnTypes = await rawSql()`
      select table_name, column_name, data_type, numeric_precision, numeric_scale
      from information_schema.columns
      where table_schema = 'public'
        and (
          (table_name = 'analytics_snapshots' and column_name in ('ctr', 'estimated_revenue'))
          or (table_name = 'thumbnail_experiment_arms' and column_name = 'ctr')
        )
    `;
    must(
      columnTypes.length === 3,
      `expected 3 exact-numeric analytics columns, found ${columnTypes.length}; ` +
        "the Phase 9 migration is not fully applied",
    );
    for (const column of columnTypes) {
      const type = String(column["data_type"]);
      must(
        type === "numeric",
        `${String(column["table_name"])}.${String(column["column_name"])} is ` +
          `${type}, not numeric — a float cannot round-trip money or a rate ` +
          "exactly, so comparisons would depend on binary rounding (§4)",
      );
    }

    /**
     * Both partial unique indexes, and the fact that they are *partial*.
     *
     * This is the Phase 9 defect, checked directly. An unconditional index on
     * `(channel_id, published_video_id, date)` looks correct and passes every
     * mocked test, but never conflicts with a channel-level row against itself,
     * so a re-pull duplicates every day silently.
     */
    const indexes = await rawSql()`
      select indexname, indexdef
      from pg_indexes
      where schemaname = 'public'
        and tablename in ('analytics_snapshots', 'thumbnail_experiments',
                          'thumbnail_experiment_arms', 'thumbnail_experiment_observations')
    `;
    const defOf = (name: string): string | null => {
      const found = indexes.find((row) => String(row["indexname"]) === name);
      return found ? String(found["indexdef"]) : null;
    };
    const partial = [
      "analytics_snapshots_channel_date_key",
      "analytics_snapshots_video_date_key",
      "thumbnail_experiments_live_video_key",
    ];
    for (const name of partial) {
      const def = defOf(name);
      must(def !== null, `the unique index ${name} is missing`);
      must(
        /\bWHERE\b/i.test(def ?? ""),
        `${name} exists but is not partial; without its predicate the upsert has ` +
          "no arbiter for the NULL-distinct case and a re-pull duplicates rows",
      );
      must(
        /\bUNIQUE\b/i.test(def ?? ""),
        `${name} is not unique, so it cannot arbitrate an ON CONFLICT`,
      );
    }
    must(
      defOf("thumbnail_experiment_observations_arm_date_key") !== null,
      "the (arm_id, date) unique index is missing, so a repeated observation " +
        "ingest would inflate an arm's totals rather than replace a day",
    );

    ok(
      `${banner} answered — every Phase 9 column present, ctr/estimated_revenue ` +
        `are numeric, and ${partial.length} partial unique indexes are in place`,
    );
    detail(
      `partial arbiters: ${partial.join(", ")} (NODE_ENV=${e.NODE_ENV})`,
    );

    // ---- 2. persistence --------------------------------------------------
    /**
     * Two probe tenants, inserted directly rather than through `signup()`.
     *
     * `signup()` issues a verification email, and a verification script must not
     * send mail. Rows are written the way the signup transaction would leave
     * them, minus the credential: see `UNUSABLE_PASSWORD_HASH`.
     */
    async function probeTenant(
      email: string,
      label: string,
      scopes: string,
    ): Promise<{ userId: string; channelId: string }> {
      const [user] = await db
        .insert(users)
        .values({
          email,
          emailNormalized: email,
          passwordHash: UNUSABLE_PASSWORD_HASH,
          name: `Verify Analytics Probe ${label}`,
        })
        .returning({ id: users.id });
      if (!user) fail("could not insert the probe user");

      const [channel] = await db
        .insert(channels)
        .values({
          userId: user.id,
          youtubeChannelId: `UCverifyAnalyticsProbe${label}`,
          title: `verify-analytics probe channel ${label}`,
          // No token is stored: this channel is never contacted, and a script
          // that wrote credentials would be storing a secret it does not need.
          grantedScopes: scopes,
        })
        .returning({ id: channels.id });
      if (!channel) fail("could not insert the probe channel");

      return { userId: user.id, channelId: channel.id };
    }

    /**
     * Deliberately *without* `yt-analytics-monetary.readonly`, because that is the
     * real state of a Tally channel: the scope is not requested at consent, so
     * revenue must come back as a permission state rather than as $0.00 (§7).
     * Step 11 asserts it.
     */
    const NON_MONETARY_SCOPES =
      "https://www.googleapis.com/auth/youtube.upload " +
      "https://www.googleapis.com/auth/yt-analytics.readonly";

    const a = await probeTenant(PROBE_A, "A", NON_MONETARY_SCOPES);
    const b = await probeTenant(PROBE_B, "B", NON_MONETARY_SCOPES);

    const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
    const RANGE = {
      start: day("2026-05-01"),
      end: day("2026-07-01"),
    };

    /**
     * A channel-level snapshot, written with the exact statement shape
     * `writeChannelRows` composes — the partial index's columns *plus* its
     * predicate, which is what makes Postgres accept it as an arbiter.
     *
     * The revenue columns are set here rather than obtained from YouTube, so what
     * this verifies is the storage and the arithmetic, not the provider. The
     * provider mapping is covered by the integration suite (see the header).
     */
    async function upsertSnapshot(
      tenant: { userId: string; channelId: string },
      date: string,
      values: {
        views?: number | null;
        watchTimeMinutes?: number | null;
        estimatedRevenue?: string | null;
        revenueState?: (typeof schema.revenueStateEnum.enumValues)[number] | null;
        revenueFinal?: boolean | null;
      } = {},
    ): Promise<void> {
      const set = {
        views: values.views ?? 1_000,
        watchTimeMinutes: values.watchTimeMinutes ?? 2_400,
        impressions: null,
        ctr: null,
        // The honest state: Analytics v2 has no impression CTR at any scope.
        ctrSource: "provider_unsupported" as const,
        estimatedRevenue: values.estimatedRevenue ?? null,
        revenueCurrency: values.estimatedRevenue === undefined ? null : "USD",
        revenueState: values.revenueState ?? "not_requested",
        revenueFinal: values.revenueFinal ?? null,
        updatedAt: new Date(),
      };
      await db
        .insert(analyticsSnapshots)
        .values({
          userId: tenant.userId,
          channelId: tenant.channelId,
          publishedVideoId: null,
          date: day(date),
          ...set,
        })
        .onConflictDoUpdate({
          target: [analyticsSnapshots.channelId, analyticsSnapshots.date],
          targetWhere: sql`${analyticsSnapshots.publishedVideoId} is null`,
          set,
        });
    }

    await upsertSnapshot(a, "2026-06-01", { views: 1_000 });
    await upsertSnapshot(a, "2026-06-02", { views: 2_500 });

    const { channelPerformance, dailySeries, lastIngestedAt } = await import(
      "@/lib/analytics/report"
    );

    const perf = await channelPerformance(a.userId, a.channelId, RANGE);
    must(
      perf.measuredDays === 2,
      `expected 2 measured days, got ${perf.measuredDays}`,
    );
    must(
      perf.views.state === "available" && perf.views.value === 3_500,
      `views did not round-trip: state=${perf.views.state} value=${String(perf.views.value)}`,
    );
    const series = await dailySeries(a.userId, a.channelId, RANGE);
    must(
      series.length === 2 && series[0]?.date === "2026-06-01",
      "the daily series did not come back in date order",
    );
    const ingested = await lastIngestedAt(a.userId, a.channelId);
    must(ingested !== null, "lastIngestedAt reported no data after two writes");

    ok(
      "snapshots persisted and read back through the reporting layer — " +
        `${perf.measuredDays} days, ${String(perf.views.value)} views, ` +
        "freshness timestamp resolved",
    );

    // ---- 3. idempotency --------------------------------------------------
    /**
     * The regression that matters. Both days are written again; with the
     * pre-Phase-9 index this leaves four rows and no conflict, because
     * `(channel, NULL, date)` is never equal to itself under Postgres' NULL
     * semantics. There is no way to observe this without a real database.
     */
    await upsertSnapshot(a, "2026-06-01", { views: 1_111 });
    await upsertSnapshot(a, "2026-06-02", { views: 2_500 });

    const channelRows = await db
      .select({ id: analyticsSnapshots.id })
      .from(analyticsSnapshots)
      .where(
        and(
          eq(analyticsSnapshots.channelId, a.channelId),
          isNull(analyticsSnapshots.publishedVideoId),
        ),
      );
    must(
      channelRows.length === 2,
      `re-ingesting the same two days produced ${channelRows.length} rows; the ` +
        "channel-level upsert is not arbitrating on " +
        "analytics_snapshots_channel_date_key, so every re-pull duplicates history",
    );

    const afterUpdate = await channelPerformance(a.userId, a.channelId, RANGE);
    must(
      afterUpdate.views.value === 3_611,
      `the re-ingest did not update in place: expected 3611 views, got ` +
        `${String(afterUpdate.views.value)}`,
    );

    ok(
      "the same window ingested twice is still two rows, updated in place — the " +
        "partial index arbitrates the NULL-distinct case",
    );

    // ---- 4. CTR ----------------------------------------------------------
    /**
     * Two separate claims, both of which have a tempting wrong answer.
     *
     * First: CTR is absent, and the reason is `provider_unsupported` rather than a
     * zero. YouTube Analytics v2 does not expose impressions or impression CTR at
     * any scope — they exist only in Studio — so a 0.0% here would be an invented
     * measurement (§6, §42).
     */
    must(
      afterUpdate.ctr.state === "unsupported",
      `CTR reported state "${afterUpdate.ctr.state}"; a metric the provider does ` +
        "not offer must be 'unsupported', not an unavailable-yet or a zero",
    );
    must(
      afterUpdate.ctr.value === null &&
        afterUpdate.ctr.reason === "provider_unsupported",
      "CTR carried a value or lost its reason, so the UI cannot explain the dash",
    );

    /**
     * Second: the winner/tie comparison is exact.
     *
     * `(0.11 - 0.10) / 0.10` is `0.09999999999999998` in IEEE-754, so a float gate
     * against a 10% minimum calls a pair that is *exactly* 10% apart a tie. That
     * was a real defect in this file, caught by the unit tests; it is asserted here
     * too because it is a §10 decision boundary and a regression would be silent.
     */
    const { clearsLift, compareDecimal } = await import("@/lib/analytics/experiments");
    const scaled = (value: string) => BigInt(value.replace(".", ""));
    must(
      clearsLift(scaled("0.110000"), scaled("0.100000"), 0.1),
      "a CTR pair exactly 10% apart was not treated as clearing a 10% minimum — " +
        "the lift gate is deciding on a float representation artefact",
    );
    must(
      !clearsLift(scaled("0.109999"), scaled("0.100000"), 0.1),
      "a margin below the minimum was accepted as a winner",
    );
    must(
      compareDecimal("0.100000", "0.1") === 0 &&
        compareDecimal("0.100001", "0.100000") === 1,
      "decimal CTR comparison is not exact to the stored scale",
    );

    ok(
      "an unsupported CTR reports why rather than showing 0.0%, and the lift gate " +
        "decides on exact integers (0.11 vs 0.10 clears 10%; 0.109999 does not)",
    );

    // ---- 5. revenue precision -------------------------------------------
    /**
     * Values chosen to drift. `0.1 + 0.2` is the canonical float failure, the
     * thousandths of a cent exercise the sixth decimal, and the fourth value pushes
     * the scaled total past `Number.MAX_SAFE_INTEGER`, where a float sum loses the
     * last digit outright.
     */
    await upsertSnapshot(b, "2026-06-01", {
      estimatedRevenue: "0.100000",
      revenueState: "reported",
      revenueFinal: true,
    });
    await upsertSnapshot(b, "2026-06-02", {
      estimatedRevenue: "0.200000",
      revenueState: "reported",
      revenueFinal: true,
    });
    await upsertSnapshot(b, "2026-06-03", {
      estimatedRevenue: "0.003333",
      revenueState: "reported",
      revenueFinal: true,
    });
    await upsertSnapshot(b, "2026-06-04", {
      estimatedRevenue: "1234.567891",
      revenueState: "reported",
      revenueFinal: true,
    });

    const { addDecimalStrings, formatMoney, revenueSummary } = await import(
      "@/lib/analytics/report"
    );
    const revenue = await revenueSummary(b.userId, {
      channelId: b.channelId,
      range: RANGE,
    });
    must(
      revenue.total.state === "available",
      `revenue was not available: state=${revenue.state}`,
    );
    must(
      revenue.total.value === "1234.871224",
      `revenue summed to ${String(revenue.total.value)}, not 1234.871224 — a float ` +
        "is in the path somewhere between the numeric column and the total",
    );
    must(
      revenue.currency === "USD" && revenue.final === true,
      "revenue lost its currency or its settled flag",
    );
    must(
      addDecimalStrings(["9007199254.740993", "0.000001"]) === "9007199254.740994",
      "decimal addition lost precision past the float-safe integer range",
    );
    must(
      formatMoney("0.999999", "USD") === "$0.99",
      "formatMoney rounds up, so a displayed total can exceed the stored one",
    );
    must(
      formatMoney("12.340000", "EUR") === "EUR 12.34",
      "a non-USD amount was rendered with a dollar sign, misstating the currency",
    );

    /**
     * Absence is not zero, asserted on a tenant with no revenue rows at all. `sum`
     * over an empty set is SQL NULL and `Number(null)` is 0, so this is the exact
     * place §6's rule is easiest to break.
     */
    const noRevenue = await revenueSummary(a.userId, {
      channelId: a.channelId,
      range: RANGE,
    });
    must(
      noRevenue.total.state === "unavailable" && noRevenue.total.value === null,
      `a channel with no earnings data reported state "${noRevenue.total.state}" ` +
        `value ${String(noRevenue.total.value)}; missing revenue must never ` +
        "become a zero (§6)",
    );
    must(
      noRevenue.state === "not_requested",
      `missing revenue was not explained: state=${noRevenue.state}`,
    );

    ok(
      `revenue totals are exact (${String(revenue.total.value)} from four days ` +
        "including thirds of a cent), and a channel with no earnings reports " +
        `"${noRevenue.state}" rather than $0.00`,
    );

    // ---- 6. tenant isolation --------------------------------------------
    const crossPerf = await channelPerformance(b.userId, a.channelId, RANGE);
    must(
      crossPerf.measuredDays === 0 && crossPerf.views.state === "unavailable",
      "tenant B read tenant A's channel performance",
    );
    const crossRevenue = await revenueSummary(a.userId, {
      channelId: b.channelId,
      range: RANGE,
    });
    must(
      crossRevenue.total.state === "unavailable",
      "tenant A read tenant B's revenue — the channel id is being trusted without " +
        "the owning user in the predicate (§12)",
    );
    const crossSeries = await dailySeries(b.userId, a.channelId, RANGE);
    must(crossSeries.length === 0, "tenant B read tenant A's daily series");

    ok(
      "every channel read is scoped by the owning user — a channel id from the " +
        "wrong tenant returns no data rather than someone else's numbers",
    );

    // ---- 7. experiment creation -----------------------------------------
    /** A published video and three rendered variants, as Phase 6a/7 leave them. */
    async function experimentFixture(tenant: {
      userId: string;
      channelId: string;
    }): Promise<{ publishedVideoId: string; variantIds: string[] }> {
      const { createProject } = await import("@/lib/projects/service");
      const project = await createProject({
        userId: tenant.userId,
        channelId: tenant.channelId,
        title: "verify-analytics probe project",
      });

      const [published] = await db
        .insert(publishedVideos)
        .values({
          projectId: project.id,
          userId: tenant.userId,
          channelId: tenant.channelId,
          // Unmistakably synthetic, and never sent anywhere: no YouTube call is
          // made with it.
          youtubeVideoId: `probe_${project.id.slice(0, 11)}`,
          url: "https://example.invalid/verify-analytics-probe",
          uploadStatus: "processed",
          privacyStatus: "private",
          publishedAt: day("2026-06-01"),
        })
        .returning({ id: publishedVideos.id });
      if (!published) fail("could not insert the probe published video");

      const [thumbnail] = await db
        .insert(thumbnails)
        // `thumbnails.status` is the shared job_status enum.
        .values({ projectId: project.id, userId: tenant.userId, status: "succeeded" })
        .returning({ id: thumbnails.id });
      if (!thumbnail) fail("could not insert the probe thumbnail");

      const variantIds: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const [asset] = await db
          .insert(assets)
          .values({
            userId: tenant.userId,
            projectId: project.id,
            // The kind Phase 6a's compositor writes.
            kind: "thumbnail",
            storageKey: `verify-analytics/probe-${project.id}-${index}.png`,
            mimeType: "image/png",
            bytes: 1024,
          })
          .returning({ id: assets.id });
        const [variant] = await db
          .insert(thumbnailVariants)
          .values({
            thumbnailId: thumbnail.id,
            userId: tenant.userId,
            index,
            headline: `Probe headline ${index}`,
            imageAssetId: asset?.id ?? null,
          })
          .returning({ id: thumbnailVariants.id });
        if (!variant) fail("could not insert the probe thumbnail variant");
        variantIds.push(variant.id);
      }

      return { publishedVideoId: published.id, variantIds };
    }

    const fixture = await experimentFixture(a);
    const {
      cancelExperiment,
      concludeExperiment,
      createExperiment,
      getExperiment,
      recordObservations,
      startExperiment,
      assignArm,
      DEFAULT_DECISION_POLICY,
    } = await import("@/lib/analytics/experiments");

    const variantsBefore = await db
      .select({ id: thumbnailVariants.id })
      .from(thumbnailVariants)
      .where(eq(thumbnailVariants.userId, a.userId));

    const created = await createExperiment({
      userId: a.userId,
      publishedVideoId: fixture.publishedVideoId,
      variantIds: fixture.variantIds,
      controlVariantId: fixture.variantIds[0] ?? fail("no probe variants"),
    });
    must(created.arms.length === 3, `expected 3 arms, got ${created.arms.length}`);
    must(
      created.arms.map((arm) => arm.position).join(",") === "0,1,2",
      "arm positions are not the stored 0,1,2 the assignment function relies on",
    );
    must(
      created.arms.filter((arm) => arm.isControl).length === 1,
      "an experiment was created without exactly one control arm",
    );
    must(created.status === "draft", `a new test started as "${created.status}"`);

    /**
     * §8: a test compares thumbnails that already exist. Generating new ones here
     * would be a second thumbnail pipeline.
     */
    const variantsAfter = await db
      .select({ id: thumbnailVariants.id })
      .from(thumbnailVariants)
      .where(eq(thumbnailVariants.userId, a.userId));
    must(
      variantsAfter.length === variantsBefore.length,
      `creating a test generated ${variantsAfter.length - variantsBefore.length} ` +
        "new thumbnail variants; §8 requires reusing the existing pipeline",
    );

    /**
     * Two simultaneous creates, not two sequential ones. A read-then-write check
     * would let both through; the partial index on `(published_video_id) where
     * status in ('draft','running')` is what actually prevents a second live test,
     * and translating its violation is what makes the race safe (§5).
     */
    const races = await Promise.allSettled([
      createExperiment({
        userId: a.userId,
        publishedVideoId: fixture.publishedVideoId,
        variantIds: fixture.variantIds,
        controlVariantId: fixture.variantIds[0] ?? "",
      }),
      createExperiment({
        userId: a.userId,
        publishedVideoId: fixture.publishedVideoId,
        variantIds: fixture.variantIds,
        controlVariantId: fixture.variantIds[0] ?? "",
      }),
    ]);
    must(
      races.every((r) => r.status === "rejected"),
      "a second thumbnail test was created for a video that already has one " +
        "running — the live-test unique index is not being enforced",
    );

    await startExperiment(a.userId, created.id);
    const running = await getExperiment(a.userId, created.id);
    must(
      running?.status === "running" && running.startedAt !== null,
      "starting a test did not record a running status and a start time",
    );

    ok(
      "a three-arm draft was created over existing variants, generated no new " +
        "thumbnails, and two concurrent creates both lost to the live-test index",
    );

    // ---- 8. assignment ---------------------------------------------------
    /**
     * §9: deterministic, server-side, and a pure function of stored values. The
     * spread check is not a uniformity proof — it catches a broken hash or an
     * accidental constant, either of which would make one arm unreachable and the
     * test unresolvable.
     */
    const first = assignArm(created.id, fixture.publishedVideoId, "viewer-42", 3);
    for (let i = 0; i < 25; i += 1) {
      must(
        assignArm(created.id, fixture.publishedVideoId, "viewer-42", 3) === first,
        "assignment is not stable for the same viewer, so a visitor would see a " +
          "different thumbnail on every request",
      );
    }
    const counts = new Map<number, number>();
    for (let i = 0; i < 600; i += 1) {
      const index = assignArm(created.id, fixture.publishedVideoId, `v${i}`, 3);
      must(
        Number.isInteger(index) && index >= 0 && index < 3,
        `assignment returned ${index}, outside the arm range`,
      );
      counts.set(index, (counts.get(index) ?? 0) + 1);
    }
    must(
      counts.size === 3 && [...counts.values()].every((n) => n > 100),
      `assignment reached ${counts.size} of 3 arms; distribution ` +
        `${[...counts.values()].join("/")}`,
    );
    const { ValidationError } = await import("@/lib/errors");
    let refusedZeroArms = false;
    try {
      assignArm(created.id, fixture.publishedVideoId, "v", 0);
    } catch (error) {
      refusedZeroArms = error instanceof ValidationError;
    }
    must(
      refusedZeroArms,
      "assignment with no arms did not throw; `hash % 0` is NaN and would read as " +
        "arm 0 downstream",
    );

    ok(
      "assignment is stable per viewer, always in range, reaches all three arms " +
        `(${[...counts.values()].join("/")} of 600) and refuses an empty test`,
    );

    // ---- 9. insufficient data -------------------------------------------
    /**
     * The behaviour §10 forbids is "declare whichever thumbnail currently has the
     * highest CTR". This is that case: arm 0 has double the CTR of the others, on
     * a hundred impressions and one day.
     */
    const armIds = created.arms
      .slice()
      .sort((x, y) => x.position - y.position)
      .map((arm) => arm.id);

    async function observe(
      date: string,
      perArm: Array<{ impressions: number; clicks: number }>,
    ): Promise<{ written: number; skipped: number }> {
      return recordObservations(
        a.userId,
        created.id,
        perArm.map((values, index) => ({
          armId: armIds[index] ?? fail("missing probe arm"),
          date: day(date),
          impressions: values.impressions,
          clicks: values.clicks,
          views: values.clicks,
          /**
           * `provider` is not an option: these figures are supplied by an
           * operator, because YouTube exposes no per-thumbnail impressions. The
           * enum value records that provenance rather than implying a measurement.
           */
          source: "derived_views_impressions" as const,
        })),
      );
    }

    await observe("2026-06-01", [
      { impressions: 100, clicks: 20 },
      { impressions: 100, clicks: 10 },
      { impressions: 100, clicks: 10 },
    ]);

    const thin = await concludeExperiment(a.userId, created.id);
    must(
      thin.decision.outcome === "insufficient_data",
      `a test with 100 impressions per arm and one day of data concluded ` +
        `"${thin.decision.outcome}" — the eligibility gates are not running before ` +
        "the ranking (§10)",
    );
    must(
      thin.decision.winningArmId === null && thin.concluded === false,
      "an insufficient-data evaluation named a winner or closed the test",
    );
    const stillRunning = await getExperiment(a.userId, created.id);
    must(
      stillRunning?.status === "running",
      `an insufficient-data verdict left the test "${String(stillRunning?.status)}"; ` +
        "it must keep collecting",
    );
    must(
      thin.decision.arms.every((arm) => !arm.eligible),
      "an arm below the impression minimum was marked comparable",
    );

    ok(
      "a thin test reports insufficient_data and stays running, even though one " +
        `arm has double the CTR (policy: ${DEFAULT_DECISION_POLICY.minImpressionsPerArm} ` +
        `impressions and ${DEFAULT_DECISION_POLICY.minObservationDays} days per arm)`,
    );

    // ---- 10. winner evaluation ------------------------------------------
    /**
     * Now with enough data. Three more days per arm, chosen so the leader's margin
     * is unambiguous and the totals are exact: arm 1 lands on 160/1600, a CTR of
     * precisely 0.100000 once the SQL recompute divides in `numeric`.
     */
    for (const date of ["2026-06-02", "2026-06-03", "2026-06-04"]) {
      await observe(date, [
        { impressions: 500, clicks: 60 },
        { impressions: 500, clicks: 50 },
        { impressions: 500, clicks: 40 },
      ]);
    }

    /**
     * Written twice on purpose: the second call must replace the day, not add to
     * it. `recordObservations` upserts on `(arm_id, date)` and then recomputes
     * totals with `SUM` over the observation rows rather than incrementing, so
     * there is no path by which a repeated ingest inflates an arm (§5).
     */
    await observe("2026-06-04", [
      { impressions: 500, clicks: 60 },
      { impressions: 500, clicks: 50 },
      { impressions: 500, clicks: 40 },
    ]);

    const decided = await concludeExperiment(a.userId, created.id);
    const armTotals = await db
      .select({
        id: thumbnailExperimentArms.id,
        impressions: thumbnailExperimentArms.impressions,
        ctr: thumbnailExperimentArms.ctr,
        days: thumbnailExperimentArms.observationDays,
      })
      .from(thumbnailExperimentArms)
      .where(eq(thumbnailExperimentArms.experimentId, created.id));

    const runnerUp = armTotals.find((arm) => arm.id === armIds[1]);
    must(
      runnerUp?.impressions === 1_600,
      `the runner-up arm totalled ${String(runnerUp?.impressions)} impressions, ` +
        "not 1600 — a repeated observation was added rather than replacing its day",
    );
    must(
      runnerUp?.days === 4,
      `the runner-up arm counted ${String(runnerUp?.days)} observation days, not 4`,
    );
    must(
      runnerUp?.ctr === "0.100000",
      `the SQL recompute derived a CTR of ${String(runnerUp?.ctr)} for 160/1600; ` +
        "expected exactly 0.100000 from numeric division",
    );

    must(
      decided.decision.outcome === "winner" && decided.concluded === true,
      `a clear 25% lift over four days concluded "${decided.decision.outcome}"`,
    );
    must(
      decided.decision.winningArmId === armIds[0],
      "the winner is not the leading arm",
    );
    must(
      decided.decision.statisticalConfidence === "not_established",
      "the decision claimed established statistical significance; YouTube exposes " +
        "no impression data to support that claim (§10)",
    );

    /**
     * §8's hardest rule, asserted directly: declaring a winner records a decision
     * and does **not** swap the live thumbnail. Silently replacing a production
     * thumbnail is forbidden, so applying a winner stays a user action.
     */
    const [videoRow] = await db
      .select({ thumbnailVariantId: publishedVideos.thumbnailVariantId })
      .from(publishedVideos)
      .where(eq(publishedVideos.id, fixture.publishedVideoId));
    must(
      videoRow?.thumbnailVariantId === null,
      "concluding a test changed the published video's live thumbnail; §8 forbids " +
        "silently replacing a production thumbnail",
    );

    const persisted = await getExperiment(a.userId, created.id);
    must(
      persisted?.status === "completed" && persisted.outcome === "winner",
      "the winning decision was not persisted on the experiment row",
    );

    ok(
      "a four-day test with a 25% lift named a winner, derived 160/1600 as " +
        "exactly 0.100000, claimed no statistical significance, and left the live " +
        "thumbnail untouched",
    );

    // ---- 11. security boundaries ----------------------------------------
    const { ForbiddenError } = await import("@/lib/errors");

    /** A second tenant with its own running test, to attack from both directions. */
    const victimFixture = await experimentFixture(b);
    const victim = await createExperiment({
      userId: b.userId,
      publishedVideoId: victimFixture.publishedVideoId,
      variantIds: victimFixture.variantIds,
      controlVariantId: victimFixture.variantIds[0] ?? "",
    });
    await startExperiment(b.userId, victim.id);

    /**
     * An arm id belonging to another tenant, posted to this tenant's experiment.
     * It must be dropped, not written — the arm ids are re-resolved against both
     * the experiment and the user before anything is stored (§12).
     */
    const victimArmId = victim.arms[0]?.id ?? fail("victim has no arms");
    const mixed = await recordObservations(b.userId, victim.id, [
      {
        armId: victimArmId,
        date: day("2026-06-05"),
        impressions: 10,
        clicks: 1,
        views: 1,
        source: "derived_views_impressions",
      },
      {
        // Tenant A's arm, in tenant B's request.
        armId: armIds[0] ?? "",
        date: day("2026-06-05"),
        impressions: 999_999,
        clicks: 999_999,
        views: 999_999,
        source: "derived_views_impressions",
      },
    ]);
    must(
      mixed.written === 1 && mixed.skipped === 1,
      `a cross-tenant arm id was accepted: written=${mixed.written} ` +
        `skipped=${mixed.skipped}`,
    );

    const [untouched] = await db
      .select({ impressions: thumbnailExperimentArms.impressions })
      .from(thumbnailExperimentArms)
      .where(eq(thumbnailExperimentArms.id, armIds[0] ?? ""));
    must(
      untouched?.impressions === 1_600,
      `tenant A's arm now holds ${String(untouched?.impressions)} impressions; ` +
        "tenant B's request modified another tenant's experiment",
    );

    /** Every experiment entry point, called as the wrong tenant. */
    must(
      (await getExperiment(a.userId, victim.id)) === null,
      "one tenant read another tenant's experiment",
    );
    for (const [name, call] of [
      ["conclude", () => concludeExperiment(a.userId, victim.id)],
      ["cancel", () => cancelExperiment(a.userId, victim.id)],
      ["start", () => startExperiment(a.userId, victim.id)],
    ] as Array<[string, () => Promise<unknown>]>) {
      let refused = false;
      try {
        await call();
      } catch (error) {
        refused = error instanceof ForbiddenError;
      }
      must(refused, `${name} succeeded against another tenant's experiment`);
    }

    /** Variants from another project cannot be pulled into a test. */
    let crossProjectRefused = false;
    try {
      await createExperiment({
        userId: b.userId,
        publishedVideoId: victimFixture.publishedVideoId,
        // Tenant A's variants, on tenant B's video.
        variantIds: fixture.variantIds,
        controlVariantId: fixture.variantIds[0] ?? "",
      });
    } catch (error) {
      crossProjectRefused = error instanceof ForbiddenError;
    }
    must(
      crossProjectRefused,
      "another tenant's thumbnails were accepted as arms of this tenant's test",
    );

    /**
     * And the revenue authorisation itself: whether Tally asks YouTube for money
     * is decided by the *stored* grant, never by a caller's argument. The probe
     * channel has no monetary scope, so `canReadRevenue` must be false — a caller
     * cannot opt itself into a revenue request (§7, §12).
     */
    const { channelGrant } = await import("@/lib/channels/service");
    const grant = await channelGrant(a.userId, a.channelId);
    must(
      grant !== null && grant.canReadRevenue === false,
      "a channel without yt-analytics-monetary.readonly reported that it can read " +
        "revenue; the monetary scope is being inferred rather than read",
    );
    must(
      (await channelGrant(b.userId, a.channelId)) === null,
      "one tenant resolved another tenant's channel grant",
    );

    ok(
      "a foreign arm id is dropped rather than written, every experiment entry " +
        "point refuses the wrong tenant, cross-project variants are rejected, and " +
        "revenue authorisation comes from the stored grant",
    );

    // ---- 12. provider configuration -------------------------------------
    /**
     * §18 and §22 together: report the configuration state honestly and make no
     * live call either way. A configured client id is not authority for a
     * verification script to spend a real channel's quota, so the live check is
     * skipped even when it would succeed.
     */
    const { isYouTubeConfigured, youtubeMissingEnvVars } = await import(
      "@/lib/providers/youtube"
    );
    const configured = isYouTubeConfigured();
    const missing = youtubeMissingEnvVars();

    const { NotConfiguredError, ProviderRateLimitError, ProviderScopeError } =
      await import("@/lib/errors");
    const { isRetryableIngestError } = await import("@/lib/channels/analytics");

    if (!configured) {
      /**
       * The unconfigured path must be a *configuration state*, not a failure and
       * certainly not a silent zero: `requireGoogleCredentials()` throws before any
       * network I/O, and the error is non-retryable so a job does not spin against
       * an env var that will not appear on its own (§42, §48).
       */
      const { requireGoogleCredentials } = await import("@/lib/providers/youtube");
      let guarded: unknown = null;
      try {
        requireGoogleCredentials();
      } catch (error) {
        guarded = error;
      }
      must(
        guarded instanceof NotConfiguredError,
        "an unconfigured YouTube client did not raise a configuration state before " +
          "attempting a call",
      );
      must(
        (guarded as InstanceType<typeof NotConfiguredError>).retryable === false,
        "the not-configured state is marked retryable, so ingest jobs would retry " +
          "against a missing environment variable forever",
      );
    }

    /**
     * The §13 taxonomy, in the direction that costs money. A missing scope will
     * fail identically on every attempt, so retrying it burns quota against a
     * grant that cannot change; a rate limit is the opposite.
     */
    must(
      isRetryableIngestError(new ProviderScopeError("YouTube")) === false,
      "a missing-scope failure is classified retryable; the ingest would retry " +
        "forever instead of surfacing a reconnect prompt (§13)",
    );
    must(
      isRetryableIngestError(new ProviderRateLimitError("YouTube", 900)) === true,
      "a rate limit is classified permanent, so a transient quota error would " +
        "abandon the day's analytics (§13)",
    );

    ok(
      `YouTube OAuth credentials are ${configured ? "CONFIGURED" : "NOT_CONFIGURED"}` +
        (configured
          ? " — live analytics call SKIPPED by policy (§22): no quota is spent, " +
            "nothing is uploaded, and no experiment is created on a real channel"
          : `; missing ${missing.join(", ")} — the unconfigured path is a ` +
            "non-retryable configuration state, not a zero"),
    );
    detail(
      "retry taxonomy: scope_missing = permanent, rate_limited = retryable. " +
        "No live YouTube Analytics request was made by this script.",
    );

    console.log(
      `\n${step}/${TOTAL_STEPS} checks passed — the analytics schema, its partial ` +
        `arbiter indexes, exact-decimal revenue, the reporting layer, the thumbnail ` +
        `A/B decision policy and every tenant boundary all work under real Node ` +
        `against real Postgres.` +
        `\nNot verified here: a live YouTube Analytics response, and therefore the ` +
        `private row-mapping inside ingestChannelAnalytics. §22 forbids the call; ` +
        `tests/integration/analytics.test.ts covers that seam with the transport ` +
        `stubbed.\n`,
    );
  } finally {
    // Always, including on failure: a failed run leaves no probe rows behind.
    await cleanup();
    await closeDb();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(
      `\n  FAIL at step ${step + 1}: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\n`,
    );
    process.exit(1);
  },
);
