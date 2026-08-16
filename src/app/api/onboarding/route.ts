/**
 * GET   /api/onboarding  — current answers + what is still missing
 * PATCH /api/onboarding  — save one step's answers
 * POST  /api/onboarding  — mark onboarding complete
 */
import type { NextRequest } from "next/server";
import { handle, parseJson, requireUser } from "@/lib/api/guard";
import { onboardingPatchSchema } from "@/lib/onboarding/config";
import {
  complete,
  getProfile,
  missingFields,
  saveStep,
} from "@/lib/onboarding/service";

export async function GET(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireUser();
    const profile = await getProfile(user.id);
    return {
      name: user.name,
      email: user.email,
      profile,
      missing: missingFields(profile),
      onboarded: Boolean(user.onboardedAt),
    };
  });
}

export async function PATCH(request: NextRequest) {
  return handle(request, async () => {
    const { user } = await requireUser();
    const patch = await parseJson(request, onboardingPatchSchema);
    const profile = await saveStep(user.id, patch);
    return { profile, missing: missingFields(profile) };
  });
}

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { user, log } = await requireUser();
    await complete(user.id);
    log.info("onboarding finished");
    // The next step is connecting a channel (§46), which happens on the
    // dashboard's Channels screen via real Google OAuth.
    return { onboarded: true, nextStep: "connect_channel" as const };
  });
}
