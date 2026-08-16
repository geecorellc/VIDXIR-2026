/**
 * GET /api/config/providers
 *
 * Reports which capabilities are ready, mocked, or unconfigured (§42, §48). The
 * UI uses this to render an explicit configuration banner — the mechanism that
 * replaces silently faking a feature that has no credentials.
 *
 * Only names are returned: capability, selected provider, state, and the env var
 * names that are missing. No secret values, and no indication of what any
 * configured value is.
 */
import type { NextRequest } from "next/server";
import { handle, requireUser } from "@/lib/api/guard";
import { blockingMisconfigurations, providerStatuses } from "@/lib/providers/config";
import { realPublishBlocked, usingMockProviders } from "@/lib/env";

export async function GET(request: NextRequest) {
  return handle(request, async () => {
    // Authenticated: the list of missing credentials is operational detail that
    // should not be public, even though it contains no secrets.
    await requireUser();

    return {
      capabilities: providerStatuses(),
      blocking: blockingMisconfigurations().map((c) => c.capability),
      devMode: {
        mockProviders: usingMockProviders(),
        publishBlocked: realPublishBlocked(),
      },
    };
  });
}
