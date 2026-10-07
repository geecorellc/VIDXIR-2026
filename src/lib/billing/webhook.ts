/**
 * The billing webhook — the only code in Vidxir AI that can change a plan tier (§24).
 *
 * Everything else in the billing path is a *request*: a checkout session is a
 * request to pay, a portal visit is a request to change something. This file
 * processes what the provider says actually happened, and it is the sole writer of
 * `subscriptions.tier`. §24 states the rule this enforces: "Never activate paid
 * features solely because the frontend says the user selected 'Studio'."
 *
 * Four properties, each of which corresponds to a way real webhooks go wrong:
 *
 *  1. **Signature first.** An unsigned or badly-signed body is rejected before it
 *     is parsed, let alone applied. Anyone can POST to a public webhook URL; the
 *     signature is the only thing separating Stripe from an attacker who would
 *     otherwise grant themselves Scale by curling one JSON object.
 *
 *  2. **Idempotent.** Stripe redelivers on any non-2xx and guarantees only
 *     at-least-once delivery. The unique index on `billing_events` makes a
 *     redelivery lose its insert, and a lost insert means the change is not applied
 *     twice.
 *
 *  3. **Order-independent.** Delivery order is explicitly not guaranteed. An older
 *     `customer.subscription.updated` arriving after a newer one would revert the
 *     tier, so events older than `subscriptions.lastEventAt` are recorded and
 *     skipped rather than applied.
 *
 *  4. **Tier from the price, not from metadata.** `vidxirTier` metadata is written
 *     at checkout and is only a hint; the authoritative tier is whichever
 *     configured price the subscription is actually on. If the two disagree —
 *     someone switched plans in the portal — the price wins, because that is what
 *     the customer is being charged for.
 *
 * A tier is only ever granted when the subscription's status says the customer is
 * genuinely entitled. `past_due`, `unpaid`, `canceled` and `incomplete` all resolve
 * to Starter through `currentTier`, so a failed payment really does remove access
 * (§24) without this file having to remember to downgrade.
 */
import Stripe from "stripe";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { billingEvents, subscriptions, users } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { ForbiddenError, NotConfiguredError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { isPlanTier, type PlanTier } from "@/lib/plans";
import { stripeClient, tierForPriceId } from "@/lib/billing/stripe";
import { ensureMonthlyGrant } from "@/lib/credits/service";
import { completeCreditPurchase } from "@/lib/credits/purchase";

const log = logger.child({ component: "billing-webhook", provider: "stripe" });

/**
 * Events Vidxir AI acts on. Anything else is recorded with `skipReason: "unhandled"`
 * and acknowledged — returning an error for an event we simply do not use would
 * make Stripe retry it forever and eventually disable the endpoint.
 */
const HANDLED = new Set([
  "checkout.session.completed",
  /**
   * Delayed payment methods (§11). A `mode: "payment"` session for a credit pack
   * completes *before* such a payment clears, so the session arrives `unpaid` and is
   * refused; these are the events that report the eventual outcome. Without them a
   * customer using one of those methods would be charged and never credited.
   */
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
  "invoice.payment_succeeded",
]);

export interface WebhookOutcome {
  eventId: string;
  eventType: string;
  applied: boolean;
  /**
   * Why nothing was applied, or null when something was.
   *
   * `duplicate`, `stale`, `unhandled`, `unknown_customer`, or — for a credit top-up —
   * `credit_not_paid`, `credit_already_credited`, `credit_unknown_pack`,
   * `credit_wrong_owner`. The `credit_` prefix exists so an operator reading
   * `billing_events` can tell a top-up that granted nothing from a subscription event
   * that did, without joining anything.
   */
  skipReason: string | null;
  userId: string | null;
  /** The tier after processing, when this event resolved one. */
  tier?: PlanTier;
  status?: string;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verify the signature and return the parsed event.
 *
 * Takes the **raw body string**, not a parsed object: Stripe signs the exact bytes
 * it sent, so `JSON.parse` followed by `JSON.stringify` would produce a different
 * payload and fail verification. The route reads `request.text()` for this reason.
 *
 * A verification failure is a `ForbiddenError` (403) rather than a 400, and
 * deliberately not retryable — Stripe does not retry 4xx, which is correct here:
 * a body that fails verification will never start verifying.
 */
export function verifyEvent(rawBody: string, signature: string | null): Stripe.Event {
  const secret = env().STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new NotConfiguredError(
      "Stripe",
      ["STRIPE_WEBHOOK_SECRET"],
      "Copy the signing secret from the webhook endpoint in the Stripe dashboard.",
    );
  }

  if (!signature) {
    throw new ForbiddenError("Missing Stripe signature header.");
  }

  try {
    /**
     * `constructEvent` checks the HMAC *and* the timestamp tolerance (5 minutes by
     * default), which is what stops a captured-and-replayed body from being
     * accepted days later.
     */
    return stripeClient().webhooks.constructEvent(rawBody, signature, secret);
  } catch (error) {
    // Never log the body or the signature: the body is the thing an attacker is
    // probing with, and echoing it into logs helps nobody.
    log.warn("webhook signature verification failed", {
      errorCode:
        error instanceof Stripe.errors.StripeError ? error.type : "unknown",
    });
    throw new ForbiddenError("Stripe signature verification failed.");
  }
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

/**
 * Apply a verified event. Must be called only with the output of `verifyEvent`.
 *
 * Returns an outcome rather than throwing for events it chooses not to apply: a
 * duplicate, a stale delivery and an unrecognised type are all *successful*
 * processing outcomes, and the route must return 2xx for them so Stripe stops
 * redelivering.
 */
export async function processEvent(event: Stripe.Event): Promise<WebhookOutcome> {
  const eventCreatedAt = new Date(event.created * 1000);
  const context = await resolveContext(event);

  /**
   * Recorded first, and the insert is the idempotency check. `onConflictDoNothing`
   * on the unique (provider, provider_event_id) index returns no rows for a
   * redelivery, which is how a retry is detected without a separate read that
   * could race.
   */
  const inserted = await db
    .insert(billingEvents)
    .values({
      provider: "stripe",
      providerEventId: event.id,
      eventType: event.type,
      userId: context.userId,
      providerCustomerId: context.customerId,
      providerSubscriptionId: context.subscriptionId,
      eventCreatedAt,
      applied: false,
      payload: event as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing({
      target: [billingEvents.provider, billingEvents.providerEventId],
    })
    .returning({ id: billingEvents.id });

  const row = inserted[0];
  if (!row) {
    log.info("duplicate webhook delivery ignored", {
      eventId: event.id,
      eventType: event.type,
    });
    return {
      eventId: event.id,
      eventType: event.type,
      applied: false,
      skipReason: "duplicate",
      userId: context.userId,
    };
  }

  const finish = async (
    skipReason: string | null,
    extra?: { tier?: PlanTier; status?: string },
  ): Promise<WebhookOutcome> => {
    await db
      .update(billingEvents)
      .set({ applied: skipReason === null, skipReason })
      .where(eq(billingEvents.id, row.id));

    return {
      eventId: event.id,
      eventType: event.type,
      applied: skipReason === null,
      skipReason,
      userId: context.userId,
      ...extra,
    };
  };

  if (!HANDLED.has(event.type)) {
    return finish("unhandled");
  }

  if (!context.userId) {
    /**
     * A real possibility, not a defensive nicety: a subscription created directly
     * in the Stripe dashboard has no `vidxirUserId`. Recorded and skipped, because
     * the alternatives are both worse than doing nothing — guessing an account
     * would grant a stranger's subscription to a user, and erroring would make
     * Stripe retry an event that can never succeed.
     */
    log.warn("webhook event could not be matched to a Vidxir AI account", {
      eventId: event.id,
      eventType: event.type,
    });
    return finish("unknown_customer");
  }

  /**
   * Credit top-ups, before any subscription handling (§11).
   *
   * Ordering matters: a `mode: "payment"` session has no subscription, so
   * `subscriptionObjectFor` returns null for it and the delivery would fall out as
   * `unhandled` — which is what it did before top-ups existed, and which would now
   * mean a customer paid and received nothing.
   *
   * Keyed on the session's own `mode` rather than on whether a purchase row exists:
   * "is this a one-off payment" is a fact about the event, whereas "do we have a row"
   * is a question about our own state, and confusing the two would make a lost row
   * turn a top-up into a subscription event.
   */
  const topUp = creditSessionOf(event);
  if (topUp) {
    const purchase = await completeCreditPurchase({
      userId: context.userId,
      providerSessionId: topUp.sessionId,
      paymentStatus: topUp.paymentStatus,
      providerPaymentIntentId: topUp.paymentIntentId,
      /**
       * Only invoked when there is no purchase row, so the normal path costs no
       * request. The line items are not on the event — Stripe sends the session
       * without them — so recovering an orphaned payment genuinely requires asking.
       */
      resolvePriceId: () => lineItemPriceId(topUp.sessionId),
    });

    /**
     * `applied` follows whether credits actually moved, so the log and the
     * `billing_events` row say what happened rather than merely that the event was
     * seen. Every skip reason here is still a 200: a replay, an uncleared payment and
     * an unrecognised price are all outcomes Stripe must stop redelivering, because
     * none of them will change on a retry.
     */
    if (purchase.skipReason) return finish(`credit_${purchase.skipReason}`);

    log.info("credits added from webhook", {
      userId: context.userId,
      eventType: event.type,
      credits: purchase.credited,
    });
    return finish(null);
  }

  const subscription = await subscriptionObjectFor(event, context);
  if (!subscription) {
    // An invoice with no subscription attached, or a session that bought nothing
    // Vidxir AI sells. Nothing to entitle.
    return finish("unhandled");
  }

  /**
   * The stale check. Strictly newer only: two events with the same timestamp are
   * ambiguous, and re-applying an identical state is harmless, whereas applying
   * something *older* is exactly the revert this guards against.
   */
  const applied = await applySubscription({
    userId: context.userId,
    subscription,
    eventCreatedAt,
  });

  if (!applied) {
    log.info("stale webhook delivery ignored", {
      eventId: event.id,
      eventType: event.type,
      userId: context.userId,
    });
    return finish("stale");
  }

  /**
   * Grant the period's credits now that the tier is known (§7).
   *
   * Without this a new subscriber would have no credits until their first generation
   * — `chargeCredits` grants inside its own transaction, so nothing would actually
   * break, but the dashboard would greet them with a zero balance immediately after
   * they paid, which reads as a failed purchase.
   *
   * Three properties make this safe here:
   *
   *  - **Idempotent per period**, so a redelivery or an unrelated
   *    `customer.subscription.updated` grants nothing a second time.
   *  - **Outside the event transaction, and non-fatal.** A grant that threw would fail
   *    the whole webhook and make Stripe retry an event that was already applied,
   *    which would then be recorded as `stale`. The tier is the thing the webhook
   *    exists to record; credits are recoverable from the charge path.
   *  - **Uses the tier just applied**, not a re-read, so an upgrade grants against the
   *    plan the customer has actually paid for.
   *
   * A downgrade grants nothing new — the period is already granted, and the smaller
   * allowance applies from the next period. That is the same rule an upgrade follows.
   */
  try {
    const grant = await ensureMonthlyGrant(context.userId, {
      tier: applied.status === "active" || applied.status === "trialing"
        ? applied.tier
        : "starter",
    });
    if (grant.granted) {
      log.info("granted monthly credits from webhook", {
        userId: context.userId,
        eventType: event.type,
        credits: grant.credits,
        period: grant.period,
      });
    }
  } catch (error) {
    log.error("failed to grant monthly credits after a billing event", {
      userId: context.userId,
      eventId: event.id,
      err: error,
    });
  }

  log.info("subscription updated from webhook", {
    userId: context.userId,
    eventType: event.type,
    tier: applied.tier,
    subscriptionStatus: applied.status,
  });

  return finish(null, { tier: applied.tier, status: applied.status });
}

// ---------------------------------------------------------------------------
// Resolving the event to an account
// ---------------------------------------------------------------------------

interface EventContext {
  userId: string | null;
  customerId: string | null;
  subscriptionId: string | null;
}

/**
 * Which Vidxir AI account an event belongs to.
 *
 * Three sources, in descending trustworthiness, and never the URL or a query
 * parameter:
 *
 *  1. `client_reference_id` / `metadata.vidxirUserId` — set by Vidxir AI when the
 *     session or subscription was created.
 *  2. The `subscriptions` row already carrying this customer or subscription id.
 *  3. The Stripe customer's own `metadata.vidxirUserId`, fetched if needed.
 *
 * Each candidate is validated against `users` before it is used, so a forged
 * metadata value naming a random uuid resolves to nothing rather than to an
 * account.
 */
async function resolveContext(event: Stripe.Event): Promise<EventContext> {
  /**
   * Through `unknown`: the union of every Stripe object has no index signature, and
   * this function reads a handful of fields that only some members carry. Each read
   * goes through `stringOrNull`, so a missing or wrongly-typed field becomes null
   * rather than a bad value.
   */
  const object = event.data.object as unknown as Record<string, unknown>;

  const customerId = stringOrNull(object["customer"]);
  const subscriptionId =
    event.type.startsWith("customer.subscription.") && typeof object["id"] === "string"
      ? object["id"]
      : stringOrNull(object["subscription"]);

  const claimed =
    stringOrNull(object["client_reference_id"]) ??
    metadataUserId(object["metadata"]);

  if (claimed) {
    const verified = await verifiedUserId(claimed);
    if (verified) return { userId: verified, customerId, subscriptionId };
  }

  /**
   * By stored ids. This is the path portal-initiated changes take: a
   * `customer.subscription.updated` for a plan swap the user made in Stripe's UI
   * carries our metadata only if the subscription was created through checkout,
   * and matching on the customer id is more robust than assuming it was.
   */
  if (customerId || subscriptionId) {
    const [row] = await db
      .select({ userId: subscriptions.userId })
      .from(subscriptions)
      .where(
        or(
          customerId
            ? eq(subscriptions.providerCustomerId, customerId)
            : sql`false`,
          subscriptionId
            ? eq(subscriptions.providerSubscriptionId, subscriptionId)
            : sql`false`,
        ),
      )
      .limit(1);

    if (row) return { userId: row.userId, customerId, subscriptionId };
  }

  // Last resort: ask Stripe what it knows about the customer.
  if (customerId) {
    const fromCustomer = await customerMetadataUserId(customerId);
    if (fromCustomer) {
      return { userId: fromCustomer, customerId, subscriptionId };
    }
  }

  return { userId: null, customerId, subscriptionId };
}

async function customerMetadataUserId(customerId: string): Promise<string | null> {
  try {
    const customer = await stripeClient().customers.retrieve(customerId);
    if (customer.deleted) return null;
    const claimed = metadataUserId(customer.metadata);
    return claimed ? await verifiedUserId(claimed) : null;
  } catch (error) {
    // A failed lookup means "unknown customer", which the caller already handles.
    log.warn("could not retrieve stripe customer", {
      errorCode:
        error instanceof Stripe.errors.StripeError ? error.type : "unknown",
    });
    return null;
  }
}

/** A user id that actually exists, or null. Never trusts the claim itself. */
async function verifiedUserId(claimed: string): Promise<string | null> {
  if (!UUID_RE.test(claimed)) return null;
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, claimed))
    .limit(1);
  return row?.id ?? null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function metadataUserId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  return stringOrNull((metadata as Record<string, unknown>)["vidxirUserId"]);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Credit top-up sessions
// ---------------------------------------------------------------------------

interface CreditSession {
  sessionId: string;
  paymentStatus: string | null;
  paymentIntentId: string | null;
}

/**
 * The one-off payment session this event is about, or null.
 *
 * Recognised by three facts about the event, all of which must hold: it is a checkout
 * session event, its `mode` is `payment`, and it carries a session id. A subscription
 * checkout fails the second test and an invoice fails the first, so neither can be
 * mistaken for a top-up.
 *
 * `async_payment_succeeded` and `async_payment_failed` are included because delayed
 * payment methods complete the session before the money clears: the `completed` event
 * arrives with `payment_status: "unpaid"` and is refused, and the *succeeding* event is
 * the one that credits. Without those two types in the list, a customer paying by such
 * a method would be charged and never credited.
 *
 * `checkout.session.expired` is deliberately absent. Marking the purchase row
 * `expired` would be tidy, but it is not *entitlement*, and a `pending` row that never
 * completes is already the correct reading of "the customer did not pay" — whereas
 * adding a write path here would be a second place that touches purchase rows.
 */
function creditSessionOf(event: Stripe.Event): CreditSession | null {
  if (
    event.type !== "checkout.session.completed" &&
    event.type !== "checkout.session.async_payment_succeeded" &&
    event.type !== "checkout.session.async_payment_failed"
  ) {
    return null;
  }

  const session = event.data.object as Stripe.Checkout.Session;
  if (session.mode !== "payment") return null;
  if (typeof session.id !== "string" || session.id.length === 0) return null;

  const intent = session.payment_intent;
  return {
    sessionId: session.id,
    paymentStatus: session.payment_status ?? null,
    paymentIntentId:
      typeof intent === "string" ? intent : (intent?.id ?? null),
  };
}

/**
 * The price id on a session's single line item, fetched from Stripe.
 *
 * Reached only for a paid credit session with no purchase row. Returns null on any
 * failure, which the caller reads as "unrecognised pack" and credits nothing — the
 * safe direction, because the alternative to knowing what was bought is guessing.
 */
async function lineItemPriceId(sessionId: string): Promise<string | null> {
  const items = await stripeClient().checkout.sessions.listLineItems(sessionId, {
    limit: 1,
  });
  return items.data[0]?.price?.id ?? null;
}

// ---------------------------------------------------------------------------
// The subscription object
// ---------------------------------------------------------------------------

/**
 * The subscription this event is about, fetched fresh from Stripe when the event
 * does not embed one.
 *
 * Deliberately re-fetched for checkout and invoice events rather than inferred:
 * `checkout.session.completed` tells us a session finished, and the subscription's
 * *current* state — including whether the first payment actually cleared — is on
 * the subscription object, not the session. Trusting the session would mark a
 * subscription active whose payment is still `incomplete`.
 */
async function subscriptionObjectFor(
  event: Stripe.Event,
  context: EventContext,
): Promise<Stripe.Subscription | null> {
  if (event.type.startsWith("customer.subscription.")) {
    return event.data.object as Stripe.Subscription;
  }

  if (!context.subscriptionId) return null;

  try {
    return await stripeClient().subscriptions.retrieve(context.subscriptionId);
  } catch (error) {
    log.warn("could not retrieve stripe subscription", {
      errorCode:
        error instanceof Stripe.errors.StripeError ? error.type : "unknown",
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Applying it
// ---------------------------------------------------------------------------

interface AppliedState {
  tier: PlanTier;
  status: string;
}

/**
 * Write the subscription state, unless a newer event has already been applied.
 *
 * The `lastEventAt` predicate is part of the UPDATE rather than a read-then-write,
 * so two deliveries processed concurrently cannot both pass the check: the older
 * one's WHERE clause stops matching the moment the newer one commits.
 */
async function applySubscription(input: {
  userId: string;
  subscription: Stripe.Subscription;
  eventCreatedAt: Date;
}): Promise<AppliedState | null> {
  const sub = input.subscription;
  const status = mapStatus(sub.status);

  /**
   * The tier comes from the price the subscription is on. A subscription whose
   * price is not one Vidxir AI sells resolves to Starter — the safe direction, and the
   * only honest one: Vidxir AI cannot know what an unrecognised price entitles.
   */
  const priceId = sub.items.data[0]?.price?.id ?? null;
  const fromPrice = tierForPriceId(priceId);

  /**
   * `entitled` decides whether the paid tier applies at all. A `past_due`
   * subscription keeps its *tier* recorded but `currentTier` refuses to honour it,
   * which is what §24 requires — and keeping the tier means a cleared payment
   * restores the right plan rather than dropping the customer to Starter
   * permanently.
   */
  const entitled = status === "active" || status === "trialing";
  const tier: PlanTier = fromPrice ?? (entitled ? fallbackTier(sub) : "starter");

  if (!fromPrice) {
    log.warn("subscription price is not a configured Vidxir AI plan", {
      userId: input.userId,
      subscriptionStatus: status,
    });
  }

  const updated = await db
    .update(subscriptions)
    .set({
      tier,
      status,
      provider: "stripe",
      providerCustomerId:
        typeof sub.customer === "string" ? sub.customer : sub.customer.id,
      providerSubscriptionId: sub.id,
      currentPeriodStart: secondsToDate(sub.current_period_start),
      currentPeriodEnd: secondsToDate(sub.current_period_end),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      trialEndsAt: secondsToDate(sub.trial_end),
      lastEventAt: input.eventCreatedAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(subscriptions.userId, input.userId),
        // Strictly newer, or never seen an event. `isNull` is required: `<` against
        // NULL is NULL, so a first event would not match without it.
        or(
          isNull(subscriptions.lastEventAt),
          sql`${subscriptions.lastEventAt} < ${input.eventCreatedAt.getTime()}`,
        ),
      ),
    )
    .returning({ tier: subscriptions.tier, status: subscriptions.status });

  const row = updated[0];
  if (!row) return null;
  return { tier: row.tier, status: row.status };
}

/**
 * The tier claimed in metadata, used only when the price is unrecognised *and* the
 * subscription is genuinely entitled. Validated against the catalogue, and never
 * able to name a tier that does not exist.
 */
function fallbackTier(sub: Stripe.Subscription): PlanTier {
  const claimed = sub.metadata?.["vidxirTier"];
  if (isPlanTier(claimed) && claimed !== "starter") {
    log.warn("falling back to metadata tier for an unrecognised price", {
      tier: claimed,
    });
    return claimed;
  }
  return "starter";
}

/** Stripe's status vocabulary mapped onto the `subscription_status` enum. */
function mapStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  switch (status) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
      return "past_due";
    case "canceled":
      return "canceled";
    case "unpaid":
      return "unpaid";
    case "incomplete":
    case "incomplete_expired":
      return "incomplete";
    case "paused":
      /**
       * A paused subscription is not collecting payment, so it must not entitle
       * paid features. There is no `paused` value in the enum and inventing one
       * would be a schema change for no behavioural gain — `unpaid` already means
       * "no access" to `currentTier`.
       */
      return "unpaid";
    default:
      return "incomplete";
  }
}

type SubscriptionStatus =
  (typeof subscriptions.status.enumValues)[number];

function secondsToDate(seconds: number | null | undefined): Date | null {
  return typeof seconds === "number" ? new Date(seconds * 1000) : null;
}
