/**
 * GET /api/video/providers — the generation methods this user may pick from
 * (Phase 11 §9, §10, §19, §20, §21; Phase 12 §3, §4, §14, §16).
 *
 * The picker's whole catalogue is computed here, server-side, from two things the
 * browser has no access to: which providers this deployment configured, and what
 * the caller's subscription includes. §10 requires exactly that — "available models
 * come from server-side provider configuration" — and it is also what makes the
 * response safe to send: `generationOptions` reads whether credentials are *set*,
 * never what they are, so there is no value in this payload that could leak a key
 * (§21, "never send provider API keys to the browser").
 *
 * **Phase 12 §3 narrows it further.** Until Phase 12 this route forwarded each
 * provider's `label`, `hint` and `serviceNote`, which is how "fal.ai", "Seedance",
 * "MiniMax", "Wan", "Veo" and "Gemini" reached the browser. §3 and §14 forbid that,
 * so the per-provider block is replaced by `providerReadiness()` — the same
 * distinction expressed as counts. The screen can still tell "this deployment offers
 * no AI video" from "AI video is enabled but misconfigured", which is the only thing
 * it needed the block for; the variable an operator must set is in the operator
 * surfaces (`/api/config/providers` and `verify:video-providers`), where it belongs.
 *
 * Nothing here authorises anything. A `locked: true` model is a display hint about
 * an upgrade, and a client that deletes the flag before rendering has changed only
 * its own screen: `/api/projects/from-youtube` and `/api/projects/configure` both
 * re-run `validateSelection` against the tier read from the database (§19, "do not
 * allow the frontend to grant itself access").
 *
 * `formats` and `qualities` travel with it because §4 and §16 make the frame and the
 * resolution part of the same choice — a portrait project and a model that only
 * generates landscape are incompatible, and so are a 2K request and a model that
 * tops out at 1080p. The picker needs the lists to say so before the user submits,
 * and each model carries its own supported subset so §4's "do not show an option the
 * model does not support" is a matter of iterating rather than remembering.
 */
import type { NextRequest } from "next/server";
import { currentTier, handle, requireOnboarded } from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { canBuyCredits } from "@/lib/credits/purchase";
import { creditBalanceFor } from "@/lib/credits/service";
import { capabilityStatus } from "@/lib/providers/config";
import { providerReadiness } from "@/lib/providers/video-gen";
import { videoFormats } from "@/lib/video/format";
import { generationOptions } from "@/lib/video/generation-plan";

export async function GET(request: NextRequest) {
  return handle(request, async () => {
    // Authenticated, like `/api/config/providers`: which credentials a deployment
    // is missing is operational detail, and it should not be readable anonymously
    // even though it contains no secrets.
    const { user } = await requireOnboarded();
    await enforce(rules().read, `video-providers:${user.id}`);

    const tier = await currentTier(user.id);
    const options = generationOptions(tier);

    /**
     * The balance, so the picker can price the choice against it (§20).
     *
     * `creditBalanceFor` reads and never grants, which is what makes this safe to put
     * on a catalogue read: a page load must not be able to mint credits. A subscriber
     * whose period has just rolled over sees their stale figure here for as long as it
     * takes them to load the billing screen or start a generation, both of which call
     * `ensureMonthlyGrant` — understating a balance is the safe direction, since the
     * charge path grants before it charges and so nothing is refused for want of a
     * grant this read declined to make.
     */
    const balance = await creditBalanceFor(user.id);

    return {
      modes: options.modes,
      models: options.models,
      aiAvailable: options.aiAvailable,
      formats: videoFormats(),
      qualities: options.qualities,
      /**
       * Aggregate configuration state, with no vendor names (§3).
       *
       * `awaitingConfiguration > 0` with `ready: 0` is "AI video is set up but not
       * finished — contact support", which is actionable without naming a company.
       * `ready: 0, awaitingConfiguration: 0` is "this workspace offers stock footage
       * only", which is a complete and honest answer rather than an empty list that
       * reads as "this feature does not exist".
       */
      readiness: providerReadiness(),
      /** Whether stock footage is usable — the fallback mode's own readiness. */
      stock: capabilityStatus("visuals"),
      /**
       * What the caller can spend, alongside what each option costs (§20).
       *
       * Only `available` and the period, not the full `CreditBalance`: the picker needs
       * "can this user afford this choice", and the granted/purchased/spent breakdown
       * belongs on the billing screen where the answer to "why is it that number"
       * lives. `canTopUp` is the deployment's capability, not the user's — it decides
       * whether an insufficient balance offers a top-up link or tells them to wait for
       * the period to roll over, and offering a checkout that cannot open would be the
       * worse of the two mistakes.
       */
      credits: {
        unlimited: balance.unlimited,
        available: balance.available,
        period: balance.period,
        canTopUp: canBuyCredits(),
      },
    };
  });
}
