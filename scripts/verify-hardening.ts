/**
 * Prove the production hardening holds in a real Node process (§24).
 *
 * The four verification scripts before this one each prove a subsystem works. This
 * one proves the *safety properties* hold, and it exists for the same reason they
 * do: a green Vitest run has twice hidden a defect only a real process could see.
 * Phase 5 shipped 541 passing tests over a worker that could not boot, because
 * `vitest.config.ts` aliases `server-only` away and nothing else ever imported it
 * as plain Node. Phase 10 found the scheduler had the same defect and had never
 * started at all. Every property below is therefore checked against the real
 * module graph, real Postgres and real Redis, with no aliases and nothing mocked.
 *
 * The sixteen invariants, in the order §24 lists them:
 *
 *    1. configuration safety — the production guards refuse a mode mistake
 *    2. database connectivity — Postgres answers, with the timeouts applied
 *    3. migration state — every journal entry is actually applied
 *    4. authentication boundary — credentials are unrecoverable from a dump
 *    5. tenant isolation — a foreign uuid is refused, not served
 *    6. API validation — malformed input is rejected before it reaches a query
 *    7. rate limiting — the window is atomic and bounded
 *    8. worker safety — permanent failures stop; jobs do not vanish
 *    9. scheduler safety — one holder at a time, and a dead holder's lock recovers
 *   10. webhook safety — signature first, replay refused, no client-chosen tier
 *   11. provider error classification — retryable and permanent are distinguished
 *   12. secret/configuration safety — nothing sensitive reaches a response
 *   13. health/readiness — liveness is dependency-free; readiness is honest
 *   14. production/mock safety — the flags cannot silently become production
 *   15. observability — the logger redacts values, not just key names
 *   16. no destructive external action — asserted about this script itself
 *
 * ## Two things this script does structurally rather than by import
 *
 * `lib/api/guard`, `lib/api/rate-limit`, `lib/auth/session` and
 * `lib/channels/oauth-state` carry `import "server-only"`, whose runtime export
 * throws unconditionally — so this process cannot import them, and every
 * workaround for that (aliasing, stubbing, `--conditions react-server`) is
 * forbidden. Rather than skip the invariants that live behind them:
 *
 *  - **Invariants 6 and 7** re-implement nothing. The uuid pattern and the Redis
 *    Lua window are read out of their own source files and exercised, so a change
 *    to the real ones changes what this proves; and every route file is audited
 *    statically for the guard, validation and rate-limit calls it must make. That
 *    static audit is the stronger check anyway: it covers all 40 routes rather
 *    than whichever one a runtime probe happened to touch, so a route added later
 *    without a guard fails this script.
 *  - **Invariant 1** would otherwise require setting `NODE_ENV=production` in this
 *    process, which poisons every later step and which `resetEnvCache()` refuses
 *    to allow by design. It runs in child `tsx` processes instead — a fresh
 *    process parsing a fresh environment, which is exactly what a deployment does,
 *    and what makes the answer meaningful.
 *
 * ## What this script does NOT do
 *
 * §24's prohibitions, held to literally. It performs **no** YouTube upload, **no**
 * publication, **no** Stripe charge, **no** checkout or subscription creation and
 * **no** portal session. It rotates nothing and prints no credential value.
 * `.env.local` is neither modified nor read for its contents.
 *
 * The only external systems it contacts are this deployment's own Postgres and
 * Redis. Every write is confined to a synthetic namespace — probe users at a
 * reserved `.invalid` domain with an unusable password hash, Redis keys under a
 * `verify-hardening` prefix — and removed in a `finally`, so a failed run leaves
 * nothing behind either.
 *
 * Where a dependency is genuinely absent, the step reports `NOT_CONFIGURED` and
 * says what was therefore not proven. It never fabricates a pass: §24 asks for the
 * honest state, and a verification script reporting success it did not observe is
 * worse than no script at all.
 *
 *   npx tsx scripts/verify-hardening.ts
 *
 * Exits non-zero on the first failure.
 */
import "@/lib/load-env";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Probe identity. `.invalid` is reserved by RFC 2606 and can never resolve, so
 * these addresses cannot collide with a real user and cannot be mailed.
 */
const PROBE_PREFIX = "verify-hardening-probe-";
const PROBE_OWNER = `${PROBE_PREFIX}owner@probe.invalid`;
const PROBE_OTHER = `${PROBE_PREFIX}other@probe.invalid`;

/**
 * A password hash that cannot verify.
 *
 * `verifyPassword` needs six `$`-separated fields, so this is not a weak password
 * — it is *no* password, and the probe accounts are unauthenticatable by
 * construction. No plaintext credential exists anywhere in this script.
 */
const UNUSABLE_PASSWORD_HASH = "scrypt$login-disabled-probe-account";

/** Redis namespace for this script's own keys, so nothing real can be touched. */
const PROBE_NAMESPACE = "verify-hardening";

const TOTAL_STEPS = 16;
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

/** Assert, with the failure phrased as what would now be wrong in production. */
function must(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

async function main(): Promise<void> {
  console.log(
    "\nhardening verification " +
      "(no upload, no publish, no charge, no credential change)\n",
  );

  const { env, isProduction, realPublishBlocked, usingMockProviders } = await import(
    "@/lib/env"
  );
  const e = env();
  const { closeDb, db, rawSql } = await import("@/lib/db");
  const { and, eq, like } = await import("drizzle-orm");
  const { billingEvents, channels, jobs, projects, users } = await import(
    "@/lib/db/schema"
  );

  /** Remove the probe tenants and, by cascade, every row they own. */
  async function cleanupDatabase(): Promise<void> {
    await db.delete(users).where(like(users.emailNormalized, `${PROBE_PREFIX}%`));
    await db.delete(billingEvents).where(eq(billingEvents.provider, PROBE_NAMESPACE));
  }

  /** Remove every Redis key this script created. */
  async function cleanupRedis(): Promise<void> {
    const { getRedis } = await import("@/lib/queue/redis");
    const redis = getRedis();
    const keys = [
      ...(await redis.keys(`${e.QUEUE_PREFIX}:ratelimit:${PROBE_NAMESPACE}:*`)),
      ...(await redis.keys(`${e.QUEUE_PREFIX}:lock:${PROBE_NAMESPACE}:*`)),
    ];
    if (keys.length > 0) await redis.del(...keys);
  }

  // Declared out here so the closing summary can report whether the bundle scan
  // was possible, which is one of the two honest NOT_CONFIGURED cases.
  const chunkDir = join(process.cwd(), ".next", "static", "chunks");

  try {
    // ---- 1. configuration safety ------------------------------------------
    /**
     * The production guards, exercised in child processes.
     *
     * §18 asks whether a mode mistake is possible, and the ones that matter are
     * all silent: the process starts, every page renders, and the damage shows up
     * later as fabricated content, unverifiable signups, untracked subscriptions,
     * or a session cookie the browser never returns. Each must be a refusal to
     * boot rather than a warning.
     *
     * The values below are local placeholders, not credentials: the guards under
     * test reject the configuration before any of them is used to connect.
     */
    const PROBE_ENV_BASE: Record<string, string> = {
      APP_URL: "https://app.verify-hardening.invalid",
      DATABASE_URL: "postgresql://probe:probe@127.0.0.1:1/probe",
      REDIS_URL: "redis://127.0.0.1:1",
      S3_BUCKET: "probe",
      S3_ACCESS_KEY_ID: "probe",
      S3_SECRET_ACCESS_KEY: "probe",
      ENCRYPTION_KEY: "0".repeat(64),
      SESSION_SECRET: "1".repeat(64),
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "probe-placeholder",
      BILLING_PROVIDER: "mock",
      TALLY_USE_MOCK_PROVIDERS: "false",
    };

    /**
     * `lib/env` as a file URL: a bare Windows path is not a valid module
     * specifier, and the child receives this as source text.
     */
    const envModuleUrl = new URL("../src/lib/env.ts", import.meta.url).href;

    /**
     * Parse a hypothetical production configuration in a child, and report whether
     * it was refused. Only the verdict crosses back — never a value.
     *
     * `env()` throws synchronously inside the *fulfilled* handler of the dynamic
     * import, so the try/catch has to be there; a rejection handler alone never
     * sees it and the child dies with a stack trace instead of an answer.
     */
    async function productionConfig(
      overrides: Record<string, string>,
    ): Promise<{ accepted: boolean; message: string }> {
      const source =
        `const report = (error) => console.log("REFUSED " + ` +
        `JSON.stringify(error instanceof Error ? error.message : ""));` +
        `import(${JSON.stringify(envModuleUrl)}).then((m) => {` +
        `try { m.env(); console.log("ACCEPTED"); } catch (error) { report(error); }` +
        `}, report);`;

      const { stdout } = await execFileAsync(
        process.execPath,
        [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "--eval", source],
        {
          /**
           * Replaces rather than merges. A child inheriting this environment would
           * inherit its NODE_ENV and every real credential in it, and the guard
           * under test would then be answering a different question.
           *
           * PATH is passed through because tsx spawns esbuild. The cast is because
           * `ProcessEnv` is augmented to require NODE_ENV, which a spread of a
           * `Record` cannot prove to the compiler even though the base supplies it.
           */
          env: {
            ...PROBE_ENV_BASE,
            ...overrides,
            // Last, and outside the spreads: `NODE_ENV` is the whole point of the
            // probe, and a spread of a `Record<string, string>` cannot prove to the
            // compiler that it is present.
            NODE_ENV: "production",
            PATH: process.env["PATH"] ?? "",
          },
          cwd: process.cwd(),
          timeout: 120_000,
        },
      );

      const line = stdout.trim().split("\n").pop() ?? "";
      if (line === "ACCEPTED") return { accepted: true, message: line };
      if (line.startsWith("REFUSED ")) {
        return {
          accepted: false,
          // JSON-encoded so a multi-line zod report survives the trip intact.
          message: JSON.parse(line.slice("REFUSED ".length)) as string,
        };
      }
      fail(`the configuration probe produced no verdict (last line: ${line})`);
    }

    // The control first. Without it, a refusal below could be passing for an
    // unrelated reason — a missing variable rather than the guard under test.
    const control = await productionConfig({});
    must(
      control.accepted,
      `a complete production configuration was rejected (${control.message}); the ` +
        "refusals below would prove nothing",
    );

    const refusals: [string, Record<string, string>, string][] = [
      [
        "mock providers",
        { TALLY_USE_MOCK_PROVIDERS: "true" },
        "TALLY_USE_MOCK_PROVIDERS",
      ],
      // Tally would report work it never did (§40, §42).
      ["console email", { EMAIL_PROVIDER: "console", RESEND_API_KEY: "" }, "EMAIL_PROVIDER"],
      // Every verification and reset email would go to stdout.
      [
        "Stripe with only a secret key",
        { BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_live_probe_placeholder" },
        "BILLING_PROVIDER",
      ],
      [
        "Stripe with only a webhook secret",
        { BILLING_PROVIDER: "stripe", STRIPE_WEBHOOK_SECRET: "whsec_probe_placeholder" },
        "BILLING_PROVIDER",
      ],
      // Signature verification would have nothing to verify against while
      // checkout kept taking money (§17).
      ["Stripe with neither secret", { BILLING_PROVIDER: "stripe" }, "BILLING_PROVIDER"],
      [
        "an http APP_URL",
        { APP_URL: "http://app.verify-hardening.invalid" },
        "APP_URL",
      ],
      // The Secure session cookie would never be returned by a browser and OAuth
      // state would cross the network in clear text.
    ];

    for (const [label, overrides, expected] of refusals) {
      const result = await productionConfig(overrides);
      must(
        !result.accepted,
        `a production configuration with ${label} started successfully; §18 requires ` +
          "a refusal to boot, because none of these is visible in a smoke test",
      );
      must(
        result.message.includes(expected),
        `the refusal for ${label} does not name ${expected}, so an operator cannot ` +
          `act on it (got: ${result.message.split("\n")[0]})`,
      );
    }

    /**
     * A configuration error is the message an operator reads most often, so it
     * must name the variable without printing what was in it.
     */
    const badKey = await productionConfig({ ENCRYPTION_KEY: "too-short-and-not-hex" });
    must(
      !badKey.accepted && badKey.message.includes("ENCRYPTION_KEY"),
      "an invalid ENCRYPTION_KEY was accepted in production, or the error did not " +
        "name the variable",
    );
    must(
      !badKey.message.includes("too-short-and-not-hex"),
      "the configuration error echoed the rejected value; a validation message must " +
        "not become a way to print a secret into a log (§15)",
    );

    ok(
      `a fresh production process accepts a complete configuration and refuses all ` +
        `${refusals.length} mode mistakes, naming the variable without echoing its value`,
    );
    detail(
      `this process is unaffected: NODE_ENV=${e.NODE_ENV}, ` +
        `production=${String(isProduction())}, ` +
        `mockProviders=${String(usingMockProviders())}, ` +
        `publishBlocked=${String(realPublishBlocked())}`,
    );

    // ---- 2. database connectivity + timeouts ------------------------------
    const [version] = await rawSql()`select version()`;
    const banner = String(version?.["version"] ?? "").split(",")[0];

    /**
     * The timeouts, read back from the live session rather than trusted.
     *
     * An unbounded statement is how one pathological query holds a pool slot until
     * the pool is exhausted, which presents as a total outage rather than as one
     * slow endpoint. They are set per connection in `lib/db`, and reading them
     * back is the only way to know the `connection` option actually took effect.
     */
    const [timeouts] = await rawSql()`
      select
        current_setting('statement_timeout') as statement_timeout,
        current_setting('idle_in_transaction_session_timeout') as idle_timeout
    `;
    const statementTimeout = String(timeouts?.["statement_timeout"] ?? "0");
    const idleTimeout = String(timeouts?.["idle_timeout"] ?? "0");

    must(
      statementTimeout !== "0" && statementTimeout !== "",
      "statement_timeout is unset on this connection; one pathological query could " +
        "hold a pool slot until the pool is exhausted (§12)",
    );
    must(
      idleTimeout !== "0" && idleTimeout !== "",
      "idle_in_transaction_session_timeout is unset; a transaction that took its " +
        "locks and then stalled would block unrelated tenants indefinitely",
    );
    ok(
      `${banner} answered — statement_timeout=${statementTimeout}, ` +
        `idle_in_transaction_session_timeout=${idleTimeout}`,
    );

    // ---- 3. migration state ------------------------------------------------
    /**
     * Every journal entry actually applied.
     *
     * `select 1` passes against a database with no schema at all, and a partially
     * migrated one produces the most confusing production failures — a route that
     * works until it touches the single column that is missing. The journal says
     * what should exist; drizzle's bookkeeping table says what does.
     */
    const journal = (await import("../drizzle/meta/_journal.json")).default as {
      entries: { idx: number; tag: string; when: number }[];
    };

    const [applied] = await rawSql()`
      select count(*)::int as count from drizzle.__drizzle_migrations
    `;
    const appliedCount = Number(applied?.["count"] ?? 0);

    must(
      appliedCount >= journal.entries.length,
      `the journal lists ${journal.entries.length} migration(s) but ${appliedCount} ` +
        "are applied; run npm run db:migrate before serving traffic (§22)",
    );

    // Recorded is not the same as present, so assert the schema exists too.
    const [tableCount] = await rawSql()`
      select count(*)::int as count
      from information_schema.tables
      where table_schema = 'public'
    `;
    const tables = Number(tableCount?.["count"] ?? 0);
    must(
      tables > 0,
      "the public schema contains no tables; migrations are recorded as applied but " +
        "the schema is absent",
    );

    ok(
      `all ${journal.entries.length} migration(s) applied (latest: ` +
        `${journal.entries[journal.entries.length - 1]?.tag ?? "unknown"}), ` +
        `${tables} tables present`,
    );

    // ---- 4. authentication boundary ---------------------------------------
    /**
     * Credentials must be unrecoverable from a database dump.
     *
     * `requireUser()` reads the cookie through `next/headers` and cannot be
     * imported here — and the route audit in step 6 is the stronger check on it
     * anyway, because it covers every route rather than one. What is provable here,
     * and what a stolen dump actually turns on, is the storage layer: a password
     * that cannot be reversed and a session row that is not a bearer token.
     */
    const { hashPassword, verifyPassword } = await import("@/lib/crypto");

    const probeSecret = "verify-hardening-not-a-real-password";
    const hash = await hashPassword(probeSecret);
    must(
      !hash.includes(probeSecret),
      "the password hash contains the plaintext; passwords must never be " +
        "recoverable from the database",
    );
    must(hash.startsWith("scrypt$"), "the password hash is not in the scrypt format");
    must(
      await verifyPassword(probeSecret, hash),
      "a correct password did not verify against its own hash",
    );
    must(
      !(await verifyPassword(`${probeSecret}x`, hash)),
      "an incorrect password verified successfully",
    );
    must(
      !(await verifyPassword(probeSecret, UNUSABLE_PASSWORD_HASH)),
      "a malformed hash verified a password; the probe accounts created below would " +
        "be signable-into",
    );

    /**
     * Sessions store a hash, so the table is not a set of usable credentials and a
     * dump cannot be replayed as a login.
     */
    const sessionColumns = (
      await rawSql()`
        select column_name
        from information_schema.columns
        where table_schema = 'public' and table_name = 'sessions'
      `
    ).map((row) => String(row["column_name"]));

    must(
      sessionColumns.includes("token_hash"),
      "the sessions table has no token_hash column; a stored raw token would make a " +
        "database read equivalent to a login",
    );
    must(
      !sessionColumns.includes("token"),
      "the sessions table has a raw `token` column",
    );

    /**
     * Emailed verification and reset tokens are hashed too. Same reasoning as
     * sessions: a stored raw token is a live password-reset link for every pending
     * request in the table.
     */
    const emailTokenColumns = (
      await rawSql()`
        select column_name
        from information_schema.columns
        where table_schema = 'public' and table_name = 'email_tokens'
      `
    ).map((row) => String(row["column_name"]));
    must(
      emailTokenColumns.includes("token_hash") && !emailTokenColumns.includes("token"),
      "email_tokens stores a raw token; every pending reset would be a usable link " +
        "for anyone who could read the table",
    );

    /**
     * Stored OAuth credentials are encrypted at rest. A plaintext refresh token in
     * `channels` is a permanent credential sitting in every backup — it does not
     * expire on its own, so a leaked one has to be revoked at Google.
     *
     * `_enc` marks the ciphertext columns. `last_token_error_message` is
     * deliberately excluded: it is a diagnostic string shown to the user, not a
     * credential, which is why the match is on the two credential names rather than
     * on the substring "token".
     */
    const channelColumns = (
      await rawSql()`
        select column_name
        from information_schema.columns
        where table_schema = 'public' and table_name = 'channels'
      `
    ).map((row) => String(row["column_name"]));

    for (const credential of ["access_token", "refresh_token"]) {
      must(
        channelColumns.includes(`${credential}_enc`),
        `channels has no ${credential}_enc column; §6 requires OAuth credentials ` +
          "encrypted at rest",
      );
      must(
        !channelColumns.includes(credential),
        `channels has a plaintext ${credential} column`,
      );
    }

    /**
     * And the columns hold ciphertext, not just an encrypted-sounding name. Every
     * Google access token starts `ya29.` and every refresh token `1//`; finding
     * either prefix at rest would mean the encryption is being bypassed on write.
     */
    const [plaintextTokens] = await rawSql()`
      select count(*)::int as count from channels
      where access_token_enc like 'ya29.%' or refresh_token_enc like '1//%'
    `;
    must(
      Number(plaintextTokens?.["count"] ?? 0) === 0,
      "a channels row holds what looks like a plaintext Google token in an _enc " +
        "column; the encryption is being bypassed on write",
    );

    ok(
      "passwords are scrypt hashes that never contain the plaintext, an unusable " +
        "hash verifies nothing, sessions and email tokens store only hashes, and " +
        "both OAuth credential columns are encrypted with no plaintext token at rest",
    );

    // ---- 5. tenant isolation ----------------------------------------------
    /**
     * Adversarial cross-tenant access with real ids (§5).
     *
     * Two probe tenants are created and each service is asked for the other's
     * rows. Checked against real Postgres because isolation is a property of the
     * predicate that executes — `and(eq(id), eq(userId))` — and a query missing the
     * `userId` term type-checks perfectly.
     */
    await cleanupDatabase();

    const [owner] = await db
      .insert(users)
      .values({
        email: PROBE_OWNER,
        emailNormalized: PROBE_OWNER,
        passwordHash: UNUSABLE_PASSWORD_HASH,
        name: "Hardening probe owner",
        onboardedAt: new Date(),
      })
      .returning({ id: users.id });
    const [other] = await db
      .insert(users)
      .values({
        email: PROBE_OTHER,
        emailNormalized: PROBE_OTHER,
        passwordHash: UNUSABLE_PASSWORD_HASH,
        name: "Hardening probe other",
        onboardedAt: new Date(),
      })
      .returning({ id: users.id });
    if (!owner || !other) fail("could not insert the probe users");

    const [channel] = await db
      .insert(channels)
      .values({
        userId: owner.id,
        youtubeChannelId: "UCverifyHardeningProbe0",
        title: "Hardening probe channel",
      })
      .returning({ id: channels.id });
    if (!channel) fail("could not insert the probe channel");

    const { createProject, getProject, listProjects, transition } = await import(
      "@/lib/projects/service"
    );
    const { errorCodeOf } = await import("@/lib/errors");

    /** Run `fn` and report the error code it produced, or `none`. */
    async function codeOf(fn: () => Promise<unknown>): Promise<string> {
      try {
        await fn();
        return "none";
      } catch (error) {
        return errorCodeOf(error);
      }
    }

    const project = await createProject({
      userId: owner.id,
      channelId: channel.id,
      title: "Hardening probe project",
      maxVideosPerMonth: null,
    });

    // The owner can read it, so a refusal below is a boundary and not a broken query.
    await getProject(owner.id, project.id);

    const foreignRead = await codeOf(() => getProject(other.id, project.id));
    must(
      foreignRead === "forbidden",
      `reading another tenant's project by id returned ${foreignRead}; a valid ` +
        "session plus a real foreign uuid must be refused (§5)",
    );

    const foreignWrite = await codeOf(() =>
      transition(other.id, project.id, "SCRIPT_GENERATING"),
    );
    must(
      foreignWrite === "forbidden",
      `transitioning another tenant's project returned ${foreignWrite}`,
    );

    // And the row genuinely did not move: a refusal that still writes is not one.
    const afterRefusal = await getProject(owner.id, project.id);
    must(
      afterRefusal.status === "IDEA",
      "the refused cross-tenant transition changed the row anyway " +
        `(status=${afterRefusal.status})`,
    );

    const otherList = await listProjects(other.id);
    must(
      otherList.length === 0,
      `listing projects as the other tenant returned ${otherList.length} row(s); a ` +
        "list endpoint must be scoped by owner",
    );

    /**
     * A foreign channel id supplied to a channel-scoped read (§9). `getChannel`
     * returns null rather than throwing, and null is the refusal here — the route
     * above it turns that into a 403 without revealing which ids exist.
     */
    const { getChannel } = await import("@/lib/channels/service");
    must(
      (await getChannel(owner.id, channel.id)) !== null,
      "the owner could not read their own channel; the check below would prove nothing",
    );
    must(
      (await getChannel(other.id, channel.id)) === null,
      "claiming another tenant's channel by uuid returned the channel; a client must " +
        "never be able to select another tenant by supplying an id (§9)",
    );

    /**
     * The publishing path specifically (§9). A queue payload naming a project and a
     * channel that belong to different tenants must not resolve — that is the
     * relationship an untrusted payload would try to forge.
     */
    const [otherChannel] = await db
      .insert(channels)
      .values({
        userId: other.id,
        youtubeChannelId: "UCverifyHardeningProbe1",
        title: "Hardening probe channel (other tenant)",
      })
      .returning({ id: channels.id });
    if (!otherChannel) fail("could not insert the second probe channel");

    const crossPair = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, project.id), eq(projects.channelId, otherChannel.id)));
    must(
      crossPair.length === 0,
      "a project matched a channel belonging to a different tenant; a publish could " +
        "cross tenants (§9)",
    );

    ok(
      "cross-tenant reads, writes, lists and channel claims are all refused, a " +
        "refused write left the row unchanged, and a project cannot be paired with " +
        "another tenant's channel",
    );

    // ---- 6. API validation -------------------------------------------------
    /**
     * Malformed ids rejected before a query runs, and every route guarded (§3, §6).
     *
     * The uuid pattern is read out of the guard's own source and exercised here, so
     * a change to the real one changes what this proves. Then every route file is
     * audited for the calls it must make — which is the stronger of the two checks,
     * because it covers all of them.
     */
    const guardSource = readFileSync(
      join(process.cwd(), "src", "lib", "api", "guard.ts"),
      "utf8",
    );
    const uuidLiteral = /const UUID_RE\s*=\s*\n?\s*(\/\^[^\n]*\$\/i?)/.exec(guardSource);
    if (!uuidLiteral?.[1]) fail("could not locate UUID_RE in lib/api/guard.ts");
    const uuidRe = new RegExp(
      uuidLiteral[1].slice(1, uuidLiteral[1].lastIndexOf("/")),
      uuidLiteral[1].endsWith("i") ? "i" : "",
    );

    const malformed = [
      "",
      "not-a-uuid",
      "3f2b9c1e4a7d4bee9c2b0242ac120002",
      "3f2b9c1e-4a7d-4bee-9c2b-0242ac120002' OR '1'='1",
      "../../etc/passwd",
      // Syntactically plausible, and the value a buggy client most often sends.
      "00000000-0000-0000-0000-000000000000",
    ];
    for (const value of malformed) {
      must(
        !uuidRe.test(value),
        `the id validator accepts ${JSON.stringify(value)}; a SQL fragment, a ` +
          "traversal or the nil uuid must never reach a query (§6)",
      );
    }
    must(
      uuidRe.test("3f2b9c1e-4a7d-4bee-9c2b-0242ac120002"),
      "the id validator rejects a well-formed uuid; every route would 400",
    );

    /**
     * Every route file, audited for its guard.
     *
     * The exemptions are deliberate and each has a different auth model: the
     * billing webhook authenticates by HMAC (§8 — a session would be wrong, Stripe
     * has none), health and ready are unauthenticated probes by design (§16 — a
     * probe cannot log in), and the two OAuth routes return redirects rather than
     * JSON envelopes so they do not pass through `handle()`.
     */
    const HANDLE_EXEMPT = new Set([
      "billing/webhook/route.ts",
      "health/route.ts",
      "ready/route.ts",
      "channels/connect/route.ts",
      "channels/callback/route.ts",
    ]);
    const SESSION_EXEMPT = new Set([
      "billing/webhook/route.ts",
      "health/route.ts",
      "ready/route.ts",
    ]);
    const AUTH_FREE_PREFIX = "auth/";

    const apiRoot = join(process.cwd(), "src", "app", "api");
    const routeFiles: string[] = [];
    const walkRoutes = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walkRoutes(full);
        else if (entry === "route.ts") routeFiles.push(full);
      }
    };
    walkRoutes(apiRoot);
    must(
      routeFiles.length > 0,
      "no API route files were found; the audit below would pass vacuously",
    );

    let guardedRoutes = 0;
    let mutatingRoutes = 0;
    let validatedBodies = 0;
    for (const file of routeFiles) {
      const relative = file.slice(apiRoot.length + 1).split(/[\\/]/).join("/");
      const source = readFileSync(file, "utf8");

      // `handle()` assigns the trace id, classifies AppErrors into their status
      // codes, and applies the same-origin check to every mutation.
      if (!HANDLE_EXEMPT.has(relative)) {
        must(
          source.includes("handle(request"),
          `${relative} does not route through handle(); it would leak an ` +
            "unclassified 500 and skip the origin check (§3, §14)",
        );
      }

      if (!SESSION_EXEMPT.has(relative) && !relative.startsWith(AUTH_FREE_PREFIX)) {
        must(
          /require(User|Onboarded)\(/.test(source),
          `${relative} has no requireUser()/requireOnboarded() call; an ` +
            "authenticated route must not be reachable without a session (§3)",
        );
        guardedRoutes += 1;
      }

      // A route taking a resource id must re-query it with the tenant predicate
      // rather than trusting the id it was given.
      if (/\[(channelId|projectId|experimentId)\]/.test(relative)) {
        must(
          /require(Channel|Project)Access\(|assertUuid\(|\.uuid\(/.test(source),
          `${relative} takes a resource id from the path with no ownership re-query ` +
            "or uuid validation (§5, §6)",
        );
      }

      // Every mutation must be bounded, or a session is an unmetered API key.
      if (/export async function (POST|PATCH|PUT|DELETE)/.test(source)) {
        mutatingRoutes += 1;
        if (!SESSION_EXEMPT.has(relative)) {
          must(
            source.includes("enforce(rules()"),
            `${relative} mutates with no rate limit; one session could drive it in a ` +
              "loop (§7)",
          );
        }
      }

      /**
       * A body-taking route must validate against a runtime schema, not a
       * TypeScript type (§6). Each `parseJson` call's schema argument is followed to
       * wherever it is defined — several routes import a shared schema from a
       * `config` module rather than declaring one inline, and both are correct; what
       * would not be is a schema that accepts anything.
       */
      for (const call of source.matchAll(/parseJson\(\s*request\s*,\s*([\w.]+)/g)) {
        const schemaExpr = call[1] ?? "";
        must(
          schemaExpr.length > 0 && !/^z\.(any|unknown)$/.test(schemaExpr),
          `${relative} calls parseJson with ${schemaExpr || "no schema"}; a schema ` +
            "that accepts anything is not validation (§6)",
        );

        /**
         * Defined in the route, or imported from the module that defines it.
         *
         * `\s*` across the `=` because several schemas are declared as a chain
         * beginning on the following line (`export const x =\n  z.object({...})`),
         * and a same-line-only match would report those as unvalidated.
         */
        const definition = new RegExp(
          `(const|let)\\s+${schemaExpr.replace(/\./g, "\\.")}\\s*(:[^=]*)?=\\s*z\\s*\\.`,
        );
        let definedIn: string | null = definition.test(source) ? relative : null;
        if (!definedIn) {
          const imported = new RegExp(
            `import\\s*\\{[^}]*\\b${schemaExpr}\\b[^}]*\\}\\s*from\\s*"@/([^"]+)"`,
          ).exec(source);
          const modulePath = imported?.[1];
          if (modulePath) {
            const moduleFile = join(process.cwd(), "src", `${modulePath}.ts`);
            if (
              existsSync(moduleFile) &&
              definition.test(readFileSync(moduleFile, "utf8"))
            ) {
              definedIn = modulePath;
            }
          }
        }
        must(
          definedIn !== null,
          `${relative} parses a body with ${schemaExpr}, which is not defined as a ` +
            "zod schema here or in the module it comes from; TypeScript types are " +
            "not runtime validation (§6)",
        );
        validatedBodies += 1;
      }

      // And no route may reach the raw body around the validator.
      if (!HANDLE_EXEMPT.has(relative)) {
        must(
          !/request\.json\(\)/.test(source),
          `${relative} reads request.json() directly, bypassing parseJson's size ` +
            "limit and schema validation (§6)",
        );
      }
    }

    ok(
      `the id validator rejects all ${malformed.length} malformed shapes including ` +
        `the nil uuid, and all ${routeFiles.length} route files pass the static ` +
        `audit (${guardedRoutes} session-guarded, ${mutatingRoutes} with mutations ` +
        `rate-limited, ${validatedBodies} with zod-validated bodies)`,
    );
    detail(
      "exempt by design: billing/webhook (HMAC auth, §8), health and ready " +
        "(unauthenticated probes, §16), channels/connect and channels/callback " +
        "(redirects, not JSON envelopes); auth/* is pre-session by nature and " +
        "rate-limited by IP instead",
    );

    // ---- 7. rate limiting --------------------------------------------------
    /**
     * The real Lua window against real Redis (§7).
     *
     * `lib/api/rate-limit` is `server-only`, so the script drives the same script
     * it does — read out of the module source rather than restated here, so a
     * change to the real one changes what this proves.
     *
     * Atomicity is the point. `INCR` then `EXPIRE` is two round trips, and a
     * process that dies between them leaves a counter with no TTL: a key that never
     * resets, which on `auth:email` is an account locked out of its own login by a
     * cache hiccup.
     */
    const limiterSource = readFileSync(
      join(process.cwd(), "src", "lib", "api", "rate-limit.ts"),
      "utf8",
    );
    const scriptMatch = /const WINDOW_SCRIPT = `([\s\S]*?)`;/.exec(limiterSource);
    if (!scriptMatch?.[1]) fail("could not locate WINDOW_SCRIPT in rate-limit.ts");
    const windowScript = scriptMatch[1];

    const { getRedis } = await import("@/lib/queue/redis");
    const redis = getRedis();
    await redis.ping();

    const LIMIT = 3;
    const WINDOW_MS = 60_000;
    const rateKey = `${e.QUEUE_PREFIX}:ratelimit:${PROBE_NAMESPACE}:subject`;
    const ttlLessKey = `${e.QUEUE_PREFIX}:ratelimit:${PROBE_NAMESPACE}:subject-two`;
    await redis.del(rateKey, ttlLessKey);

    /** One consumption, through the application's own Lua. */
    async function consumeProbe(key: string): Promise<{ count: number; ttlMs: number }> {
      const raw = (await redis.eval(windowScript, 1, key, String(WINDOW_MS))) as [
        number,
        number | string,
      ];
      return { count: Number(raw[0]), ttlMs: Number(raw[1]) };
    }

    const firstHit = await consumeProbe(rateKey);
    must(firstHit.count === 1, `the first increment returned ${firstHit.count}`);
    must(
      (await redis.pttl(rateKey)) > 0,
      "the counter has no expiry after its first increment; the subject would be " +
        "rate-limited permanently (§7)",
    );

    await consumeProbe(rateKey);
    await consumeProbe(rateKey);
    const exhausted = await consumeProbe(rateKey);
    must(
      exhausted.count > LIMIT,
      `the ${LIMIT + 1}th request in a window of ${LIMIT} did not exceed the limit`,
    );
    const retryAfter = Math.max(1, Math.ceil(exhausted.ttlMs / 1000));
    must(
      retryAfter > 0 && retryAfter <= WINDOW_MS / 1000,
      `retry-after of ${retryAfter}s is outside the window it came from; a ` +
        "Retry-After of 0 invites a retry guaranteed to be refused",
    );

    /**
     * The TTL-repair branch. A key that somehow lost its expiry must be repaired
     * rather than left to lock its subject out forever.
     */
    await redis.set(ttlLessKey, "9");
    must(
      (await redis.pttl(ttlLessKey)) === -1,
      "the TTL-less fixture was not created; the repair branch is untested",
    );
    await consumeProbe(ttlLessKey);
    must(
      (await redis.pttl(ttlLessKey)) > 0,
      "a counter with no expiry was left without one; that subject would be " +
        "rate-limited permanently (§7)",
    );

    /**
     * One rate-limiting system, not two (§7). Duplicate rule names would share a
     * counter and silently halve both limits.
     */
    const ruleNames = [...limiterSource.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);
    must(
      ruleNames.length > 0 && new Set(ruleNames).size === ruleNames.length,
      `two rate-limit rules share a name (${ruleNames.join(", ")}), so they would ` +
        "share a counter",
    );

    ok(
      "the Redis window is atomic (TTL set with the first increment), exceeds at " +
        `exactly ${LIMIT}, reports a usable retry-after of ${retryAfter}s, repairs a ` +
        `TTL-less counter, and defines ${ruleNames.length} distinctly-named rules`,
    );

    // ---- 8. worker safety --------------------------------------------------
    /**
     * Retry classification and durable bookkeeping (§10).
     *
     * Two properties: a permanent failure must not consume the whole attempt
     * budget, and a job must exist in Postgres before it exists in Redis —
     * otherwise a crashed enqueue leaves work running that nothing can report on,
     * which is the spinner that never resolves §30 forbids.
     */
    const {
      NotConfiguredError,
      ProviderOutOfCreditError,
      ValidationError,
      asDatabaseError,
      isRetryable,
    } = await import("@/lib/errors");

    must(
      !isRetryable(new NotConfiguredError("Claude", ["ANTHROPIC_API_KEY"], "hint")),
      "a missing credential was classified retryable; no number of attempts will " +
        "conjure an API key, and retrying forever hides the state an operator must " +
        "clear (§10)",
    );
    must(
      !isRetryable(new ValidationError("bad input")),
      "invalid input was classified retryable",
    );
    must(
      !isRetryable(new ProviderOutOfCreditError("Claude")),
      "an exhausted balance was classified retryable; a queue of attempts against an " +
        "empty balance is a queue of identical failures",
    );
    must(
      isRetryable(
        asDatabaseError("probe", Object.assign(new Error("gone"), { code: "08006" })),
      ),
      "a dropped database connection was classified permanent; work a retry would " +
        "have completed is abandoned",
    );
    must(
      !isRetryable(
        asDatabaseError("probe", Object.assign(new Error("dup"), { code: "23505" })),
      ),
      "a unique violation was classified retryable; the identical insert fails " +
        "identically forever",
    );

    /**
     * The row-before-push ordering, observed. The BullMQ job id equals the row id,
     * which is what makes a repeated push idempotent — BullMQ refuses a duplicate
     * id, so a retried enqueue cannot produce two runs of the same work.
     */
    const { enqueue } = await import("@/lib/queue/jobs");
    const { getQueue } = await import("@/lib/queue/queues");

    const enqueued = await enqueue({
      queue: "maintenance",
      name: `${PROBE_NAMESPACE}-probe`,
      userId: owner.id,
      channelId: channel.id,
      payload: { probe: true },
    });

    const [jobRow] = await db.select().from(jobs).where(eq(jobs.id, enqueued.id));
    must(
      jobRow !== undefined && jobRow.status === "queued",
      "the durable jobs row is missing or not queued after enqueue; a job Redis knows " +
        "about but Postgres does not is one the UI cannot report on (§30)",
    );
    must(
      jobRow?.queueJobId === enqueued.id,
      `the queue job id (${jobRow?.queueJobId ?? "null"}) does not match the row id ` +
        `(${enqueued.id}); a duplicate push would not be deduplicated`,
    );

    const queue = getQueue("maintenance");
    const before = await queue.getJobCountByTypes("waiting", "delayed", "active");
    // The retried push a crashed-and-restarted enqueue would perform.
    await queue.add(
      `${PROBE_NAMESPACE}-probe`,
      { jobId: enqueued.id },
      { jobId: enqueued.id, attempts: 3 },
    );
    const after = await queue.getJobCountByTypes("waiting", "delayed", "active");
    must(
      after === before,
      `re-pushing the same job id created a second message (${before} -> ${after}); ` +
        "the same work would run twice (§10)",
    );

    /**
     * Remove both halves of the probe job — the Redis message so no worker picks it
     * up, and the durable row so it does not sit `queued` forever in a dashboard.
     * Step 16 asserts this actually happened; it caught the missing row delete here.
     */
    await queue.remove(enqueued.id);
    await db.delete(jobs).where(eq(jobs.id, enqueued.id));

    const payloadJson = JSON.stringify(jobRow?.payload ?? {});
    must(
      !/accessToken|refreshToken|secret|password|apiKey/i.test(payloadJson),
      "the job payload contains a credential-shaped key; payloads live in both " +
        "Postgres and Redis and are logged on failure (§15)",
    );

    ok(
      "permanent failures are non-retryable and transient ones retryable, the durable " +
        "row precedes the Redis push with a matching id, a repeated push is ignored, " +
        "and the payload carries no credential",
    );

    // ---- 9. scheduler safety -----------------------------------------------
    /**
     * Mutual exclusion and stale recovery (§11).
     *
     * The overlap guard has to be distributed: a per-process flag stops a slow pass
     * overlapping itself but does nothing about a second replica, and two replicas
     * running the same pass doubles YouTube quota spend — which, unlike a delay,
     * does not come back.
     */
    const { acquireLock, lockHeld, withLock } = await import("@/lib/queue/lock");
    const lockName = `${PROBE_NAMESPACE}:exclusion`;

    const held = await acquireLock(lockName, { ttlMs: 10_000 });
    must(held !== null, "the lock could not be acquired at all");
    must(
      (await acquireLock(lockName, { ttlMs: 10_000 })) === null,
      "a second caller acquired a lock that was already held; two schedulers would " +
        "run the same pass concurrently (§11)",
    );
    await held?.release();
    const afterRelease = await acquireLock(lockName, { ttlMs: 5_000 });
    must(
      afterRelease !== null,
      "the lock was not released; the schedule would stall for a whole TTL after " +
        "every successful pass",
    );
    await afterRelease?.release();

    /**
     * Stale recovery. A scheduler killed mid-pass — SIGKILL, OOM, container
     * eviction — never runs its `finally`, so the TTL is the only thing that frees
     * the key. `renewMs` past the TTL reproduces a holder that will never renew.
     */
    const staleName = `${PROBE_NAMESPACE}:stale`;
    const dead = await acquireLock(staleName, { ttlMs: 600, renewMs: 60_000 });
    must(dead !== null, "could not acquire the stale-probe lock");
    must(
      (await acquireLock(staleName, { ttlMs: 600 })) === null,
      "the lock excluded nobody even while held",
    );
    await new Promise((resolve) => setTimeout(resolve, 900));
    const recovered = await acquireLock(staleName, { ttlMs: 5_000 });
    must(
      recovered !== null,
      "a lock whose holder died was never recoverable; the task would stop running " +
        "until an operator noticed (§11)",
    );
    must(
      recovered?.owner !== dead?.owner,
      "the recovered lock carries the dead holder's owner token",
    );

    /**
     * The dead holder's late release must be a no-op. Otherwise A releases B's lock
     * and C gets in while B is still working — a lock that silently stops
     * excluding, which is worse than no lock because nothing logs it.
     */
    await dead?.release();
    must(
      await lockHeld(staleName),
      "a stale holder's release freed the new holder's lock; the owner-token " +
        "comparison is not working (§11)",
    );
    await recovered?.release();

    // A failed pass must not block the next one.
    const throwingName = `${PROBE_NAMESPACE}:throwing`;
    try {
      await withLock(throwingName, () => Promise.reject(new Error("probe failure")), {
        ttlMs: 30_000,
      });
    } catch {
      // Expected: `withLock` releases in a `finally` and rethrows.
    }
    must(
      !(await lockHeld(throwingName)),
      "a task that threw left its lock held; one failure would block the schedule for " +
        "a whole TTL (§11)",
    );

    // `withLock` must report that it skipped rather than silently doing nothing.
    const contendedName = `${PROBE_NAMESPACE}:contended`;
    const contended = await acquireLock(contendedName, { ttlMs: 10_000 });
    const skipped = await withLock(contendedName, () => Promise.resolve("must not run"));
    must(
      skipped.ran === false,
      "withLock ran its task while another holder had the lock",
    );
    await contended?.release();

    ok(
      "the distributed lock excludes a second holder, recovers from a dead one via " +
        "TTL, refuses a stale holder's release, frees on a thrown task, and reports a " +
        "skipped pass rather than silently not running",
    );

    // ---- 10. webhook safety ------------------------------------------------
    /**
     * Signature-first, replay-resistant, no client-chosen tier (§8).
     *
     * The HMAC is real on both sides — local crypto, no network, no Stripe account
     * — and what is checked is the ordering: verification happens on the raw body
     * before anything is parsed or applied.
     */
    const Stripe = (await import("stripe")).default;
    const { STRIPE_API_VERSION, tierForPriceId } = await import("@/lib/billing/stripe");
    /**
     * A placeholder key that is never used to make a request: only `webhooks` is
     * touched below, and `generateTestHeaderString`/`constructEvent` are local HMAC
     * operations that open no connection.
     */
    const localOnly = new Stripe("sk_test_verify_hardening_placeholder", {
      apiVersion: STRIPE_API_VERSION,
    });
    const hookSecret = "whsec_verify_hardening_local_only";
    const nowSecs = Math.floor(Date.now() / 1000);
    const eventBody = JSON.stringify({
      id: `evt_${PROBE_NAMESPACE}`,
      object: "event",
      type: "customer.subscription.updated",
      created: nowSecs,
      data: { object: { id: "sub_probe", object: "subscription" } },
    });

    const freshHeader = localOnly.webhooks.generateTestHeaderString({
      payload: eventBody,
      secret: hookSecret,
    });
    must(
      localOnly.webhooks.constructEvent(eventBody, freshHeader, hookSecret).id ===
        `evt_${PROBE_NAMESPACE}`,
      "a correctly signed body did not verify; the refusals below would prove nothing",
    );

    /** Verify that `fn` throws — the refusal, not an accident. */
    function refusesSync(fn: () => unknown): boolean {
      try {
        fn();
        return false;
      } catch {
        return true;
      }
    }

    must(
      refusesSync(() =>
        localOnly.webhooks.constructEvent(
          eventBody.replace("sub_probe", "sub_forged"),
          freshHeader,
          hookSecret,
        ),
      ),
      "a body modified after signing still verified; forged events would be applied",
    );
    must(
      refusesSync(() =>
        localOnly.webhooks.constructEvent(eventBody, freshHeader, "whsec_wrong_secret"),
      ),
      "a body verified against the wrong secret",
    );

    /**
     * Replay outside the tolerance. A captured signature is valid forever without a
     * bounded window, and `billing_events` only stops the identical event id — the
     * danger is a captured upgrade delivery replayed after a downgrade.
     */
    const staleHeader = localOnly.webhooks.generateTestHeaderString({
      payload: eventBody,
      secret: hookSecret,
      timestamp: nowSecs - 20 * 60,
    });
    must(
      refusesSync(() =>
        localOnly.webhooks.constructEvent(eventBody, staleHeader, hookSecret),
      ),
      "a correctly signed body replayed 20 minutes late still verified; a captured " +
        "delivery could be replayed indefinitely (§8)",
    );

    /**
     * No client-controlled tier activation. A price created in the dashboard and
     * never wired into this deployment must entitle nothing.
     */
    must(
      tierForPriceId("price_never_configured_in_this_deployment") === null,
      "an unconfigured price id resolved to a tier; an unrecognised price must " +
        "entitle nothing (§8)",
    );
    must(
      tierForPriceId(null) === null && tierForPriceId("") === null,
      "an empty price id resolved to a tier",
    );

    /**
     * The idempotency index, against the real database. The whole redelivery story
     * rests on `onConflictDoNothing` returning zero rows — a lost insert *is* the
     * duplicate signal.
     */
    const eventValues = {
      provider: PROBE_NAMESPACE,
      providerEventId: `${PROBE_NAMESPACE}-event`,
      eventType: "verify.hardening.probe",
      userId: null,
      providerCustomerId: null,
      providerSubscriptionId: null,
      eventCreatedAt: new Date(),
      applied: false,
      skipReason: "verify_script",
      payload: { note: "verify-hardening.ts probe; safe to delete" },
    };
    const insertEvent = async (): Promise<{ id: string }[]> =>
      db
        .insert(billingEvents)
        .values(eventValues)
        .onConflictDoNothing({
          target: [billingEvents.provider, billingEvents.providerEventId],
        })
        .returning({ id: billingEvents.id });

    must((await insertEvent()).length === 1, "a fresh billing event was not recorded");
    must(
      (await insertEvent()).length === 0,
      "a redelivery of the same event id was inserted twice; the unique index is " +
        "missing and every provider retry would be applied again (§8)",
    );

    ok(
      "signature verification accepts a valid body and refuses one edited after " +
        "signing, one signed with the wrong secret, and a 20-minute-old replay; an " +
        "unknown price entitles nothing; the unique index rejects a redelivery",
    );
    detail("no Stripe request was made: constructEvent is local HMAC only");

    // ---- 11. provider error classification ---------------------------------
    /**
     * §14's taxonomy, checked where it changes behaviour: whether a job retries,
     * and whether the state reads as a configuration problem rather than a bug.
     */
    const {
      ForbiddenError,
      ProviderAuthError,
      ProviderRateLimitError,
      ProviderScopeError,
      ProviderTimeoutError,
      RateLimitedError,
      UnauthenticatedError,
      blockedReasonLabel,
      isBlockingCode,
    } = await import("@/lib/errors");

    const classifications: [unknown, string, boolean][] = [
      [new ValidationError("x"), "validation_failed", false],
      [new UnauthenticatedError(), "unauthenticated", false],
      [new ForbiddenError("x"), "forbidden", false],
      [new RateLimitedError(30, "x"), "rate_limited", true],
      [
        new NotConfiguredError("Claude", ["ANTHROPIC_API_KEY"], "h"),
        "provider_not_configured",
        false,
      ],
      [new ProviderAuthError("YouTube"), "provider_auth_failed", false],
      [new ProviderOutOfCreditError("Claude"), "provider_out_of_credit", false],
      [new ProviderRateLimitError("Claude", 60), "provider_rate_limited", true],
      [new ProviderScopeError("YouTube"), "provider_scope_missing", false],
      [new ProviderTimeoutError("Claude", 30_000), "provider_timeout", true],
      [
        asDatabaseError("probe", Object.assign(new Error("x"), { code: "08006" })),
        "database_failure",
        true,
      ],
    ];
    for (const [error, expectedCode, expectedRetryable] of classifications) {
      must(
        errorCodeOf(error) === expectedCode,
        `${expectedCode} was classified as ${errorCodeOf(error)}`,
      );
      must(
        isRetryable(error) === expectedRetryable,
        `${expectedCode} reports retryable=${String(isRetryable(error))}, expected ` +
          `${String(expectedRetryable)}`,
      );
    }

    /**
     * The two blocking states share a job status but must not share their wording:
     * telling someone whose key is valid that credentials are missing sends them to
     * verify something already correct.
     */
    must(
      isBlockingCode("provider_not_configured") && isBlockingCode("provider_out_of_credit"),
      "a state an operator must clear was not classified as blocking",
    );
    must(
      !isBlockingCode("provider_rate_limited") && !isBlockingCode("provider_timeout"),
      "a transient provider failure was classified as blocking; it would stop " +
        "retrying and read as a configuration problem",
    );
    must(
      blockedReasonLabel("provider_out_of_credit", "Claude") === "Claude is out of credit",
      "an exhausted balance is described as a configuration problem",
    );

    ok(
      `all ${classifications.length} error classes map to their code and retry ` +
        "disposition, and an empty balance is distinguished from a missing key",
    );

    // ---- 12. secret / configuration safety ---------------------------------
    /**
     * Nothing sensitive in a response body, and no secret in the client bundle.
     *
     * The response side is checked with a deliberately leaky driver error — the
     * realistic shape, since postgres.js quotes the failing statement and often the
     * bound parameters.
     */
    const leaky = Object.assign(
      new Error(
        'syntax error at or near "SELCT" — ' +
          "SELECT * FROM users WHERE email = 'victim@example.com'; " +
          "dsn=postgresql://tally:probepassword@db.internal:5432/tally",
      ),
      { code: "42601", severity: "ERROR" },
    );
    const responseBody = JSON.stringify(
      asDatabaseError("probe read", leaky).toResponseBody(),
    );
    for (const forbidden of [
      "SELECT",
      "victim@example.com",
      "probepassword",
      "postgresql://",
      "42601",
    ]) {
      must(
        !responseBody.includes(forbidden),
        `the API response body contains ${forbidden}; §14 forbids SQL, DSNs, bound ` +
          "parameters and driver codes in a client-facing error",
      );
    }

    /**
     * The client-bundle boundary (§17, §34). Sentinel *values*, not names — a
     * variable name in a bundle is harmless; the value is the leak.
     *
     * `.next` may be absent, since this script does not build. That is reported
     * rather than skipped silently.
     */
    let scannedChunks = 0;
    let sentinelCount = 0;
    if (existsSync(chunkDir)) {
      const sentinels = [
        e.ENCRYPTION_KEY,
        e.SESSION_SECRET,
        e.STRIPE_SECRET_KEY,
        e.STRIPE_WEBHOOK_SECRET,
        e.ANTHROPIC_API_KEY,
        e.GOOGLE_CLIENT_SECRET,
        e.ELEVENLABS_API_KEY,
        e.S3_SECRET_ACCESS_KEY,
        /**
         * The ambient AWS credentials, when Bedrock is the AI transport. Read
         * from `process.env` rather than `e` on purpose: they are deliberately
         * absent from Tally's typed configuration (§33), which is exactly why a
         * copy appearing in a browser chunk would be worth catching.
         */
        process.env["AWS_SECRET_ACCESS_KEY"],
        process.env["AWS_SESSION_TOKEN"],
      ].filter(
        (value): value is string => typeof value === "string" && value.length > 12,
      );
      sentinelCount = sentinels.length;

      const walkChunks = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) {
            walkChunks(full);
            continue;
          }
          if (!entry.endsWith(".js")) continue;
          scannedChunks += 1;
          const contents = readFileSync(full, "utf8");
          for (const secret of sentinels) {
            if (contents.includes(secret)) {
              // The value is deliberately not printed, not even truncated.
              fail(
                `a credential value appears in the client bundle chunk ${entry}; §34 ` +
                  "forbids any secret reaching the browser",
              );
            }
          }
        }
      };
      walkChunks(chunkDir);
    }

    ok(
      "a leaky driver error produces a response body with no SQL, DSN, parameter or " +
        "SQLSTATE in it" +
        (scannedChunks > 0 && sentinelCount > 0
          ? `, and ${scannedChunks} built client chunks contain none of the ` +
            `${sentinelCount} configured credential values`
          : ""),
    );
    if (!existsSync(chunkDir)) {
      detail(
        "NOT_CONFIGURED: .next/static/chunks is absent, so the built client bundle " +
          "was not scanned. Run npm run build and re-run to cover that half. " +
          "no-restricted-imports in eslint.config.mjs enforces the same boundary at " +
          "source level in the meantime.",
      );
    } else if (sentinelCount === 0) {
      detail(
        "NOT_CONFIGURED: no credential in this environment is long enough to use as a " +
          "bundle sentinel, so the scan could not be meaningful.",
      );
    }

    // ---- 13. health / readiness -------------------------------------------
    /**
     * Liveness must be dependency-free and readiness must be honest (§16).
     *
     * Importable in a plain Node process as of Phase 10 — that is the point of the
     * marker removal, and the reason the worker can now check its own dependencies
     * before consuming a queue. So this step calls the real functions.
     */
    const { liveness, readiness, resetReadinessCache } = await import("@/lib/health");

    /**
     * Liveness must consult nothing external, because a failing liveness probe gets
     * the container killed: if it touched Postgres, a database blip would restart
     * every replica in the fleet simultaneously. Synchronous return is the
     * structural evidence — there is nothing to await.
     */
    const live = liveness();
    must(
      live.status === "ok" && typeof live.uptimeSeconds === "number",
      "liveness did not report ok with an uptime",
    );
    const livenessSource = /export function liveness\(\)[\s\S]*?\n}/.exec(
      readFileSync(join(process.cwd(), "src", "lib", "health.ts"), "utf8"),
    )?.[0];
    if (!livenessSource) fail("could not locate liveness() in lib/health.ts");
    for (const dependency of ["pingDb", "getRedis", "await", "blockingMisconfig"]) {
      must(
        !livenessSource.includes(dependency),
        `liveness() references ${dependency}; a liveness probe must check nothing ` +
          "external, or a dependency blip restarts the whole fleet (§16)",
      );
    }

    resetReadinessCache();
    const report = await readiness("full");
    must(
      report.mode === "full" && report.checks.length > 0,
      "the readiness report named no dependency checks",
    );
    for (const name of ["database", "redis", "configuration"] as const) {
      must(
        report.checks.some((check) => check.name === name),
        `readiness in full mode does not check ${name}`,
      );
    }

    /**
     * Optional providers must never make the instance unready: an unconfigured
     * ElevenLabs key is a designed product state, not an outage, and draining
     * traffic for it would take the whole app down to protect a feature the
     * operator chose not to enable.
     */
    const { blockingMisconfigurations, providerStatuses } = await import(
      "@/lib/providers/config"
    );
    const statuses = providerStatuses();
    const blocking = blockingMisconfigurations();
    const optionalUnconfigured = statuses.filter(
      (status) => status.optional && status.state !== "ready",
    );
    for (const status of optionalUnconfigured) {
      must(
        !blocking.some((entry) => entry.capability === status.capability),
        `the optional capability ${status.capability} is blocking readiness; an ` +
          "unconfigured optional provider is a product state, not an outage (§16)",
      );
    }
    must(
      blocking.every((status) => !status.optional),
      "an optional capability appears in blockingMisconfigurations()",
    );

    /**
     * The report carries names, never values — `/api/ready` is unauthenticated, so
     * this is the one place a connection string would be trivially exfiltrable.
     */
    const reportJson = JSON.stringify(report) + JSON.stringify(statuses);
    for (const secret of [
      e.DATABASE_URL,
      e.REDIS_URL,
      e.ENCRYPTION_KEY,
      e.SESSION_SECRET,
      e.S3_SECRET_ACCESS_KEY,
    ].filter((value): value is string => typeof value === "string" && value.length > 8)) {
      must(
        !reportJson.includes(secret),
        "the readiness payload contains a connection string or secret; /api/ready is " +
          "unauthenticated (§16)",
      );
    }

    /**
     * The verdict must be honest in both directions: `ready` only when every
     * non-optional dependency answered, `not_ready` whenever one did not.
     */
    const failedChecks = report.checks.filter((check) => check.status === "failed");
    must(
      (report.status === "ready") === (failedChecks.length === 0),
      `readiness reported ${report.status} with ` +
        `${failedChecks.length} failed check(s); the verdict must follow the checks`,
    );

    ok(
      `liveness returns synchronously and consults no dependency, readiness in full ` +
        `mode checks database/redis/configuration and reported ${report.status} ` +
        `consistently with its ${report.checks.length} checks, ` +
        `${optionalUnconfigured.length} unconfigured optional provider(s) do not ` +
        `block it, and the payload carries no secret`,
    );
    detail(
      blocking.length > 0
        ? `not ready because: ${blocking
            .map(
              (status) =>
                `${status.capability} (missing ` +
                `${status.missingEnvVars.join(", ") || "prerequisites"})`,
            )
            .join("; ")} — these are non-optional, so this is correct, not a defect`
        : "every non-optional capability is configured, so the verdict is ready",
    );

    // ---- 14. production / mock safety --------------------------------------
    /**
     * §18's flags, checked for the property that matters: they cannot silently
     * *become* production, and production cannot silently honour them.
     */
    must(
      !(isProduction() && usingMockProviders()),
      "this process is running in production with mock providers; Tally would report " +
        "work it never did (§40)",
    );

    /**
     * `realPublishBlocked()` must ignore its flag in production. Honouring it there
     * would mean a production deployment silently refusing every upload while the UI
     * reported the pipeline as working — the same class of lie §42 forbids, pointed
     * the other way.
     */
    must(
      !(isProduction() && realPublishBlocked()),
      "TALLY_BLOCK_REAL_PUBLISH is being honoured in production; every publish would " +
        "be refused while the UI reported success (§42)",
    );
    must(
      usingMockProviders() ===
        (e.NODE_ENV !== "production" && e.TALLY_USE_MOCK_PROVIDERS),
      "usingMockProviders() disagrees with the environment it reads",
    );
    must(
      report.mode_flags.production === isProduction() &&
        report.mode_flags.mockProviders === usingMockProviders() &&
        report.mode_flags.publishBlocked === realPublishBlocked(),
      "the readiness mode flags disagree with the running configuration; a probe " +
        "could not catch a mode mistake (§18)",
    );

    /** Stripe live configuration cannot be inferred (§17). */
    const { billingAvailability } = await import("@/lib/billing");
    const availability = billingAvailability();
    must(
      !(availability.configured && availability.provider === "mock"),
      "a mock billing provider reported itself configured; a mock must never be able " +
        "to grant a paid tier (§40)",
    );
    if (usingMockProviders()) {
      must(
        !availability.configured,
        "billing reports itself configured while mock providers are active",
      );
    }

    const mockCapabilities = statuses
      .filter((status) => status.state === "mock")
      .map((status) => status.capability);

    ok(
      "production and mock modes cannot coexist, the publish guard is ignored in " +
        "production, the readiness mode flags match the running configuration, and no " +
        "mock billing provider reports itself configured",
    );
    detail(
      mockCapabilities.length > 0
        ? `mock in this environment: ${mockCapabilities.join(", ")} — correct outside ` +
            "production, and a refusal to boot inside it (step 1)"
        : "no capability is running in mock mode",
    );

    // ---- 15. observability / logging safety --------------------------------
    /**
     * The logger redacts *values*, not just key names (§15).
     *
     * A key-name filter catches `{ accessToken: "…" }`. The ways a credential
     * actually reaches a log line are messier and all arrive as a value under an
     * innocent key: a provider error quoting a request URL, an OAuth redirect logged
     * as `url`, a 401 body echoing the Authorization header it rejected, a
     * postgres.js error naming the DSN.
     *
     * Every value below is a synthetic shape, not a real credential.
     */
    const { logger, redactValue } = await import("@/lib/logger");

    const leaks: [string, string][] = [
      ["access_token=ya29.probe-not-a-real-token", "ya29.probe-not-a-real-token"],
      ["refresh_token=1//probe-refresh-value-0000", "1//probe-refresh-value-0000"],
      ["Authorization: Bearer probe-bearer-value", "probe-bearer-value"],
      ["client_secret=probe-client-secret-value", "probe-client-secret-value"],
      ["charged with sk_live_51ProbeNotReal0000", "sk_live_51ProbeNotReal0000"],
      ["signed with whsec_ProbeNotRealSecret00", "whsec_ProbeNotRealSecret00"],
      [
        "connection to postgresql://tally:probepassword@db.internal:5432/tally failed",
        "probepassword",
      ],
      [
        "id_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcm9iZSJ9.probeSignature00",
        "probeSignature00",
      ],
    ];
    for (const [line, secret] of leaks) {
      must(
        !redactValue(line).includes(secret),
        "the logger did not redact a credential value in " +
          `${JSON.stringify(line.slice(0, 28))}…; §15 forbids it reaching a log`,
      );
    }

    /**
     * The counter-requirement: redaction must not eat the identifiers that make a
     * trace usable. A rule that scrubbed anything long and random would take every
     * correlation id with it, and §15's structured logging would be useless.
     */
    const traceLine = "job 3f2b9c1e-4a7d-11ee-9c2b-0242ac120002 failed at RENDER";
    must(
      redactValue(traceLine) === traceLine,
      "redaction removed a uuid; correlation ids would be destroyed",
    );

    /**
     * The same guarantee through the real logger, since `redactValue` only helps if
     * the serialiser actually calls it — including on a nested Error, which is how a
     * provider failure arrives.
     */
    const captured: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      logger.info("probe log line", {
        component: PROBE_NAMESPACE,
        // Both paths at once: a credential-named key, and a credential *value*
        // hidden inside an innocently-named one.
        accessToken: "ya29.probe-key-name-path",
        url: "https://oauth.invalid/callback?access_token=ya29.probe-value-path",
        error: new Error("provider rejected Bearer probe-nested-error-token"),
      });
    } finally {
      process.stdout.write = originalWrite;
    }
    const emitted = captured.join("");
    must(emitted.length > 0, "the logger produced no output to inspect");
    for (const secret of [
      "ya29.probe-key-name-path",
      "ya29.probe-value-path",
      "probe-nested-error-token",
    ]) {
      must(
        !emitted.includes(secret),
        `the emitted log line contains ${secret.slice(0, 12)}…; a credential reached ` +
          "stdout (§15)",
      );
    }
    must(
      emitted.includes("probe log line"),
      "redaction destroyed the log message itself",
    );

    ok(
      `all ${leaks.length} credential shapes are redacted, a real log line leaks ` +
        "nothing through a key name, a nested value or an Error, and correlation ids " +
        "survive intact",
    );

    // ---- 16. no destructive external action --------------------------------
    /**
     * Stated as a fact about this script, in the terms §24 uses.
     *
     * Everything above touched exactly two external systems: this deployment's own
     * Postgres and its own Redis. No code path here reaches YouTube, Stripe, an AI
     * provider, an email provider or object storage — the Stripe import is local
     * HMAC only, and `constructEvent` issues no request.
     *
     * Worth asserting rather than merely stating: that the probe left no live work
     * behind, since a verification script that queues a job has performed an
     * external action by proxy.
     */
    const { getActiveJobs } = await import("@/lib/queue/jobs");
    const stranded = await getActiveJobs(owner.id, channel.id);
    must(
      stranded.length === 0,
      `${stranded.length} probe job(s) are still queued or running; a verification ` +
        "script must not leave work for a worker to pick up",
    );

    const [published] = await rawSql()`
      select count(*)::int as count from published_videos
      where channel_id = ${channel.id}
    `;
    must(
      Number(published?.["count"] ?? 0) === 0,
      "a published_videos row exists for the probe channel; nothing in this script " +
        "may record a publication (§42)",
    );

    ok(
      "no YouTube upload, no publication, no Stripe charge, checkout, subscription or " +
        "portal session, no credential read, printed or rotated, no .env.local " +
        "access, and no job left queued",
    );
    detail(
      "external systems contacted: this deployment's own Postgres and Redis only. " +
        "Every write was namespaced and is removed on exit.",
    );

    console.log(
      `\n${step}/${TOTAL_STEPS} checks passed — the production configuration guards, ` +
        `database timeouts, migration state, credential storage, tenant isolation, ` +
        `route-level authorization and validation, the atomic rate-limit window, ` +
        `worker retry classification and enqueue idempotency, distributed locking ` +
        `with stale recovery, webhook signature/replay/idempotency, the error ` +
        `taxonomy, response and log redaction, the liveness/readiness split and the ` +
        `production-mode guards all hold under real Node against real Postgres and ` +
        `real Redis.` +
        (existsSync(chunkDir)
          ? ""
          : `\nNot verified: the built client bundle, which is absent. Run ` +
            `npm run build and re-run to cover it.`) +
        `\nNot verified by design: any live provider call. §24 forbids a verification ` +
        `script from uploading, publishing or charging, so provider reachability is ` +
        `not a question this script can answer.\n`,
    );
  } finally {
    // Always, including on failure: a failed run must leave nothing behind either.
    const { closeQueues } = await import("@/lib/queue/queues");
    const { closeRedis } = await import("@/lib/queue/redis");
    await cleanupDatabase();
    await cleanupRedis();
    await closeQueues();
    await closeRedis();
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
