/**
 * GET /api/video/providers — the generation methods this user may pick from
 * (Phase 11 §9, §10, §19, §20, §21).
 *
 * The picker's whole catalogue is computed here, server-side, from two things the
 * browser has no access to: which providers this deployment configured, and what
 * the caller's subscription includes. §10 requires exactly that — "available models
 * come from server-side provider configuration" — and it is also what makes the
 * response safe to send: `generationOptions` reads whether credentials are *set*,
 * never what they are, so there is no value in this payload that could leak a key
 * (§21, "never send provider API keys to the browser").
 *
 * Nothing here authorises anything. A `locked: true` model is a display hint about
 * an upgrade, and a client that deletes the flag before rendering has changed only
 * its own screen: `/api/projects/from-youtube` and `/api/projects/configure` both
 * re-run `validateSelection` against the tier read from the database (§19, "do not
 * allow the frontend to grant itself access").
 *
 * `formats` travels with it because §16 makes the frame part of the same choice —
 * a portrait project and a model that only generates landscape are incompatible,
 * and the picker needs both lists to say so before the user submits.
 */
import type { NextRequest } from "next/server";
import { currentTier, handle, requireOnboarded } from "@/lib/api/guard";
import { enforce, rules } from "@/lib/api/rate-limit";
import { capabilityStatus } from "@/lib/providers/config";
import { videoGenStatuses } from "@/lib/providers/video-gen";
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

    return {
      modes: options.modes,
      models: options.models,
      aiAvailable: options.aiAvailable,
      formats: videoFormats(),
      /**
       * Per-provider configuration state, names only (§20).
       *
       * Included so the screen can distinguish the two reasons AI video might be
       * offering nothing: no provider enabled at all, versus one enabled whose key
       * is unset. The second is an operator action and says which variable — which
       * is the honest configuration state §48 asks for, rather than an empty list
       * that reads as "this feature does not exist".
       */
      providers: videoGenStatuses().map((status) => ({
        provider: status.provider,
        label: status.label,
        state: status.state,
        missingEnvVars: status.missingEnvVars,
        hint: status.hint,
        serviceNote: status.serviceNote,
      })),
      /** Whether stock footage is usable — the fallback mode's own readiness. */
      stock: capabilityStatus("visuals"),
    };
  });
}
