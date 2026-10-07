/**
 * Cloudflare D1 migration schema (not yet used by the application runtime).
 *
 * Conventions:
 *  - Every user-owned table carries `userId` even when it could be reached
 *    through a join. Tenant isolation is then a single predicate on every
 *    query, not a property of getting the join right (§34).
 *  - No binary media is stored here. Media lives in object storage; these
 *    tables hold storage keys, metadata and provenance (§22).
 *  - Provider credentials are stored as ciphertext produced by lib/crypto.
 *  - Timestamps are UTC epoch milliseconds, decoded to Date objects by Drizzle.
 */
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  char,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "./sqlite-columns";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** §20 — the persisted project/video state machine. */
export const projectStatusEnum = pgEnum("project_status", [
  "IDEA",
  "SCRIPT_GENERATING",
  "SCRIPT_READY",
  "ASSETS_GENERATING",
  "ASSETS_READY",
  "RENDERING",
  "VIDEO_READY",
  "THUMBNAIL_GENERATING",
  "READY_TO_PUBLISH",
  "SCHEDULED",
  "PUBLISHING",
  "PUBLISHED",
  "FAILED",
]);

/** Pipeline stages, each independently trackable (§10, §38). */
export const pipelineStageEnum = pgEnum("pipeline_stage", [
  "RESEARCH",
  "SCRIPT",
  "SCENE_PLAN",
  "VOICEOVER",
  "VISUALS",
  "MUSIC",
  "CAPTIONS",
  "TIMELINE",
  "RENDER",
  "QUALITY_CHECK",
  "THUMBNAIL",
  "METADATA",
  "PUBLISH",
]);

export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "blocked_not_configured",
]);

export const planTierEnum = pgEnum("plan_tier", ["starter", "studio", "scale"]);

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "active",
  "trialing",
  "past_due",
  "canceled",
  "incomplete",
  "unpaid",
]);

/**
 * Why a credit ledger row exists (§8, §12).
 *
 * An enum rather than free text because every one of these is read by code: the
 * balance projection sums `grant`/`purchase`/`refund` against `spend`, the history
 * screen groups by reason, and the period-grant idempotency check looks for an
 * existing `monthly_grant` for the period. Free text would make each of those a
 * string comparison nobody would notice going stale.
 *
 * Signs are a property of the reason, not a free choice: `spend` rows are the only
 * negative ones, and a check constraint in the migration enforces it. That is what
 * makes "sum the ledger" a correct definition of the balance rather than a
 * convention.
 */
export const creditReasonEnum = pgEnum("credit_reason", [
  /** The plan's included allowance for a billing period. Positive. */
  "monthly_grant",
  /** A one-off pack bought through Stripe (§11). Positive, and never expires. */
  "purchase",
  /** A generation was charged. Negative — the only negative reason. */
  "spend",
  /** A charged generation failed, so the charge is returned (§12). Positive. */
  "refund",
  /** An operator adjustment, e.g. goodwill after an incident. Positive. */
  "adjustment",
]);

export const automationLevelEnum = pgEnum("automation_level", [
  /** Vidxir AI researches and drafts; user approves every step. */
  "manual",
  /** Vidxir AI produces a finished video; user approves before publishing. */
  "assisted",
  /** Vidxir AI researches, produces and publishes on schedule. */
  "autopilot",
]);

export const assetKindEnum = pgEnum("asset_kind", [
  "stock_video",
  "stock_image",
  "generated_image",
  "generated_video",
  "voiceover",
  "music",
  "sfx",
  "caption_file",
  "render_output",
  "thumbnail",
  "upload",
]);

export const publishVisibilityEnum = pgEnum("publish_visibility", [
  "public",
  "unlisted",
  "private",
]);

export const publishJobStatusEnum = pgEnum("publish_job_status", [
  "queued",
  "scheduled",
  "publishing",
  "published",
  "failed",
  "cancelled",
]);

export const emailTokenPurposeEnum = pgEnum("email_token_purpose", [
  "verify_email",
  "reset_password",
]);

/**
 * Where a stored metric came from (Phase 9 §6).
 *
 * The point of this enum is that "we did not measure it" and "we measured zero"
 * must be different states in the database, not two readings of the same null.
 */
export const analyticsMetricSourceEnum = pgEnum("analytics_metric_source", [
  /** The provider returned the value directly. */
  "provider",
  /** Computed from other values the provider did return, arithmetic only. */
  "derived_views_impressions",
  /** The provider was asked and does not offer this metric at all. */
  "provider_unsupported",
  /** The provider was asked and returned no value for this row. */
  "provider_null",
]);

/**
 * Why a revenue figure is present or absent (Phase 9 §7).
 *
 * `scope_missing` is the common case in practice: revenue requires the
 * `yt-analytics-monetary.readonly` scope, and a channel connected without it
 * cannot report earnings. That is a permission state, not zero earnings, and
 * conflating the two would show a monetised channel $0.00.
 */
export const revenueStateEnum = pgEnum("revenue_state", [
  /** A real figure was returned and is stored in `estimated_revenue`. */
  "reported",
  /** The provider reported exactly zero for this period. Not the same as absent. */
  "reported_zero",
  /** The connected account has not granted the monetary analytics scope. */
  "scope_missing",
  /** The channel is not in the YouTube Partner Program, so there is no revenue. */
  "not_monetized",
  /** The provider was asked and declined to report (privacy threshold, delay). */
  "unavailable",
  /** Revenue was never requested for this row. */
  "not_requested",
]);

/** Lifecycle of a thumbnail A/B test (Phase 9 §8). */
export const experimentStatusEnum = pgEnum("experiment_status", [
  /** Created, arms chosen, nothing shown to YouTube yet. */
  "draft",
  "running",
  "completed",
  "cancelled",
]);

/**
 * How a test ended.
 *
 * `insufficient_data` exists so a test that ran without gathering enough
 * observations reports that plainly, rather than crowning whichever arm happened
 * to be ahead (§10).
 */
export const experimentOutcomeEnum = pgEnum("experiment_outcome", [
  "winner",
  /** Enough data, but no arm cleared the required margin over the control. */
  "no_winner",
  /** Enough data, and the leaders are within the noise margin of each other. */
  "tie",
  /** Ended before the minimum impressions/observation days were reached. */
  "insufficient_data",
  /** A human stopped it. */
  "stopped",
]);

// ---------------------------------------------------------------------------
// Identity & access (§4)
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    email: varchar("email", { length: 320 }).notNull(),
    /** Lower-cased email used for uniqueness and lookup. */
    emailNormalized: varchar("email_normalized", { length: 320 }).notNull(),
    /** scrypt digest, formatted `scrypt$N$r$p$salt$hash`. Never plaintext. */
    passwordHash: text("password_hash").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    /** Set once §5 onboarding is finished; gates the dashboard. */
    onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
    /** Bumped on password change to invalidate every existing session. */
    sessionEpoch: integer("session_epoch").notNull().default(0),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [uniqueIndex("users_email_normalized_key").on(t.emailNormalized)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 of the opaque cookie token. The raw token is never stored. */
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    /** Session is invalid if this differs from users.session_epoch. */
    epoch: integer("epoch").notNull().default(0),
    userAgent: text("user_agent"),
    ipAddress: varchar("ip_address", { length: 45 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_key").on(t.tokenHash),
    index("sessions_user_id_idx").on(t.userId),
    index("sessions_expires_at_idx").on(t.expiresAt),
  ],
);

/** Single-use tokens for email verification and password reset. */
export const emailTokens = pgTable(
  "email_tokens",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: emailTokenPurposeEnum("purpose").notNull(),
    /** SHA-256 of the token that was emailed. */
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex("email_tokens_token_hash_key").on(t.tokenHash),
    index("email_tokens_user_purpose_idx").on(t.userId, t.purpose),
  ],
);

// ---------------------------------------------------------------------------
// Plans & billing (§23, §24)
// ---------------------------------------------------------------------------

export const plans = pgTable("plans", {
  /** Stable slug, also the enum value used in code. */
  tier: planTierEnum("tier").primaryKey(),
  name: varchar("name", { length: 64 }).notNull(),
  priceCents: integer("price_cents").notNull(),
  /** null = unlimited. Enforced server-side; frontend values are never trusted. */
  maxChannels: integer("max_channels"),
  maxVideosPerMonth: integer("max_videos_per_month"),
  /**
   * Credits included each billing period (§7).
   *
   * Not nullable and defaulted to zero, unlike the two limits above where null means
   * unlimited. There is no unlimited credit allowance — see the `monthlyCredits`
   * docblock in `plans/index.ts`. The default exists only so the column can be added
   * to existing rows; every row is then set from the catalogue by `db:migrate`.
   */
  monthlyCredits: integer("monthly_credits").notNull().default(0),
  /** Feature flags: aiVoiceover, brollLibrary, thumbnailAbTest, autoPublish, ... */
  features: jsonb("features")
    .notNull()
    .$type<Record<string, boolean>>()
    .default(sql`'{}'`),
  /** Higher wins in the render queue (§23 priority render queue). */
  queuePriority: integer("queue_priority").notNull().default(1),
  stripePriceId: varchar("stripe_price_id", { length: 128 }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tier: planTierEnum("tier").notNull().default("starter"),
    status: subscriptionStatusEnum("status").notNull().default("active"),
    /** Authoritative source is the billing provider webhook, not the client. */
    provider: varchar("provider", { length: 32 }).notNull().default("none"),
    providerCustomerId: varchar("provider_customer_id", { length: 128 }),
    providerSubscriptionId: varchar("provider_subscription_id", { length: 128 }),
    currentPeriodStart: timestamp("current_period_start", {
      withTimezone: true,
    }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    /**
     * Provider timestamp of the newest event applied to this row.
     *
     * Stripe does not guarantee delivery order, so an older `updated` event can
     * land after a newer one. Applying it would silently revert the tier. The
     * handler compares against this and skips anything not strictly newer.
     */
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex("subscriptions_user_id_key").on(t.userId),
    index("subscriptions_provider_sub_idx").on(t.providerSubscriptionId),
  ],
);

/**
 * Every billing-provider event Vidxir AI has seen (§24, §32).
 *
 * Two jobs, both load-bearing:
 *
 *  1. **Idempotency.** Stripe redelivers on any non-2xx, and at-least-once
 *     delivery is its documented contract. `provider_event_id` is unique, so a
 *     redelivery loses the insert and the handler returns without applying the
 *     change a second time. Without this a retried `subscription.deleted` would
 *     re-run a downgrade over a subsequent re-subscribe.
 *  2. **Audit.** A paid tier can only ever be granted by a row here, so "why does
 *     this account have Studio?" is answerable from the database alone.
 *
 * `payload` holds the provider's own object as received. It contains no card
 * numbers — Stripe never sends them — and no API keys.
 */
export const billingEvents = pgTable(
  "billing_events",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    provider: varchar("provider", { length: 32 }).notNull(),
    /** The provider's event id, e.g. `evt_…`. The idempotency key. */
    providerEventId: varchar("provider_event_id", { length: 128 }).notNull(),
    eventType: varchar("event_type", { length: 96 }).notNull(),
    /**
     * Nullable: an event can arrive for a customer Vidxir AI cannot resolve to a user
     * (a subscription created directly in the Stripe dashboard, say). It is still
     * recorded — silently dropping it would erase the only evidence it happened.
     */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    providerCustomerId: varchar("provider_customer_id", { length: 128 }),
    providerSubscriptionId: varchar("provider_subscription_id", { length: 128 }),
    /** The provider's own event timestamp, used to reject out-of-order deliveries. */
    eventCreatedAt: timestamp("event_created_at", { withTimezone: true }).notNull(),
    /** False when the event was recorded but deliberately not applied. */
    applied: boolean("applied").notNull().default(false),
    /** Why it was not applied: `duplicate`, `stale`, `unhandled`, `unknown_customer`. */
    skipReason: varchar("skip_reason", { length: 48 }),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex("billing_events_provider_event_key").on(
      t.provider,
      t.providerEventId,
    ),
    index("billing_events_user_received_idx").on(t.userId, t.receivedAt),
    index("billing_events_subscription_idx").on(t.providerSubscriptionId),
  ],
);

/** Monthly quota counters, incremented server-side when work is committed. */
export const usageCounters = pgTable(
  "usage_counters",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `YYYY-MM` in UTC. */
    period: varchar("period", { length: 7 }).notNull(),
    videosStarted: integer("videos_started").notNull().default(0),
    videosPublished: integer("videos_published").notNull().default(0),
    rendersCompleted: integer("renders_completed").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [primaryKey({ columns: [t.userId, t.period] })],
);

// ---------------------------------------------------------------------------
// Credits (§7–§13)
// ---------------------------------------------------------------------------

/**
 * The authoritative credit balance — one row per user (§7, §10).
 *
 * ## Why a balance row and not just the ledger
 *
 * The balance is *derivable* by summing `credit_ledger`, and that sum is the
 * definition of correctness — the integration suite asserts the two agree. It is also
 * materialised here, for one reason that is about locking rather than speed:
 *
 * A charge has to be **atomic and refuse when insufficient** (§10, §13). Expressed
 * against a balance row that is one conditional UPDATE:
 *
 *     UPDATE credit_balances SET spent = spent + N
 *      WHERE user_id = $1 AND (granted + purchased - spent) >= N
 *
 * Two concurrent charges contend on that row; the second blocks, re-reads the
 * committed value, and its predicate fails if the money has gone. Expressed against a
 * ledger sum it would be a read followed by an insert, with nothing serialising them —
 * two requests could both read a balance of 10 and both spend 10. `SERIALIZABLE` or an
 * advisory lock would close that, but both are heavier and easier to get wrong than a
 * row that is already the natural point of contention.
 *
 * ## Why three counters instead of one signed integer
 *
 * `granted`, `purchased` and `spent` are kept apart because §11 requires purchased
 * credits to be tracked separately from monthly ones — a customer who bought 500
 * credits must not lose them when the month rolls over. `resetMonthly` zeroes
 * `granted` and the portion of `spent` it covered; `purchased` is never touched by a
 * reset. A single signed balance could not express that distinction, so the reset
 * would either delete bought credits or never reclaim unused monthly ones.
 *
 * All three are monotonically increasing within a period, which makes them safe to
 * increment concurrently — there is no read-modify-write anywhere in the charge path.
 */
export const creditBalances = pgTable(
  "credit_balances",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * The current period's plan allowance, as granted. Reset each period.
     *
     * Not the *remaining* allowance: this is what was given, and `spent` is what was
     * taken. Storing "remaining" would mean a grant had to read before it wrote.
     */
    granted: integer("granted").notNull().default(0),
    /**
     * Credits bought through Stripe that are still on the account (§11).
     *
     * Survives every period reset, which is the whole point of the column. Purchased
     * credits are consumed *after* the monthly allowance — see `chargeCredits` — so a
     * customer who tops up mid-month still uses their included credits first.
     */
    purchased: integer("purchased").notNull().default(0),
    /** Everything spent this period, net of refunds. Reset alongside `granted`. */
    spent: integer("spent").notNull().default(0),
    /**
     * `YYYY-MM` in UTC — which period `granted` and `spent` refer to.
     *
     * The idempotency key for the monthly grant, together with `userId`: a grant for
     * a period this column already names is a no-op, so the grant can be called from
     * anywhere (a webhook, a scheduled task, or lazily on first use) without double-
     * granting. §13 requires exactly that property.
     */
    period: varchar("period", { length: 7 }).notNull(),
    /** The tier the current grant was issued for, so a mid-period upgrade is visible. */
    grantedForTier: planTierEnum("granted_for_tier").notNull().default("starter"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("credit_balances_period_idx").on(t.period),
    check("credit_balances_non_negative", sql`${t.granted} >= 0 AND ${t.purchased} >= 0 AND ${t.spent} >= 0 AND ${t.granted} + ${t.purchased} - ${t.spent} >= 0`),
  ],
);

/**
 * Append-only record of every credit movement (§8, §12).
 *
 * ## Why this is not `api_usage`
 *
 * `api_usage` already records every provider call, and reusing it as the ledger was
 * considered. It cannot be one: `withUsage` deliberately **swallows its own write
 * failures** so that a logging problem never fails a generation the customer already
 * paid for. That is right for an audit log and disqualifying for a ledger — money that
 * silently fails to be recorded is money that cannot be reconciled. The two coexist:
 * `api_usage` answers "what did we ask the vendor", this answers "what did the
 * customer pay".
 *
 * ## Idempotency (§13)
 *
 * `idempotency_key` is unique where present. A charge supplies a key derived from what
 * is being generated — `{projectId}:{sceneIndex}:{attempt}` for a scene — so a retried
 * job loses the insert and charges nothing. `ON CONFLICT DO NOTHING` returning no row
 * is how the caller learns the charge already happened, without a separate read that
 * could race. The column is nullable because an operator adjustment has no natural
 * key, and a partial unique index means those rows do not collide with each other.
 *
 * ## Signs
 *
 * `amount` is signed: negative for `spend`, positive for everything else, enforced by
 * a check constraint. `balance_after` is the balance at the moment the row was
 * written, stored so the history screen can show a running total without re-summing,
 * and so a divergence between the ledger and `credit_balances` is *locatable* rather
 * than merely detectable.
 */
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: creditReasonEnum("reason").notNull(),
    /** Signed. Negative only for `spend`; a check constraint enforces it. */
    amount: integer("amount").notNull(),
    /** Available balance immediately after this row was applied. */
    balanceAfter: integer("balance_after").notNull(),
    /**
     * What was generated, for a `spend` or `refund`: `video_scene` or `image`.
     *
     * Null for grants and purchases, which are not attributable to an operation.
     */
    operation: varchar("operation", { length: 32 }),
    /** The branded model id charged for, e.g. `tal/3.0`. Never a vendor name (§3). */
    modelId: varchar("model_id", { length: 64 }),
    /** The resolution charged for, which is half of what determined the price. */
    quality: varchar("quality", { length: 16 }),
    /**
     * The project the spend belongs to, when there is one.
     *
     * `set null` rather than `cascade`: deleting a project must not erase the record
     * that it was paid for. A ledger with holes in it cannot be reconciled against
     * revenue.
     */
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    /** Unique where present. The retry guard described above. */
    idempotencyKey: varchar("idempotency_key", { length: 200 }),
    /** `YYYY-MM` the movement fell in, for per-period reporting. */
    period: varchar("period", { length: 7 }).notNull(),
    /** Human-readable line for the history screen. Never contains a vendor name. */
    description: text("description"),
    /**
     * Free-form context: the Stripe session for a purchase, the failed job for a
     * refund, the scene index for a spend. Never a credential.
     */
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    check("credit_ledger_sign_matches_reason", sql`(${t.reason} = 'spend' AND ${t.amount} < 0) OR (${t.reason} <> 'spend' AND ${t.amount} > 0)`),
    uniqueIndex("credit_ledger_idempotency_key").on(t.idempotencyKey).where(sql`${t.idempotencyKey} IS NOT NULL`),
    index("credit_ledger_user_created_idx").on(t.userId, t.createdAt),
    index("credit_ledger_user_period_idx").on(t.userId, t.period),
    index("credit_ledger_project_idx").on(t.projectId),
  ],
);

/**
 * Stripe checkout sessions opened for a credit pack (§11, §13).
 *
 * The purchase equivalent of `billing_events`: a session is a *request* to buy, and
 * the credits are only added when the webhook confirms payment. This row is what lets
 * the webhook know how many credits a completed session is worth **without trusting
 * anything in the session** — the pack and its credit count are written here at
 * creation time, server-side, from the pack catalogue.
 *
 * Reading the amount back out of Stripe's session metadata would be the obvious
 * alternative and is worse: metadata is writable by anyone with the API key, and the
 * amount paid is in a currency, not in credits. This table means the credit grant is
 * decided by Vidxir AI at a moment when nothing external has been consulted.
 */
export const creditPurchases = pgTable(
  "credit_purchases",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The pack slug from the catalogue, e.g. `credits_500`. */
    pack: varchar("pack", { length: 32 }).notNull(),
    /** Credits this session grants when it completes. Set server-side, never read back. */
    credits: integer("credits").notNull(),
    /** What Stripe will charge, recorded for the receipt line. */
    amountCents: integer("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("usd"),
    /** The Stripe checkout session id. Unique — one row per session. */
    providerSessionId: varchar("provider_session_id", { length: 200 }).notNull(),
    providerPaymentIntentId: varchar("provider_payment_intent_id", { length: 200 }),
    /** `pending` until the webhook confirms, then `completed`, `failed` or `expired`. */
    status: varchar("status", { length: 24 }).notNull().default("pending"),
    /**
     * The ledger row this purchase created, once it completed.
     *
     * Set in the same transaction that writes the ledger row, so "credited" is one
     * fact rather than two that could disagree. Null means not yet credited.
     */
    ledgerId: uuid("ledger_id").references(() => creditLedger.id, {
      onDelete: "set null",
    }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex("credit_purchases_session_key").on(t.providerSessionId),
    index("credit_purchases_user_created_idx").on(t.userId, t.createdAt),
  ],
);

/**
 * §5 onboarding answers, captured before any channel is connected.
 *
 * These are account-level *defaults*. Per-channel strategy lives in
 * `channel_settings` and is seeded from here when a channel is connected, so
 * §27 still holds: nothing is shared between channels after creation, and
 * editing one channel never changes another.
 */
export const onboardingProfiles = pgTable("onboarding_profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** The channel URL or handle the user told us about, before OAuth confirms it. */
  declaredChannelUrl: text("declared_channel_url"),
  niche: varchar("niche", { length: 160 }),
  targetAudience: text("target_audience"),
  contentLanguage: varchar("content_language", { length: 16 })
    .notNull()
    .default("en-US"),
  preferredLengthSeconds: integer("preferred_length_seconds")
    .notNull()
    .default(480),
  uploadsPerWeek: integer("uploads_per_week").notNull().default(1),
  contentStyle: varchar("content_style", { length: 64 }),
  voicePreference: varchar("voice_preference", { length: 64 }),
  automationLevel: automationLevelEnum("automation_level")
    .notNull()
    .default("manual"),
  publishDays: jsonb("publish_days")
    .notNull()
    .$type<number[]>()
    .default(sql`'[1,3,5]'`),
  publishTimes: jsonb("publish_times")
    .notNull()
    .$type<string[]>()
    .default(sql`'["18:00"]'`),
  timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),
  /** Furthest step reached, so a refresh resumes rather than restarts (§45). */
  lastStep: integer("last_step").notNull().default(0),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

// ---------------------------------------------------------------------------
// Channels (§6, §27, §28)
// ---------------------------------------------------------------------------

export const channels = pgTable(
  "channels",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** YouTube channel id (UC...). */
    youtubeChannelId: varchar("youtube_channel_id", { length: 64 }).notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    handle: varchar("handle", { length: 120 }),
    description: text("description"),
    thumbnailUrl: text("thumbnail_url"),
    /** Cached YouTube statistics, refreshed by a scheduled job (§25). */
    subscriberCount: integer("subscriber_count"),
    videoCount: integer("video_count"),
    viewCount: numeric("view_count", { precision: 20, scale: 0 }),
    statsRefreshedAt: timestamp("stats_refreshed_at", { withTimezone: true }),

    /** AES-256-GCM ciphertext. Never sent to the frontend (§6). */
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    grantedScopes: text("granted_scopes"),
    /** Set when the refresh token is rejected — UI must prompt re-auth (§30). */
    reauthRequiredAt: timestamp("reauth_required_at", { withTimezone: true }),
    lastTokenErrorMessage: text("last_token_error_message"),

    connectedAt: timestamp("connected_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    // A YouTube channel may only be connected once per user.
    uniqueIndex("channels_user_youtube_key").on(t.userId, t.youtubeChannelId),
    index("channels_user_id_idx").on(t.userId),
  ],
);

/** Per-channel content strategy (§5, §27). Never shared across channels. */
export const channelSettings = pgTable(
  "channel_settings",
  {
    channelId: uuid("channel_id")
      .primaryKey()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    niche: varchar("niche", { length: 160 }),
    targetAudience: text("target_audience"),
    /** BCP-47 language tag for script + voiceover. */
    contentLanguage: varchar("content_language", { length: 16 })
      .notNull()
      .default("en-US"),
    /** Target duration in seconds. */
    preferredLengthSeconds: integer("preferred_length_seconds")
      .notNull()
      .default(480),
    uploadsPerWeek: integer("uploads_per_week").notNull().default(1),
    contentStyle: varchar("content_style", { length: 64 }),
    videoStyle: varchar("video_style", { length: 64 }),
    thumbnailStyle: varchar("thumbnail_style", { length: 64 }),
    voiceProviderVoiceId: varchar("voice_provider_voice_id", { length: 128 }),
    voiceStyle: varchar("voice_style", { length: 64 }),
    voiceSpeed: real("voice_speed").notNull().default(1),
    /** Channels the user wants tracked as competitors (§7). */
    competitorChannelIds: jsonb("competitor_channel_ids")
      .notNull()
      .$type<string[]>()
      .default(sql`'[]'`),
    /** Topic keywords seeding research. */
    keywords: jsonb("keywords")
      .notNull()
      .$type<string[]>()
      .default(sql`'[]'`),
    /** Overrides for the §8 opportunity-score weights. */
    scoreWeights: jsonb("score_weights").$type<Record<string, number>>(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index("channel_settings_user_id_idx").on(t.userId)],
);

/** §28 — brand kit consumed by the video generator and thumbnail engine. */
export const brandKits = pgTable(
  "brand_kits",
  {
    channelId: uuid("channel_id")
      .primaryKey()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    brandName: varchar("brand_name", { length: 120 }),
    logoAssetId: uuid("logo_asset_id"),
    primaryColor: varchar("primary_color", { length: 9 }),
    secondaryColor: varchar("secondary_color", { length: 9 }),
    fontPreference: varchar("font_preference", { length: 80 }),
    introAssetId: uuid("intro_asset_id"),
    outroAssetId: uuid("outro_asset_id"),
    defaultCta: text("default_cta"),
    captionStyle: jsonb("caption_style").$type<Record<string, unknown>>(),
    thumbnailStyle: jsonb("thumbnail_style").$type<Record<string, unknown>>(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index("brand_kits_user_id_idx").on(t.userId)],
);

/** §18, §19 — publishing cadence and automation rules, per channel. */
export const automationSettings = pgTable(
  "automation_settings",
  {
    channelId: uuid("channel_id")
      .primaryKey()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    level: automationLevelEnum("level").notNull().default("manual"),
    /** 0 = Sunday … 6 = Saturday. */
    publishDays: jsonb("publish_days")
      .notNull()
      .$type<number[]>()
      .default(sql`'[1,3,5]'`),
    /** `HH:MM` in the channel timezone. */
    publishTimes: jsonb("publish_times")
      .notNull()
      .$type<string[]>()
      .default(sql`'["18:00"]'`),
    timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),
    videosPerWeek: integer("videos_per_week").notNull().default(3),
    /** Requires the plan's autoPublish feature; re-checked at publish time. */
    autoPublish: boolean("auto_publish").notNull().default(false),
    requireApproval: boolean("require_approval").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("automation_settings_user_id_idx").on(t.userId),
    index("automation_settings_next_run_idx").on(t.enabled, t.nextRunAt),
  ],
);

// ---------------------------------------------------------------------------
// Research (§7, §8)
// ---------------------------------------------------------------------------

export const researchRuns = pgTable(
  "research_runs",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Nullable since Phase 11 (§4).
     *
     * A run seeded by a pasted YouTube link belongs to a user, not to a channel —
     * §4 requires that researching a link needs no connected channel at all. Every
     * channel-mode run still sets it, and every query that reads a channel's runs
     * still filters on it, so nothing about Phases 1-10 changes. The column was
     * `NOT NULL`, which made channel-coupling a constraint rather than a
     * convention; dropping the constraint is what makes link mode expressible.
     */
    channelId: uuid("channel_id").references(() => channels.id, {
      onDelete: "cascade",
    }),
    status: jobStatusEnum("status").notNull().default("queued"),
    /**
     * `manual` | `automation` | `youtube_link` | `description` — who or what asked
     * for this run.
     */
    trigger: varchar("trigger", { length: 32 }).notNull().default("manual"),
    /**
     * What the user said they wanted to make a video about (§1C).
     *
     * The third entry path's seed, and the counterpart of `sourceVideoId`: one run
     * is seeded by somebody else's video, the other by the user's own sentence. Held
     * here rather than on `projects` because it is research input — the worker reads
     * it to derive the niche and the search probes, and the angle prompt is shown it
     * so the proposals answer what was actually asked for.
     *
     * Stored verbatim, and never treated as instructions. It is the user's own prose,
     * so unlike a source video's metadata there is nothing here that must not be
     * reused — but it does reach a model, so `interpretDescription` frames it as the
     * subject to serve rather than as direction to follow, and the length is bounded
     * at the route.
     */
    description: text("description"),
    /**
     * The pasted video this run was seeded from (Phase 11 §4, §6).
     *
     * A research *source*, never a template: §22 makes the source video reference
     * material and nothing else. Stored so the analysis screen can show what was
     * pasted and so a repeat paste is recognisable, not so anything can be copied
     * from it.
     */
    sourceVideoId: varchar("source_video_id", { length: 32 }),
    /**
     * What the source video turned out to be about (§5).
     *
     * Denormalised from the analysis so the trend stage and the angle stage can
     * read the seed topic without re-fetching from YouTube — and so a run whose
     * source has since been deleted from YouTube still explains itself.
     */
    sourceTitle: text("source_title"),
    sourceChannelTitle: varchar("source_channel_title", { length: 200 }),
    /** Full §5 analysis, exactly as the provider returned it, minus nothing. */
    sourceAnalysis: jsonb("source_analysis").$type<Record<string, unknown>>(),
    niche: varchar("niche", { length: 160 }),
    keywords: jsonb("keywords")
      .notNull()
      .$type<string[]>()
      .default(sql`'[]'`),
    /** Which signal sources actually responded, for provenance (§29). */
    sources: jsonb("sources")
      .notNull()
      .$type<string[]>()
      .default(sql`'[]'`),
    /** Aggregate search-demand series rendered by the Research chart. */
    demandSeries: jsonb("demand_series").$type<
      Array<{ label: string; value: number }>
    >(),
    error: text("error"),
    /**
     * The `AppError` code behind `error`, when there was one.
     *
     * `status` alone is not enough to explain a stopped run: `blocked_not_configured`
     * covers both a missing API key and a provider account with no credit, and the
     * two need different words on screen. The UI branches on this rather than
     * pattern-matching the message, which is prose and will be reworded.
     */
    errorCode: varchar("error_code", { length: 64 }),
    /**
     * The project this run was performed *for*, when it was performed for one (§18).
     *
     * Nullable, and the direction of the link is deliberate. Both existing entry
     * paths research *before* a project exists — trending ideas produce an `ideas`
     * row that a project is later created from, and a pasted link produces a run that
     * seeds one — so `projects.ideaId` covers those and this stays null.
     *
     * The description path (§1C) inverts that: the user has already described the
     * video, so the project is the thing that exists first and the research is done
     * to inform it. Without this column that research would either have to invent a
     * synthetic `ideas` row to hang itself from, or be unattributable, and the second
     * means a project's page cannot show what was researched for it.
     *
     * `set null` rather than `cascade`: deleting a project should not delete the
     * research, which is reusable and cost provider calls to gather.
     */
    projectId: uuid("project_id").references((): AnyPgColumn => projects.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("research_runs_channel_created_idx").on(t.channelId, t.createdAt),
    index("research_runs_user_id_idx").on(t.userId),
    index("research_runs_project_idx").on(t.projectId),
  ],
);

/** Raw observed signals — the source videos behind an opportunity. */
export const researchResults = pgTable(
  "research_results",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Nullable since Phase 11 — a link-mode run has no channel (§4). */
    channelId: uuid("channel_id").references(() => channels.id, {
      onDelete: "cascade",
    }),
    source: varchar("source", { length: 48 }).notNull(),
    youtubeVideoId: varchar("youtube_video_id", { length: 32 }),
    youtubeChannelId: varchar("youtube_channel_id", { length: 64 }),
    channelTitle: varchar("channel_title", { length: 200 }),
    title: text("title").notNull(),
    /** Canonical watch URL — kept so the UI can link to the source video. */
    url: text("url"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    viewCount: numeric("view_count", { precision: 20, scale: 0 }),
    likeCount: integer("like_count"),
    commentCount: integer("comment_count"),
    /** Views per hour since publication — the velocity signal (§7). */
    viewsPerHour: real("views_per_hour"),
    engagementRate: real("engagement_rate"),
    /** Extracted topic cluster this video belongs to. */
    topic: varchar("topic", { length: 200 }),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("research_results_run_idx").on(t.runId),
    index("research_results_channel_idx").on(t.channelId),
    index("research_results_video_idx").on(t.youtubeVideoId),
  ],
);

/** A Vidxir AI-generated original angle derived from research signals (§7). */
export const ideas = pgTable(
  "ideas",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Nullable since Phase 11 — a link-mode idea has no channel (§4, §7). */
    channelId: uuid("channel_id").references(() => channels.id, {
      onDelete: "cascade",
    }),
    runId: uuid("run_id").references(() => researchRuns.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    angle: text("angle"),
    rationale: text("rationale"),
    /**
     * The opening line the video leads with (Phase 11 §7).
     *
     * §7 asks each proposal to carry a title *and* a hook. Before Phase 11 the
     * hook was written during scripting, which meant a user chose an angle without
     * seeing how it would open — the part that decides whether the video is
     * watched. Nullable: a channel-mode idea from Phases 1-10 has none, and that is
     * not a defect.
     */
    hook: text("hook"),
    /**
     * Which research signal supports this angle (§7).
     *
     * One sentence naming the observed evidence, so "why this angle" is answerable
     * from the row rather than from a scoring number. Distinct from `rationale`,
     * which argues the creative case.
     */
    trendSignal: text("trend_signal"),
    /** The underlying topic opportunity, not a copy of a source title (§7). */
    topic: varchar("topic", { length: 200 }),
    targetKeywords: jsonb("target_keywords")
      .notNull()
      .$type<string[]>()
      .default(sql`'[]'`),
    /** Research result ids this idea was derived from — provenance for §29. */
    sourceResultIds: jsonb("source_result_ids")
      .notNull()
      .$type<string[]>()
      .default(sql`'[]'`),

    // §8 component scores, 0-100. Vidxir AI-generated, not YouTube metrics.
    trendScore: real("trend_score"),
    opportunityScore: real("opportunity_score"),
    competitionScore: real("competition_score"),
    audienceFitScore: real("audience_fit_score"),
    velocityScore: real("velocity_score"),
    freshnessScore: real("freshness_score"),
    /** Weighted composite — the "Vidxir AI Opportunity Score". */
    vidxirScore: real("vidxir_score"),
    /** The weights used, so a historical score stays explainable. */
    scoreBreakdown: jsonb("score_breakdown").$type<Record<string, number>>(),

    /** `new` | `saved` | `rejected` | `used`. */
    state: varchar("state", { length: 16 }).notNull().default("new"),
    generatedBy: varchar("generated_by", { length: 48 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("ideas_channel_state_idx").on(t.channelId, t.state),
    index("ideas_user_id_idx").on(t.userId),
    index("ideas_score_idx").on(t.channelId, t.vidxirScore),
  ],
);

// ---------------------------------------------------------------------------
// Projects — one video in production (§20, §45)
// ---------------------------------------------------------------------------

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Nullable since Phase 11 (§4).
     *
     * A project created from a pasted link has no channel until the user connects
     * one. Research, scripting, generation and preview all work without it;
     * publishing does not, and the publish guard refuses a channel-less project
     * explicitly rather than relying on this column having been non-null.
     */
    channelId: uuid("channel_id").references(() => channels.id, {
      onDelete: "cascade",
    }),
    ideaId: uuid("idea_id").references(() => ideas.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    status: projectStatusEnum("status").notNull().default("IDEA"),
    /** Stage the project is currently working on, for the §38 status display. */
    currentStage: pipelineStageEnum("current_stage"),
    /** 0-100 overall progress, derived from completed stages — never faked. */
    progress: integer("progress").notNull().default(0),

    /** Failure bookkeeping (§20, §30). */
    failedStage: pipelineStageEnum("failed_stage"),
    errorMessage: text("error_message"),
    errorCode: varchar("error_code", { length: 64 }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    retryCount: integer("retry_count").notNull().default(0),

    /** `manual` | `automation` | `youtube_link` | `description`. */
    origin: varchar("origin", { length: 32 }).notNull().default("manual"),
    /** Correlation id shared by every log line and job for this project (§41). */
    traceId: varchar("trace_id", { length: 64 }),

    targetDurationSeconds: integer("target_duration_seconds"),

    /**
     * How this project's visuals are produced (Phase 11 §9).
     *
     * `STOCK` or `AI_VIDEO`. Nullable rather than defaulted so an existing project
     * reads as "never chose", which `generationModeOf()` resolves to `STOCK` — the
     * behaviour it actually rendered with. A default of `'STOCK'` would be almost
     * the same thing and would lose the distinction between a user who picked stock
     * and a row that predates the choice.
     */
    generationMode: varchar("generation_mode", { length: 16 }),
    /**
     * The AI model selected, e.g. `veo/3.1` (§10).
     *
     * Only meaningful when `generationMode` is `AI_VIDEO`. Re-validated against the
     * server's current catalogue on every use, never trusted because it was
     * accepted once: a provider can be switched off between choosing and rendering.
     */
    generationModel: varchar("generation_model", { length: 64 }),
    /**
     * Output frame: `landscape` | `portrait` | `square` (§16).
     *
     * Null means landscape, which is what every pre-Phase-11 render produced.
     */
    videoFormat: varchar("video_format", { length: 16 }),
    /**
     * Output resolution tier: `draft` | `720p` | `1080p` | `2k` (Phase 12 §4).
     *
     * Only meaningful when `generationMode` is `AI_VIDEO`. Null means "never chose",
     * which the plan layer resolves to the selected model's own default — so a
     * project created before this column existed still renders, and at the tier the
     * model recommends rather than at whatever a default constant happened to say.
     *
     * Stored per project rather than per render because §12 quotes a credit price
     * from it before the user commits, and the quote and the render must read the
     * same number. Re-checked against the model on every use (`assertQuality`), never
     * trusted because it was accepted once: a model's supported set can change.
     */
    videoQuality: varchar("video_quality", { length: 16 }),

    /**
     * The pasted YouTube video this project was seeded from (§4, §22).
     *
     * A provenance record, not an input to generation. Nothing reads this to copy
     * from — the script is written from the research findings and the chosen angle.
     * Kept so a project can be traced back to what prompted it.
     */
    sourceVideoId: varchar("source_video_id", { length: 32 }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("projects_user_status_idx").on(t.userId, t.status),
    index("projects_channel_created_idx").on(t.channelId, t.createdAt),
  ],
);

/** Append-only audit of §20 transitions. Makes stuck states diagnosable. */
export const projectEvents = pgTable(
  "project_events",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fromStatus: projectStatusEnum("from_status"),
    toStatus: projectStatusEnum("to_status").notNull(),
    stage: pipelineStageEnum("stage"),
    message: text("message"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index("project_events_project_idx").on(t.projectId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Scripts (§9)
// ---------------------------------------------------------------------------

export const scripts = pgTable(
  "scripts",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Points at the currently active version. */
    activeVersionId: uuid("active_version_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex("scripts_project_key").on(t.projectId),
    index("scripts_user_id_idx").on(t.userId),
  ],
);

export const scriptVersions = pgTable(
  "script_versions",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    scriptId: uuid("script_id")
      .notNull()
      .references(() => scripts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 1-based; displayed as "SCRIPT v1.0" in the UI. */
    version: integer("version").notNull(),
    title: text("title").notNull(),
    /** Alternative titles offered by the generator. */
    titleIdeas: jsonb("title_ideas")
      .notNull()
      .$type<string[]>()
      .default(sql`'[]'`),
    hook: text("hook").notNull(),
    introduction: text("introduction"),
    /** Ordered body sections: {heading, body, talkingPoints[], transition}. */
    sections: jsonb("sections")
      .notNull()
      .$type<
        Array<{
          heading: string;
          body: string;
          talkingPoints?: string[];
          transition?: string;
        }>
      >()
      .default(sql`'[]'`),
    conclusion: text("conclusion"),
    cta: text("cta"),
    storyStructure: text("story_structure"),
    /** Factual references the model was asked to ground claims in (§29). */
    references: jsonb("references")
      .notNull()
      .$type<Array<{ label: string; url?: string }>>()
      .default(sql`'[]'`),
    estimatedDurationSeconds: integer("estimated_duration_seconds"),
    wordCount: integer("word_count"),
    /** `ai` | `user_edit` — an edited version is still a version. */
    source: varchar("source", { length: 16 }).notNull().default("ai"),
    provider: varchar("provider", { length: 48 }),
    model: varchar("model", { length: 64 }),
    promptTokens: integer("prompt_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex("script_versions_script_version_key").on(t.scriptId, t.version),
    index("script_versions_user_id_idx").on(t.userId),
  ],
);

/** §10 shot/scene plan — one row per scene, drives visuals and the timeline. */
export const scenes = pgTable(
  "scenes",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scriptVersionId: uuid("script_version_id").references(
      () => scriptVersions.id,
      { onDelete: "set null" },
    ),
    /** 0-based ordering. */
    index: integer("index").notNull(),
    /** Storyboard label — Hook / Problem / Solution / Results / CTA. */
    label: varchar("label", { length: 80 }),
    narration: text("narration").notNull(),
    /** Visual direction for stock search or generation. */
    visualPrompt: text("visual_prompt"),
    /** Stock search terms derived from the visual prompt. */
    searchTerms: jsonb("search_terms")
      .notNull()
      .$type<string[]>()
      .default(sql`'[]'`),
    onScreenText: text("on_screen_text"),
    startMs: integer("start_ms"),
    durationMs: integer("duration_ms"),
    transition: varchar("transition", { length: 32 }),
    /** Chosen visual for this scene. */
    visualAssetId: uuid("visual_asset_id"),
    /**
     * Continuity commitments for this scene — `SceneState` from
     * `lib/continuity/scene-state`.
     *
     * On the scene row rather than in a table of its own: a scene state is
     * one-to-one with a scene, keyed by the same `(project, index)` the planner,
     * timeline and `EditClip.sceneIndex` already agree on. A parallel table would
     * be a second scene ordering to keep in step. Null for every project built
     * before the continuity layer, and for every project it does not apply to.
     */
    continuityState: jsonb("continuity_state"),
    /**
     * The continuity block appended to this scene's prompt, as sent.
     *
     * Stored because the validator checks the prompt that was *used*, and because
     * a regeneration has to reproduce the same constraints. Recomputing it would
     * check the current bible against itself rather than against what the
     * provider received.
     */
    continuityPrompt: text("continuity_prompt"),
    /**
     * How many times continuity has regenerated this scene.
     *
     * The stop condition. A scene that fails, is regenerated and fails again is
     * not going to be fixed by a third paid attempt, so the count is a ceiling
     * rather than a statistic.
     */
    continuityRegenerations: integer("continuity_regenerations")
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex("scenes_project_index_key").on(t.projectId, t.index),
    index("scenes_user_id_idx").on(t.userId),
  ],
);

/**
 * Story bible — the continuity contract for one project.
 *
 * One row per project, like `project_edits` and for the same reason: there is one
 * answer, and a unique index on `project_id` makes a second one impossible rather
 * than merely unlikely. The document is `StoryBible` from `lib/continuity/bible`,
 * validated on the way in and out; `level` is the resolved `ContinuityLevel`,
 * denormalised onto the row so the studio screen can say what a project is holding
 * without parsing the blob.
 *
 * `editedByUser` follows the `video_metadata` precedent — once a human has touched
 * the bible, a rebuild must not silently overwrite their casting.
 */
export const storyBibles = pgTable(
  "story_bibles",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    schemaVersion: integer("schema_version").notNull().default(1),
    /** Resolved `ContinuityLevel`: off | style | world | character | episodic. */
    level: varchar("level", { length: 16 }).notNull().default("off"),
    document: jsonb("document").notNull(),
    generatedBy: varchar("generated_by", { length: 48 }),
    editedByUser: boolean("edited_by_user").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex("story_bibles_project_key").on(t.projectId),
    index("story_bibles_user_id_idx").on(t.userId),
  ],
);

// ---------------------------------------------------------------------------
// Media assets (§12, §13, §22, §29)
// ---------------------------------------------------------------------------

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    channelId: uuid("channel_id").references(() => channels.id, {
      onDelete: "cascade",
    }),
    kind: assetKindEnum("kind").notNull(),
    /** Object storage key. The bytes never live in Postgres (§22). */
    storageKey: text("storage_key"),
    mimeType: varchar("mime_type", { length: 128 }),
    bytes: integer("bytes"),
    width: integer("width"),
    height: integer("height"),
    durationMs: integer("duration_ms"),
    checksumSha256: varchar("checksum_sha256", { length: 64 }),

    /** Provenance and licensing — required by §29, never dropped. */
    provider: varchar("provider", { length: 48 }),
    providerAssetId: varchar("provider_asset_id", { length: 128 }),
    sourceUrl: text("source_url"),
    license: varchar("license", { length: 120 }),
    attribution: text("attribution"),
    authorName: varchar("author_name", { length: 200 }),

    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("assets_project_kind_idx").on(t.projectId, t.kind),
    index("assets_user_id_idx").on(t.userId),
  ],
);

export const voiceovers = pgTable(
  "voiceovers",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    provider: varchar("provider", { length: 48 }).notNull(),
    voiceId: varchar("voice_id", { length: 128 }),
    voiceName: varchar("voice_name", { length: 120 }),
    language: varchar("language", { length: 16 }),
    speed: real("speed"),
    style: varchar("style", { length: 64 }),
    durationMs: integer("duration_ms"),
    /**
     * Per-scene audio offsets, so the timeline can align narration.
     *
     * `voiceId` and `characterId` are optional and additive: they record the voice
     * each scene was *actually* narrated in, which is what lets the continuity check
     * compare produced audio against the story bible instead of comparing the bible
     * with itself. Absent on every row written before character voices existed, and
     * on every project that does not use them — the row-level `voice_id` above is the
     * whole answer for those.
     *
     * A widening of the jsonb `$type` only. No column changes, so no migration: the
     * offsets every existing consumer reads are untouched.
     */
    segments: jsonb("segments").$type<
      Array<{
        sceneIndex: number;
        startMs: number;
        durationMs: number;
        voiceId?: string | null;
        characterId?: string | null;
      }>
    >(),
    charactersBilled: integer("characters_billed"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("voiceovers_project_idx").on(t.projectId),
    index("voiceovers_user_id_idx").on(t.userId),
  ],
);

export const musicTracks = pgTable(
  "music_tracks",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    role: varchar("role", { length: 16 }).notNull().default("background"),
    mood: varchar("mood", { length: 64 }),
    bpm: integer("bpm"),
    /** Linear gain 0-1. Kept low so narration stays intelligible (§13). */
    volume: real("volume").notNull().default(0.14),
    duckUnderNarration: boolean("duck_under_narration").notNull().default(true),
    startMs: integer("start_ms").notNull().default(0),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("music_tracks_project_idx").on(t.projectId),
    index("music_tracks_user_id_idx").on(t.userId),
  ],
);

export const captions = pgTable(
  "captions",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    language: varchar("language", { length: 16 }).notNull().default("en"),
    provider: varchar("provider", { length: 48 }),
    /** Word/phrase level cues with timestamps (§14). */
    cues: jsonb("cues")
      .notNull()
      .$type<Array<{ startMs: number; endMs: number; text: string }>>()
      .default(sql`'[]'`),
    srtAssetId: uuid("srt_asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    vttAssetId: uuid("vtt_asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    burnedIn: boolean("burned_in").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("captions_project_idx").on(t.projectId),
    index("captions_user_id_idx").on(t.userId),
  ],
);

// ---------------------------------------------------------------------------
// Manual editing
// ---------------------------------------------------------------------------

/**
 * The user's cut, as a track/clip document.
 *
 * One row per project, holding the whole edit as `jsonb` rather than a table of
 * clips. The reasons for a document over rows:
 *
 *  - **Autosave is one write.** The editor saves on every meaningful change; a
 *    normalised model would make each save a diff across two tables inside a
 *    transaction, and a partially-applied save is a corrupted cut.
 *  - **Undo/redo lives in the browser** and only the accepted state is persisted.
 *    Rows would tempt a server-side history that the client already has.
 *  - **The compiler is pure.** `compileEditDocument` takes this document and
 *    returns a `TimelineDocument` with no I/O, which is what lets the preview and
 *    the export share one code path.
 *
 * The trade-off accepted knowingly: Postgres cannot enforce the document's shape.
 * `EditDocumentSchema` is what does, on the way in, the same way
 * `brand_kits.caption_style` is validated by `pickStyle` on the way out.
 *
 * `scenes` remains the source of truth for the *narrative*; this is the source of
 * truth for the *cut*. A project with no row here has not been edited, and its
 * render is still assembled from the scene rows exactly as before.
 */
export const projectEdits = pgTable(
  "project_edits",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Optimistic-concurrency counter, incremented on every accepted save.
     *
     * Not a history: two tabs autosaving the same project would otherwise let the
     * slower one silently overwrite the faster one's cut. A save carries the
     * version it read and is rejected if it no longer matches.
     */
    version: integer("version").notNull().default(1),
    /** Shape version of `document`, so an older deploy's write is recognisable. */
    schemaVersion: integer("schema_version").notNull().default(1),
    /** The edit document. Validated by `EditDocumentSchema` before it lands here. */
    document: jsonb("document").notNull().$type<Record<string, unknown>>(),
    /**
     * Compiled length, denormalised for listings.
     *
     * Derived from the document by the compiler, never authored — it is here so a
     * project list can show a duration without compiling every cut.
     */
    durationMs: integer("duration_ms"),
    /** Set when this document was last exported, for "unsaved changes since render". */
    lastRenderedAt: timestamp("last_rendered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    // One cut per project. A second row would be a second answer to "what is this
    // video", and nothing in the editor needs one.
    uniqueIndex("project_edits_project_key").on(t.projectId),
    index("project_edits_user_id_idx").on(t.userId),
  ],
);

// ---------------------------------------------------------------------------
// Rendering & thumbnails (§15, §16)
// ---------------------------------------------------------------------------

export const renders = pgTable(
  "renders",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 48 }).notNull(),
    /** Provider-side render id, used for polling and cancellation. */
    providerRenderId: varchar("provider_render_id", { length: 128 }),
    status: jobStatusEnum("status").notNull().default("queued"),
    /** Real provider-reported progress. Never synthesised (§37, §42). */
    progress: integer("progress").notNull().default(0),
    /** The timeline document submitted to the render provider. */
    timeline: jsonb("timeline").$type<Record<string, unknown>>(),
    width: integer("width").notNull().default(1920),
    height: integer("height").notNull().default(1080),
    fps: integer("fps").notNull().default(30),
    durationMs: integer("duration_ms"),
    outputAssetId: uuid("output_asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    /** Frame extracted for thumbnail generation. */
    posterAssetId: uuid("poster_asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    error: text("error"),
    attempt: integer("attempt").notNull().default(1),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("renders_project_idx").on(t.projectId, t.createdAt),
    index("renders_user_id_idx").on(t.userId),
    index("renders_provider_render_idx").on(t.providerRenderId),
  ],
);

export const thumbnails = pgTable(
  "thumbnails",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: jobStatusEnum("status").notNull().default("queued"),
    selectedVariantId: uuid("selected_variant_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("thumbnails_project_idx").on(t.projectId),
    index("thumbnails_user_id_idx").on(t.userId),
  ],
);

export const thumbnailVariants = pgTable(
  "thumbnail_variants",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    thumbnailId: uuid("thumbnail_id")
      .notNull()
      .references(() => thumbnails.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 0-3 — the prototype's four-variation workflow is preserved. */
    index: integer("index").notNull(),
    /** Overlay text, kept short for readability at small sizes (§16). */
    headline: varchar("headline", { length: 80 }).notNull(),
    subline: varchar("subline", { length: 120 }),
    /** The concept the generator was working to: curiosity, contrast, emotion. */
    concept: text("concept"),
    emotion: varchar("emotion", { length: 48 }),
    backgroundAssetId: uuid("background_asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    /** Composited image. Absent until rendering succeeds. */
    imageAssetId: uuid("image_asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    /** A/B test performance, populated from analytics (§16). */
    impressions: integer("impressions"),
    clicks: integer("clicks"),
    ctr: real("ctr"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex("thumbnail_variants_thumb_index_key").on(
      t.thumbnailId,
      t.index,
    ),
    index("thumbnail_variants_user_id_idx").on(t.userId),
  ],
);

// ---------------------------------------------------------------------------
// Metadata, publishing & analytics (§17, §18, §26)
// ---------------------------------------------------------------------------

export const videoMetadata = pgTable(
  "video_metadata",
  {
    projectId: uuid("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 100 }).notNull(),
    description: text("description").notNull().default(""),
    tags: jsonb("tags")
      .notNull()
      .$type<string[]>()
      .default(sql`'[]'`),
    hashtags: jsonb("hashtags")
      .notNull()
      .$type<string[]>()
      .default(sql`'[]'`),
    chapters: jsonb("chapters")
      .notNull()
      .$type<Array<{ startMs: number; label: string }>>()
      .default(sql`'[]'`),
    /** YouTube category id — 28 = Science & Technology. */
    categoryId: varchar("category_id", { length: 8 }).notNull().default("28"),
    defaultLanguage: varchar("default_language", { length: 16 }),
    madeForKids: boolean("made_for_kids").notNull().default(false),
    /** True once a human edited it — regeneration must not clobber edits. */
    editedByUser: boolean("edited_by_user").notNull().default(false),
    generatedBy: varchar("generated_by", { length: 48 }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index("video_metadata_user_id_idx").on(t.userId)],
);

/** §29 pre-publish gate. A project cannot publish while checks are failing. */
export const qualityChecks = pgTable(
  "quality_checks",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `pass` | `warn` | `fail`. */
    verdict: varchar("verdict", { length: 8 }).notNull(),
    findings: jsonb("findings")
      .notNull()
      .$type<
        Array<{
          code: string;
          severity: "info" | "warn" | "fail";
          message: string;
          detail?: string;
        }>
      >()
      .default(sql`'[]'`),
    /** Licence/attribution roll-up for every asset used in the render. */
    assetLicenses: jsonb("asset_licenses")
      .notNull()
      .$type<
        Array<{
          assetId: string;
          provider?: string;
          license?: string;
          sourceUrl?: string;
        }>
      >()
      .default(sql`'[]'`),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("quality_checks_project_idx").on(t.projectId, t.createdAt),
    index("quality_checks_user_id_idx").on(t.userId),
  ],
);

export const publishJobs = pgTable(
  "publish_jobs",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    status: publishJobStatusEnum("status").notNull().default("queued"),
    visibility: publishVisibilityEnum("visibility").notNull().default("public"),
    /** Null = publish as soon as the worker picks it up. */
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    /** True when a human (or an autopilot policy) approved publication. */
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /** Resumable-upload progress reported by the YouTube client. */
    uploadProgress: integer("upload_progress").notNull().default(0),
    attempt: integer("attempt").notNull().default(0),
    error: text("error"),
    errorCode: varchar("error_code", { length: 64 }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("publish_jobs_status_sched_idx").on(t.status, t.scheduledFor),
    index("publish_jobs_project_idx").on(t.projectId),
    index("publish_jobs_user_id_idx").on(t.userId),
  ],
);

/**
 * Written only after YouTube confirms the upload (§42). The presence of a row
 * here — not a frontend flag — is what makes a project "Published".
 */
export const publishedVideos = pgTable(
  "published_videos",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    publishJobId: uuid("publish_job_id").references(() => publishJobs.id, {
      onDelete: "set null",
    }),
    youtubeVideoId: varchar("youtube_video_id", { length: 32 }).notNull(),
    url: text("url").notNull(),
    /** YouTube's own upload/processing status, mirrored verbatim. */
    uploadStatus: varchar("upload_status", { length: 32 }),
    privacyStatus: varchar("privacy_status", { length: 16 }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    scheduledPublishAt: timestamp("scheduled_publish_at", {
      withTimezone: true,
    }),
    thumbnailVariantId: uuid("thumbnail_variant_id").references(
      () => thumbnailVariants.id,
      { onDelete: "set null" },
    ),
    titleUsed: text("title_used"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex("published_videos_youtube_id_key").on(t.youtubeVideoId),
    index("published_videos_channel_idx").on(t.channelId, t.publishedAt),
    index("published_videos_user_id_idx").on(t.userId),
  ],
);

/** Time-series performance snapshots pulled from YouTube Analytics (§26). */
export const analyticsSnapshots = pgTable(
  "analytics_snapshots",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    publishedVideoId: uuid("published_video_id").references(
      () => publishedVideos.id,
      { onDelete: "cascade" },
    ),
    /** UTC date this snapshot describes. */
    date: timestamp("date", { withTimezone: true }).notNull(),
    views: integer("views"),
    likes: integer("likes"),
    comments: integer("comments"),
    shares: integer("shares"),
    subscribersGained: integer("subscribers_gained"),
    subscribersLost: integer("subscribers_lost"),
    impressions: integer("impressions"),
    /**
     * Click-through rate as a fraction, 0-1.
     *
     * `numeric` rather than `real` (Phase 9): a float cannot round-trip a rate
     * exactly, so a stored 0.0 could read back as 4e-17 and a CTR comparison
     * between two variants would depend on binary rounding rather than on the
     * measurement. Null still means "not measured" — see `ctrSource`.
     */
    ctr: numeric("ctr", { precision: 9, scale: 6 }),
    /**
     * How `ctr`/`impressions` were obtained, so the UI can tell a measured zero
     * from an absent measurement (§6).
     *
     * `null` — nothing was measured. `provider_unsupported` — YouTube Analytics
     * v2 was queried and does not expose impression CTR at all (the normal case;
     * it lives only in Studio). `provider` — the provider returned a real value.
     * `derived_views_impressions` — computed from impressions and views that the
     * provider did return. Never a guess (§42).
     */
    ctrSource: analyticsMetricSourceEnum("ctr_source"),
    watchTimeMinutes: real("watch_time_minutes"),
    averageViewDurationSeconds: real("average_view_duration_seconds"),
    averageViewPercentage: real("average_view_percentage"),
    /**
     * Kept for the rows written before Phase 9 and for callers that want a
     * rounded minor-unit figure. `estimatedRevenue` is authoritative: cents
     * cannot represent a three-decimal YouTube payout, and summing rounded cents
     * over a month drifts from the real total.
     */
    estimatedRevenueCents: integer("estimated_revenue_cents"),
    /**
     * Exact estimated revenue in `revenueCurrency` (§7). `numeric`, never a
     * float — a float total is not reproducible and this figure is money.
     */
    estimatedRevenue: numeric("estimated_revenue", { precision: 18, scale: 6 }),
    /** ISO-4217 for `estimatedRevenue`. Preserved, never converted (§7). */
    revenueCurrency: char("revenue_currency", { length: 3 }),
    /**
     * Why revenue is or is not present. `null` means no revenue attempt was
     * made for this row at all; the explicit states are what stop a missing
     * payout from rendering as $0.00 (§6, §7).
     */
    revenueState: revenueStateEnum("revenue_state"),
    /**
     * True once YouTube stops revising the figure. Until then it is an estimate
     * and the UI must say so (§7). Null = unknown, which is treated as estimated.
     */
    revenueFinal: boolean("revenue_final"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    /**
     * Video-level uniqueness. Partial, because the unconditional three-column
     * index it replaces did not constrain channel-level rows at all: Postgres
     * treats NULLs as distinct, so `(channel, NULL, date)` could be inserted
     * without limit and `ON CONFLICT` could never match it.
     */
    uniqueIndex("analytics_snapshots_video_date_key")
      .on(t.channelId, t.publishedVideoId, t.date)
      .where(sql`${t.publishedVideoId} is not null`),
    /**
     * Channel-level uniqueness, which is the half that was missing. With this
     * index a re-pull upserts instead of duplicating, so the ingest no longer
     * needs its delete-then-insert window — a read-then-write race §5 forbids.
     */
    uniqueIndex("analytics_snapshots_channel_date_key")
      .on(t.channelId, t.date)
      .where(sql`${t.publishedVideoId} is null`),
    index("analytics_snapshots_user_id_idx").on(t.userId),
    /** The dashboard's read shape: one channel, one date range, in order. */
    index("analytics_snapshots_channel_date_idx").on(t.channelId, t.date),
  ],
);

// ---------------------------------------------------------------------------
// Thumbnail A/B testing (§8, §9, §10 of Phase 9)
// ---------------------------------------------------------------------------

/**
 * One thumbnail A/B test over an already-published video.
 *
 * Deliberately *not* a second thumbnail pipeline: the arms reference
 * `thumbnail_variants` rows that Phase 6a already generated. An experiment
 * decides which of those existing images is shown and records what happened.
 *
 * Scoped to a `published_videos` row rather than a project, because there is
 * nothing to measure until YouTube has confirmed a publication (§42).
 */
export const thumbnailExperiments = pgTable(
  "thumbnail_experiments",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    publishedVideoId: uuid("published_video_id")
      .notNull()
      .references(() => publishedVideos.id, { onDelete: "cascade" }),
    status: experimentStatusEnum("status").notNull().default("draft"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /**
     * The arm the winner call selected, set only when `status` is `completed`
     * and the decision was `winner`. A null here with a completed status means
     * the test ended without one, which is a real outcome (§10).
     *
     * The lambda defers resolution because `thumbnailExperimentArms` is declared
     * below and references this table in turn — the cycle has to be broken on one
     * side. `set null` rather than `cascade`: losing the arm row must not delete
     * the experiment's history.
     */
    winningArmId: uuid("winning_arm_id").references(
      (): AnyPgColumn => thumbnailExperimentArms.id,
      { onDelete: "set null" },
    ),
    /** Why the test ended: `winner`, `no_winner`, `tie`, `stopped`, `expired`. */
    outcome: experimentOutcomeEnum("outcome"),
    /**
     * Frozen copy of the policy the decision was made under, so a later change
     * to the thresholds cannot retroactively rewrite what a past test concluded.
     */
    decisionPolicy: jsonb("decision_policy").$type<{
      minImpressionsPerArm: number;
      minObservationDays: number;
      minArms: number;
      minRelativeLift: number;
    }>(),
    /** The full decision record, including per-arm figures at decision time. */
    decision: jsonb("decision").$type<Record<string, unknown>>(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    /**
     * One live test per video. Partial, so a completed test does not block a
     * later one — and expressed in the database rather than as a check-then-insert,
     * which two concurrent requests would both pass (§5).
     */
    uniqueIndex("thumbnail_experiments_live_video_key")
      .on(t.publishedVideoId)
      .where(sql`${t.status} in ('draft', 'running')`),
    index("thumbnail_experiments_user_idx").on(t.userId),
    index("thumbnail_experiments_channel_status_idx").on(t.channelId, t.status),
  ],
);

/**
 * One arm of an experiment: a thumbnail variant under test.
 *
 * `impressions`/`clicks`/`views` are integers and nullable. Null means "no
 * observation has been recorded", which is not the same as a recorded zero, and
 * the winner policy treats them differently (§6, §10).
 */
export const thumbnailExperimentArms = pgTable(
  "thumbnail_experiment_arms",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => thumbnailExperiments.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The already-generated variant this arm shows. Never a new render. */
    thumbnailVariantId: uuid("thumbnail_variant_id")
      .notNull()
      .references(() => thumbnailVariants.id, { onDelete: "cascade" }),
    /** Stable ordinal, 0-based. Assignment is derived from this, not from a row id. */
    position: integer("position").notNull(),
    /**
     * The arm that was already live when the test started. Exactly one per
     * experiment, enforced by a partial unique index: without a control there is
     * nothing to compare against and §8 forbids silently replacing production.
     */
    isControl: boolean("is_control").notNull().default(false),
    impressions: integer("impressions"),
    clicks: integer("clicks"),
    views: integer("views"),
    /** Observed CTR as an exact fraction. Numeric for the same reason as above. */
    ctr: numeric("ctr", { precision: 9, scale: 6 }),
    /** How the arm's figures were obtained — see `analyticsMetricSourceEnum`. */
    metricsSource: analyticsMetricSourceEnum("metrics_source"),
    /** Distinct days this arm has a recorded observation for. */
    observationDays: integer("observation_days").notNull().default(0),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex("thumbnail_experiment_arms_position_key").on(
      t.experimentId,
      t.position,
    ),
    /** A variant cannot be two arms of the same test. */
    uniqueIndex("thumbnail_experiment_arms_variant_key").on(
      t.experimentId,
      t.thumbnailVariantId,
    ),
    uniqueIndex("thumbnail_experiment_arms_control_key")
      .on(t.experimentId)
      .where(sql`${t.isControl}`),
    index("thumbnail_experiment_arms_user_idx").on(t.userId),
  ],
);

/**
 * Per-arm, per-day observations — the append-only record the winner policy reads.
 *
 * Separate from the arm's running totals because a re-pull of a day must
 * *replace* that day rather than add to it. Totals are recomputed from these
 * rows, so a double ingest cannot inflate an arm's impressions (§5).
 */
export const thumbnailExperimentObservations = pgTable(
  "thumbnail_experiment_observations",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => thumbnailExperiments.id, { onDelete: "cascade" }),
    armId: uuid("arm_id")
      .notNull()
      .references(() => thumbnailExperimentArms.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** UTC date the observation covers, at midnight. */
    date: timestamp("date", { withTimezone: true }).notNull(),
    impressions: integer("impressions"),
    clicks: integer("clicks"),
    views: integer("views"),
    source: analyticsMetricSourceEnum("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    /** One row per arm per day — the upsert target that makes ingest idempotent. */
    uniqueIndex("thumbnail_experiment_observations_arm_date_key").on(
      t.armId,
      t.date,
    ),
    index("thumbnail_experiment_observations_experiment_idx").on(
      t.experimentId,
      t.date,
    ),
    index("thumbnail_experiment_observations_user_idx").on(t.userId),
  ],
);

// ---------------------------------------------------------------------------
// Jobs & provider usage (§31, §41)
// ---------------------------------------------------------------------------

/**
 * Durable mirror of every queued unit of work. BullMQ owns scheduling; this
 * table owns the user-visible truth, so status survives a Redis flush and the
 * UI can render real progress after a refresh (§10, §37).
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    channelId: uuid("channel_id").references(() => channels.id, {
      onDelete: "cascade",
    }),
    /** Queue name, e.g. `pipeline`, `publish`, `analytics`. */
    queue: varchar("queue", { length: 48 }).notNull(),
    /** Job type, e.g. `generate-script`. */
    name: varchar("name", { length: 64 }).notNull(),
    stage: pipelineStageEnum("stage"),
    status: jobStatusEnum("status").notNull().default("queued"),
    progress: integer("progress").notNull().default(0),
    /** Human-readable note shown beside the progress bar. */
    statusMessage: text("status_message"),
    priority: integer("priority").notNull().default(1),
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    /** BullMQ job id, for cancellation and correlation. */
    queueJobId: varchar("queue_job_id", { length: 128 }),
    traceId: varchar("trace_id", { length: 64 }),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    errorCode: varchar("error_code", { length: 64 }),
    /** Set when a provider is unconfigured — surfaced, never silently faked. */
    notConfiguredProvider: varchar("not_configured_provider", { length: 48 }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("jobs_project_stage_idx").on(t.projectId, t.stage),
    index("jobs_user_status_idx").on(t.userId, t.status),
    index("jobs_queue_job_idx").on(t.queueJobId),
    index("jobs_trace_idx").on(t.traceId),
  ],
);

/** Per-call provider accounting — cost control and rate-limit diagnosis. */
export const apiUsage = pgTable(
  "api_usage",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    provider: varchar("provider", { length: 48 }).notNull(),
    operation: varchar("operation", { length: 64 }).notNull(),
    model: varchar("model", { length: 64 }),
    /** Units are provider-specific: tokens, characters, seconds, credits. */
    quantity: integer("quantity"),
    unit: varchar("unit", { length: 24 }),
    estimatedCostCents: integer("estimated_cost_cents"),
    httpStatus: integer("http_status"),
    ok: boolean("ok").notNull().default(true),
    errorCode: varchar("error_code", { length: 64 }),
    durationMs: integer("duration_ms"),
    traceId: varchar("trace_id", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("api_usage_provider_created_idx").on(t.provider, t.createdAt),
    index("api_usage_user_created_idx").on(t.userId, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const usersRelations = relations(users, ({ many, one }) => ({
  sessions: many(sessions),
  channels: many(channels),
  projects: many(projects),
  subscription: one(subscriptions, {
    fields: [users.id],
    references: [subscriptions.userId],
  }),
  onboarding: one(onboardingProfiles, {
    fields: [users.id],
    references: [onboardingProfiles.userId],
  }),
  creditBalance: one(creditBalances, {
    fields: [users.id],
    references: [creditBalances.userId],
  }),
  creditLedger: many(creditLedger),
}));

export const creditBalancesRelations = relations(creditBalances, ({ one }) => ({
  user: one(users, { fields: [creditBalances.userId], references: [users.id] }),
}));

export const creditLedgerRelations = relations(creditLedger, ({ one }) => ({
  user: one(users, { fields: [creditLedger.userId], references: [users.id] }),
  project: one(projects, {
    fields: [creditLedger.projectId],
    references: [projects.id],
  }),
}));

export const creditPurchasesRelations = relations(creditPurchases, ({ one }) => ({
  user: one(users, { fields: [creditPurchases.userId], references: [users.id] }),
  ledgerEntry: one(creditLedger, {
    fields: [creditPurchases.ledgerId],
    references: [creditLedger.id],
  }),
}));

export const channelsRelations = relations(channels, ({ one, many }) => ({
  user: one(users, { fields: [channels.userId], references: [users.id] }),
  settings: one(channelSettings, {
    fields: [channels.id],
    references: [channelSettings.channelId],
  }),
  brandKit: one(brandKits, {
    fields: [channels.id],
    references: [brandKits.channelId],
  }),
  automation: one(automationSettings, {
    fields: [channels.id],
    references: [automationSettings.channelId],
  }),
  projects: many(projects),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  user: one(users, { fields: [projects.userId], references: [users.id] }),
  channel: one(channels, {
    fields: [projects.channelId],
    references: [channels.id],
  }),
  idea: one(ideas, { fields: [projects.ideaId], references: [ideas.id] }),
  script: one(scripts, {
    fields: [projects.id],
    references: [scripts.projectId],
  }),
  metadata: one(videoMetadata, {
    fields: [projects.id],
    references: [videoMetadata.projectId],
  }),
  scenes: many(scenes),
  renders: many(renders),
  jobs: many(jobs),
  events: many(projectEvents),
  edit: one(projectEdits, {
    fields: [projects.id],
    references: [projectEdits.projectId],
  }),
}));

export const scriptsRelations = relations(scripts, ({ one, many }) => ({
  project: one(projects, {
    fields: [scripts.projectId],
    references: [projects.id],
  }),
  versions: many(scriptVersions),
}));

export const scriptVersionsRelations = relations(scriptVersions, ({ one }) => ({
  script: one(scripts, {
    fields: [scriptVersions.scriptId],
    references: [scripts.id],
  }),
}));

export const thumbnailsRelations = relations(thumbnails, ({ one, many }) => ({
  project: one(projects, {
    fields: [thumbnails.projectId],
    references: [projects.id],
  }),
  variants: many(thumbnailVariants),
}));

export const publishJobsRelations = relations(publishJobs, ({ one }) => ({
  project: one(projects, {
    fields: [publishJobs.projectId],
    references: [projects.id],
  }),
  channel: one(channels, {
    fields: [publishJobs.channelId],
    references: [channels.id],
  }),
}));

export const thumbnailExperimentsRelations = relations(
  thumbnailExperiments,
  ({ one, many }) => ({
    publishedVideo: one(publishedVideos, {
      fields: [thumbnailExperiments.publishedVideoId],
      references: [publishedVideos.id],
    }),
    channel: one(channels, {
      fields: [thumbnailExperiments.channelId],
      references: [channels.id],
    }),
    arms: many(thumbnailExperimentArms),
  }),
);

export const thumbnailExperimentArmsRelations = relations(
  thumbnailExperimentArms,
  ({ one, many }) => ({
    experiment: one(thumbnailExperiments, {
      fields: [thumbnailExperimentArms.experimentId],
      references: [thumbnailExperiments.id],
    }),
    variant: one(thumbnailVariants, {
      fields: [thumbnailExperimentArms.thumbnailVariantId],
      references: [thumbnailVariants.id],
    }),
    observations: many(thumbnailExperimentObservations),
  }),
);

export const thumbnailExperimentObservationsRelations = relations(
  thumbnailExperimentObservations,
  ({ one }) => ({
    arm: one(thumbnailExperimentArms, {
      fields: [thumbnailExperimentObservations.armId],
      references: [thumbnailExperimentArms.id],
    }),
    experiment: one(thumbnailExperiments, {
      fields: [thumbnailExperimentObservations.experimentId],
      references: [thumbnailExperiments.id],
    }),
  }),
);
