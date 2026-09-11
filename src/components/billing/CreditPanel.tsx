"use client";

/**
 * Credits — balance, top-ups and the transaction list (§7, §8, §11, §20).
 *
 * The billing screen's counterpart to `BillingPanel`. Separate rather than folded into
 * it for one structural reason: the plan panel is server-rendered from
 * `entitlementsFor()` at page load, while the balance changes underneath the page every
 * time a worker charges for a scene. Fetching it client-side from `GET /api/credits`
 * means a "Refresh" is a request rather than a full page reload, and it keeps the
 * credits read — which calls `ensureMonthlyGrant` — out of the render path of a page
 * that also renders when credits are irrelevant.
 *
 * Three things here are load-bearing:
 *
 *  1. **Every number is the server's.** Balance, ledger and pack prices all arrive from
 *     `/api/credits`. Nothing is summed in the browser, so nothing can drift from
 *     `credit_balances`, and a client that edits the payload has changed only its own
 *     screen — `chargeCredits` reads the database.
 *  2. **Buying opens a payment page and credits nothing.** `POST /api/credits/checkout`
 *     returns a URL and `creditsAdded: false`; the balance moves when the webhook
 *     confirms. So this component navigates to Stripe and never optimistically adds the
 *     pack's credits, which is the §42 rule the Publish panel taught.
 *  3. **No vendor names.** Ledger descriptions are written by the charge path and name
 *     the Tal model and the scene; there is nothing in this payload that could render a
 *     provider (§3).
 */
import { useCallback, useEffect, useState } from "react";
import { Coins, Info, RefreshCw } from "lucide-react";
import { Btn } from "@/components/ui/Btn";
import { Card } from "@/components/ui/Card";
import { color, eyebrow, font } from "@/lib/design/tokens";
import { api, messageOf } from "@/services/api-client";

/** `CreditBalance` from `lib/credits/service`, over the wire. */
interface Balance {
  available: number;
  granted: number;
  purchased: number;
  spent: number;
  period: string;
  grantedForTier: string;
}

/** `CreditHistoryEntry`, with `createdAt` as the ISO string JSON gives us. */
interface HistoryEntry {
  id: string;
  reason: string;
  amount: number;
  balanceAfter: number;
  operation: string | null;
  modelId: string | null;
  quality: string | null;
  description: string | null;
  createdAt: string;
}

interface PurchaseEntry {
  id: string;
  pack: string;
  credits: number;
  amountCents: number;
  currency: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

interface Pack {
  id: string;
  credits: number;
  amountCents: number;
  label: string;
  description: string;
  highlight: boolean;
  centsPerCredit: number;
}

interface CreditsResponse {
  balance: Balance;
  history: HistoryEntry[];
  purchases: PurchaseEntry[];
  topUpsAvailable: boolean;
  packs: Pack[];
}

export function CreditPanel() {
  const [data, setData] = useState<CreditsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await api.get<CreditsResponse>(
        "/api/credits",
        signal ? { signal } : {},
      );
      setData(result);
      setLoadError(null);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      // Shown rather than replaced with zero: "0 credits" and "we could not read your
      // balance" are different facts, and rendering the first for the second would tell
      // a user with a full balance that they have none.
      setLoadError(messageOf(e));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function buy(pack: string) {
    setBuying(pack);
    setError(null);
    try {
      const result = await api.post<{ url: string }>("/api/credits/checkout", {
        pack,
      });
      // Full navigation: the destination is Stripe, not a route in this app.
      window.location.assign(result.url);
    } catch (e) {
      setError(messageOf(e));
      setBuying(null);
    }
  }

  if (loadError) {
    return (
      <Card tone="warning" pad={16}>
        <div style={{ ...eyebrow, color: color.warning, marginBottom: 6 }}>
          Credits unavailable
        </div>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: color.textMuted }}>
          Could not read your credit balance: {loadError}
        </p>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card pad={16}>
        <p style={{ margin: 0, fontSize: 13, color: color.textDim }}>
          Reading your credit balance…
        </p>
      </Card>
    );
  }

  const { balance } = data;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* ---------------------------------------------------------------- */}
      {/* Balance                                                          */}
      {/* ---------------------------------------------------------------- */}
      <Card>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
            marginBottom: 18,
          }}
        >
          <div>
            <div style={{ ...eyebrow, marginBottom: 7 }}>Credit balance</div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontFamily: font.display,
                fontSize: 26,
                fontWeight: 600,
                letterSpacing: 0.5,
                color: balance.available === 0 ? color.warning : color.text,
              }}
            >
              <Coins
                size={20}
                color={balance.available === 0 ? color.warning : color.accent}
                aria-hidden="true"
              />
              {balance.available.toLocaleString()}
            </div>
            <p
              style={{
                margin: "8px 0 0",
                fontSize: 12.5,
                lineHeight: 1.55,
                color: color.textDim,
              }}
            >
              {/*
                The three components spelled out, because "why is it that number" is the
                question this panel exists to answer — and because §11's rule that
                purchased credits survive the monthly reset is invisible unless the two
                pools are shown apart.
              */}
              {balance.granted.toLocaleString()} included with your plan this period,{" "}
              {balance.purchased.toLocaleString()} purchased,{" "}
              {balance.spent.toLocaleString()} spent. Purchased credits do not expire at
              the end of the period.
            </p>
          </div>

          <Btn
            variant="ghost"
            onClick={() => void load()}
            icon={<RefreshCw size={14} />}
          >
            Refresh
          </Btn>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 16,
          }}
        >
          <Figure label={`Included · ${balance.period}`} value={balance.granted} />
          <Figure label="Purchased" value={balance.purchased} />
          <Figure label={`Spent · ${balance.period}`} value={balance.spent} />
          <Figure label="Available" value={balance.available} accent />
        </div>
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* Top-ups, or an honest reason there are none                       */}
      {/* ---------------------------------------------------------------- */}
      {data.topUpsAvailable && data.packs.length > 0 ? (
        <div>
          <div style={{ ...eyebrow, marginBottom: 12 }}>Buy more credits</div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: 10,
            }}
          >
            {data.packs.map((pack) => (
              <Card key={pack.id} tone={pack.highlight ? "accent" : "default"} pad={16}>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    height: "100%",
                  }}
                >
                  <div style={{ ...eyebrow, color: color.textFaint }}>{pack.label}</div>
                  <div
                    style={{
                      fontFamily: font.display,
                      fontSize: 20,
                      fontWeight: 600,
                      color: color.text,
                    }}
                  >
                    {pack.credits.toLocaleString()} credits
                  </div>
                  <div style={{ fontSize: 13, color: color.textBright }}>
                    {money(pack.amountCents, pack.credits)}
                  </div>
                  <p
                    style={{
                      margin: 0,
                      fontSize: 11.5,
                      lineHeight: 1.5,
                      color: color.textFaint,
                      flex: 1,
                    }}
                  >
                    {pack.description}
                  </p>
                  <Btn
                    variant={pack.highlight ? "primary" : "ghost"}
                    loading={buying === pack.id}
                    disabled={buying !== null}
                    onClick={() => void buy(pack.id)}
                  >
                    {buying === pack.id ? "Opening…" : "Buy"}
                  </Btn>
                </div>
              </Card>
            ))}
          </div>
          <p
            style={{
              margin: "10px 0 0",
              fontSize: 12,
              lineHeight: 1.6,
              color: color.textFaint,
            }}
          >
            You will be taken to our payment provider. Credits are added once the payment
            is confirmed — not when you leave this page.
          </p>
          {error && (
            <p
              role="alert"
              style={{
                margin: "8px 0 0",
                fontSize: 12.5,
                lineHeight: 1.6,
                color: color.warning,
              }}
            >
              {error}
            </p>
          )}
        </div>
      ) : (
        <Card tone="warning" pad={16}>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <Info
              size={16}
              color={color.warning}
              style={{ marginTop: 2, flexShrink: 0 }}
              aria-hidden="true"
            />
            <div style={{ minWidth: 0 }}>
              <div style={{ ...eyebrow, color: color.warning, marginBottom: 6 }}>
                Top-ups unavailable
              </div>
              <p
                style={{
                  margin: 0,
                  fontSize: 13,
                  lineHeight: 1.6,
                  color: color.textMuted,
                }}
              >
                {/*
                  No variable names here, unlike the plan panel's equivalent: the pack
                  price variables are operator detail and this is the customer's screen.
                  The operator surfaces name them.
                */}
                Credit top-ups are not switched on for this deployment. Your plan&rsquo;s
                included credits still renew at the start of each billing period, and
                upgrading your plan increases them.
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Transactions                                                     */}
      {/* ---------------------------------------------------------------- */}
      <div>
        <div style={{ ...eyebrow, marginBottom: 12 }}>Recent credit activity</div>
        {data.history.length === 0 ? (
          <Card pad={16}>
            <p style={{ margin: 0, fontSize: 13, color: color.textDim }}>
              No credit activity yet. Generating a video or an image records a line here
              for every charge.
            </p>
          </Card>
        ) : (
          <Card pad={0}>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {data.history.map((entry, index) => (
                <li
                  key={entry.id}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "12px 16px",
                    borderTop: index === 0 ? "none" : `1px solid ${color.border}`,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: color.textBright }}>
                      {entry.description ?? reasonLabel(entry.reason)}
                    </div>
                    <div
                      style={{
                        marginTop: 3,
                        fontSize: 11.5,
                        color: color.textFaint,
                      }}
                    >
                      {reasonLabel(entry.reason)} · {formatDateTime(entry.createdAt)}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div
                      style={{
                        fontFamily: font.display,
                        fontSize: 14,
                        fontWeight: 600,
                        // Sign, not colour alone: a red-only distinction is invisible to
                        // a reader who cannot see the difference.
                        color: entry.amount < 0 ? color.textMuted : color.accent,
                      }}
                    >
                      {entry.amount > 0 ? `+${entry.amount}` : entry.amount}
                    </div>
                    <div style={{ fontSize: 11, color: color.textFaint }}>
                      {entry.balanceAfter.toLocaleString()} left
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Purchases, when there are any                                    */}
      {/* ---------------------------------------------------------------- */}
      {data.purchases.length > 0 && (
        <div>
          <div style={{ ...eyebrow, marginBottom: 12 }}>Top-up history</div>
          <Card pad={0}>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {data.purchases.map((purchase, index) => (
                <li
                  key={purchase.id}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "12px 16px",
                    borderTop: index === 0 ? "none" : `1px solid ${color.border}`,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 13, color: color.textBright }}>
                      {purchase.credits.toLocaleString()} credits ·{" "}
                      {money(purchase.amountCents, null, purchase.currency)}
                    </div>
                    <div
                      style={{ marginTop: 3, fontSize: 11.5, color: color.textFaint }}
                    >
                      {formatDateTime(purchase.completedAt ?? purchase.createdAt)}
                    </div>
                  </div>
                  {/*
                    `pending` is shown rather than hidden: a customer whose payment
                    method settles asynchronously needs to see that the purchase exists,
                    and hiding it invites them to buy the same pack twice.
                  */}
                  <span
                    style={{
                      fontSize: 11,
                      fontFamily: font.display,
                      letterSpacing: 1,
                      textTransform: "uppercase",
                      color:
                        purchase.status === "completed"
                          ? color.textFaint
                          : color.warning,
                    }}
                  >
                    {purchaseStatusLabel(purchase.status)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Figure({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <div>
      <div style={{ ...eyebrow, marginBottom: 6 }}>{label}</div>
      <div
        style={{
          fontFamily: font.display,
          fontSize: 17,
          fontWeight: 600,
          color: accent ? color.accent : color.text,
        }}
      >
        {value.toLocaleString()}
      </div>
    </div>
  );
}

/**
 * Price, with the per-credit rate where a comparison is possible.
 *
 * The rate is the only way the packs are comparable — 1000 credits for $16 is better
 * value than 100 for $2 and the headline prices do not say so. Computed from the two
 * server-supplied figures rather than from the response's `centsPerCredit`, which is
 * rounded for display; either would do, and using the numbers actually shown keeps the
 * arithmetic on screen self-consistent.
 */
function money(cents: number, credits: number | null, currency = "usd"): string {
  const amount = (cents / 100).toLocaleString(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
  });
  if (credits === null || credits === 0) return amount;
  const per = (cents / credits / 100).toFixed(3);
  return `${amount} · $${per} per credit`;
}

/** The ledger `reason` enum in plain language. Unknown values pass through. */
function reasonLabel(reason: string): string {
  switch (reason) {
    case "monthly_grant":
      return "Plan credits";
    case "purchase":
      return "Top-up";
    case "spend":
      return "Generation";
    case "refund":
      return "Refund — generation failed";
    case "adjustment":
      return "Adjustment";
    default:
      return reason;
  }
}

function purchaseStatusLabel(status: string): string {
  switch (status) {
    case "completed":
      return "Paid";
    case "pending":
      return "Awaiting payment";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "at an unknown time"
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
