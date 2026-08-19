/**
 * GET /api/health — liveness (§16, §22).
 *
 * "Is this process alive?" Nothing else. No database, no Redis, no configuration
 * inspection: a liveness failure gets the container killed, so a probe that
 * consulted Postgres would restart every replica at once during a database blip
 * and convert a recoverable dependency outage into a fleet-wide restart storm.
 *
 * Unauthenticated by necessity — an orchestrator probe has no session. Safe
 * because the response is a literal status and an uptime integer.
 *
 * Deliberately *not* wrapped in `handle()`. That wrapper assigns a trace id and
 * logs, which at a one-second probe interval would be tens of thousands of
 * meaningless log lines a day, and it would make the cheapest endpoint in the
 * application do work. Nothing in here can throw.
 */
import { NextResponse } from "next/server";
import { liveness } from "@/lib/health";

/** Never cached: a cached liveness answer is not an answer. */
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(liveness(), {
    headers: { "cache-control": "no-store" },
  });
}
