# Tally

AI YouTube automation platform. Research a niche, find an opportunity, write an
original script, generate voiceover, visuals, music and captions, render a video,
design a thumbnail, write metadata, and publish to a real YouTube channel — with
progress you can trust and nothing faked in between.

The UI is a direct port of the Tally design prototype: dark charcoal surfaces,
Tally red `#E8332B`, Oswald display / Inter body, compact creator-studio layout.

---

## Architecture

Six processes, so a long render never blocks a request:

| Process | Entry point | Responsibility |
|---|---|---|
| **Web / API** | `next start` | Pages, REST API, auth, OAuth callbacks |
| **Workers** | `npm run worker` | Every pipeline stage: script, voiceover, visuals, music, captions, timeline, render, quality check, thumbnail, metadata, publish |
| **Scheduler** | `npm run scheduler` | CRON: automation runs, analytics refresh, token refresh, session pruning |
| **Postgres** | container | All persistent state |
| **Redis** | container | BullMQ queues, rate limiting |
| **Object storage** | container (MinIO) / S3 | Audio, video, images. Never in Postgres. |

Nothing that must survive a browser close lives in React state. A job that is
running keeps running whether or not anyone is watching it.

### Layout

```
src/
  app/            Next.js App Router — pages and /api routes
  components/     UI, grouped by feature (auth, dashboard, video, ...)
  lib/
    api/          Request guard: auth, CSRF, rate limiting, error mapping
    auth/         Sessions and credentials
    db/           Drizzle schema, client, migration runner
    providers/    Provider abstractions + the capability registry
    projects/     State machine and project service
    plans/        Plan catalogue and server-side enforcement
  worker/         Queue consumers
  scheduler/      CRON entry point
drizzle/          Generated SQL migrations
tests/            Integration tests + harness
```

---

## Running it locally

Requires Node 20.11+ and Docker.

```bash
cp .env.example .env.local          # then fill in what you have
npm install
npm run infra:up                    # Postgres, Redis, MinIO
npm run db:migrate                  # applies migrations, seeds the plan catalogue
npm run dev                         # http://localhost:3000
```

Generate the two required secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`ENCRYPTION_KEY` encrypts stored OAuth tokens; `SESSION_SECRET` derives HMAC keys.
Rotating `ENCRYPTION_KEY` invalidates every stored token and forces channels to
be reconnected.

Workers and the scheduler are separate processes:

```bash
npm run worker
npm run scheduler
```

### Development mode (§40)

`TALLY_USE_MOCK_PROVIDERS=true` and `TALLY_BLOCK_REAL_PUBLISH=true` in
`.env.local` keep local work from spending provider credits or touching a real
channel. **Production refuses to boot with either of these set** — that check
lives in `src/lib/env.ts` and is deliberate, not a bug. If `next start` fails
with *"TALLY_USE_MOCK_PROVIDERS must be false in production"*, you are running a
production build against a development env file.

### Missing credentials

A capability with no credentials is a **configuration state**, never a silent
fake. `GET /api/config/providers` reports the state of every capability
(`ready` | `mock` | `not_configured`), and the affected screen renders a banner
naming the exact environment variable it needs. Everything unrelated keeps
working.

YouTube is the one capability with **no mock at all**, in any mode. A video
YouTube never received must never be reportable as published, so without
credentials the provider throws and the Channels screen says so.

### Credentials that are set but unusable

A valid key on an account with no money behind it is a third state, and it is
invisible until a call is made — `GET /api/config/providers` reads environment
variables, and probing every provider's balance on each page load would cost
real credits to answer.

So it surfaces where the work stops. An Anthropic 400 whose body says *"Your
credit balance is too low"* becomes `provider_out_of_credit`: HTTP 402, never
retried, and grouped with a missing credential into the
`blocked_not_configured` job status, because both are cleared by an operator
rather than by the user trying again. What differs is the wording — the run card
says *"Blocked — Claude is out of credit"*, not *"not configured"*, so nobody is
sent to re-check a variable that is already correct. The distinguishing code is
persisted on `jobs.error_code` and `research_runs.error_code`; the UI branches on
it rather than pattern-matching the message.

The raw API body is never shown. Provider errors are translated in
`src/lib/providers/ai.ts` (`translate()`), and `src/lib/providers/ai.test.ts`
pins the table — which failures retry, and what each one tells the operator to
fix.

---

## Connecting YouTube

Tally reaches YouTube through Google OAuth. It never asks for a YouTube password
and never stores one.

Two credentials are required:

| Variable | Where it comes from |
|---|---|
| `GOOGLE_CLIENT_ID` | Google Cloud console → APIs & Services → Credentials → **Create credentials → OAuth client ID**, type *Web application* |
| `GOOGLE_CLIENT_SECRET` | same screen |

On that OAuth client, add the redirect URI **exactly**:

```
{APP_URL}/api/channels/callback      # e.g. http://localhost:3000/api/channels/callback
```

Enable both APIs on the project: **YouTube Data API v3** and **YouTube Analytics
API**. Data API v3 is a 10,000-unit/day quota by default and an upload costs
~1,600 units, so a fresh project supports roughly six uploads a day until you
request more.

Scopes requested at consent:

| Scope | Used for |
|---|---|
| `auth/youtube` | read channel, set thumbnail, edit metadata after upload |
| `auth/youtube.upload` | upload the rendered video |
| `auth/yt-analytics.readonly` | daily metrics for the analytics feedback loop |

`yt-analytics-monetary.readonly` is deliberately **not** requested, so Tally does
not display revenue — a figure it cannot measure is a figure it will not show.
The Analytics API likewise has no impressions or impression-CTR metric (those are
Studio-only), so those columns stay null rather than being estimated.

Grants expire. When Google refuses a refresh with `invalid_grant` — the user
revoked access, or six months passed unused — the channel is flagged and the UI
offers a reconnect. Nothing retries in a loop and no job fails silently.

### Channel API

| Endpoint | Purpose |
|---|---|
| `GET /api/channels` | Connected channels, plan limits, YouTube capability state |
| `GET /api/channels/connect` | Begin authorisation (redirects to Google) |
| `GET /api/channels/callback` | Google's redirect target; validates state, persists tokens |
| `GET /api/channels/:id` | One channel |
| `DELETE /api/channels/:id` | Revoke at Google and disconnect (soft delete — publishing history survives) |
| `POST /api/channels/:id/refresh` | Re-read statistics from the Data API |
| `GET /api/channels/:id/videos` | Recent uploads on the channel (metadata only, never media) |
| `GET /api/channels/:id/analytics` | Stored snapshots — empty, not zero-filled, when nothing is measured |
| `POST /api/channels/:id/analytics` | Ingest a window from the Analytics API |

The scheduler runs three tasks in the background, so none of this depends on a
browser being open: expired-session pruning (hourly), channel statistics refresh
(every 30 min, 6-hour TTL) and analytics ingestion (every 6 hours, re-pulling a
4-day window because YouTube keeps revising recent figures).

---

## Research and the Tally Opportunity Score

A research run is a background job, not a request. `POST /api/research/run`
validates, records a `research_runs` row, enqueues, and returns a run id and job
id; the run itself happens in the worker, so it survives a refresh and a closed
browser.

| Endpoint | Purpose |
|---|---|
| `POST /api/research/run` | Start a run for one channel (rate limited: 10 per 10 min per user) |
| `GET /api/research/runs` | Run history with status, signal counts, and the live job's real progress |
| `GET /api/research/ideas` | Ideas with their six component scores and the source videos behind each |
| `PATCH /api/research/ideas` | Save or reject an idea (persisted — it feeds §26's loop) |
| `GET /api/projects` · `POST /api/projects` | List projects; turn a selected idea into one |

What a run actually does:

1. **Collect real signals** from the Data API — up to 6 probes derived from the
   channel's niche and keywords, each searched twice (`order=viewCount` for what
   won, `order=date` for what is winning now), plus `mostPopular` for the
   channel's region and the channel's own recent uploads. Statistics are then read
   in batches of 50, because search results carry no view counts and without them
   there is no velocity and no engagement — i.e. no scoring input at all.
2. **Score** each observation on six factors, then combine them into the **Tally
   Opportunity Score**. Weights live in `channel_settings.score_weights` and
   default to trend .22, velocity .22, competition .18, audience fit .18,
   opportunity .12, freshness .08.
3. **Generate original angles** with Claude, given the scored evidence. The model
   is asked to diagnose *why* a topic is working and propose a distinct angle; the
   schema requires `angle` and `rationale` as separate fields, every idea records
   the `research_results` rows it came from, and an idea whose title overlaps a
   source title by more than 60% of content words is rejected as derivative.

The score is **Tally's own metric, not a YouTube one**, and the README says so
because the UI does too. `competition` is inverted — high means easy to win.
`freshness` decays linearly over 30 days and is 0, not a guess, when a date is
missing. The "search demand" series plots observed weekly view totals: there is no
public YouTube search-volume API, so inventing one would be exactly the kind of
fake the rest of this codebase refuses.

A run costs roughly **600 quota units** worst case (6 probes × 2 searches × 100,
plus batched 1-unit reads), against a default 10,000/day. That bound is why
`MAX_SEARCHES` is a constant with the arithmetic written next to it.

Scoring is pure — no database, no network — so all 52 of its tests run in
milliseconds. They assert properties (monotonicity, range, inversion, ordering)
rather than exact numbers, so tuning a weight does not read as a regression.

### Credential

`ANTHROPIC_API_KEY` is what step 3 needs. Without it, signal collection and
scoring still run and persist; idea generation throws `NotConfiguredError`, the
run is recorded as `blocked_not_configured`, and the Research screen names the
missing variable instead of displaying invented ideas.

---

## Scripts, versions and metadata

A script is generated in the worker, not in the request, so a ten-minute script
survives a refresh. `POST /api/scripts/generate` moves the project to
`SCRIPT_GENERATING`, enqueues, and returns a job id plus the version number the
run will produce. It never returns a script, because at that moment none exists.

| Endpoint | Purpose |
|---|---|
| `POST /api/scripts/generate` | Queue a script or rewrite (rate limited: 10 per 10 min per user) |
| `GET /api/scripts/versions` | Every version of the project's script, newest first, with the active one flagged |
| `PATCH /api/scripts/versions` | Make an earlier version active again |
| `POST /api/scripts/approve` | Sign off the active version |
| `GET /api/metadata` | Stored title, description, tags, hashtags and chapters — `null`, not a blank shell, before generation |
| `POST /api/metadata` | Write metadata from the active script (`force: true` to replace a hand-edited row) |
| `PATCH /api/metadata` | Save a manual edit |

### Versions are append-only

Regenerating writes a new row and moves a pointer; it never overwrites. That is a
product requirement rather than tidiness — a user who regenerates, dislikes the
result and wants the first draft back should not have to ask a model to reproduce
it. The version number is computed inside the transaction from the rows that
exist, and a unique index on `(script_id, version)` means two concurrent writes
cannot both claim v3.

Approval is attached to the script, and **any change clears it**. Generating v2
clears it; reverting to v1 clears it too, because what was approved is not what is
now active. Without that, a regenerated script would reach the video builder
carrying a sign-off nobody gave it.

Approving does not start the render. Approval and "spend money on voiceover,
visuals and a render" are separate decisions, so `approveScript` leaves the
project at `SCRIPT_READY` and the video build makes the second decision.

### Duration is measured, never claimed

`word_count` excludes headings and talking points — they are not spoken — and the
estimate is `words / 150 × 60`, from a single `WORDS_PER_MINUTE` constant used in
both directions. The model is never asked how long its script runs; it would
guess, and the guess would be displayed as a fact.

### Metadata

Metadata is written from the finished script, not from the idea, because a
description has to describe what the video actually says. Generating before a
script exists is refused rather than attempted.

Two rules are enforced server-side:

- **A hand edit is final until the user says otherwise.** Any `PATCH` sets
  `edited_by_user`, and a regeneration then refuses with `409` unless explicitly
  forced. The Publish panel already tells the user this in words, so the promise is
  kept by the API rather than by hiding a button.
- **Chapter timestamps are computed, never generated.** The model contributes
  labels only — the schema has no field for a timing. Offsets come from real
  `scenes.start_ms` when the pipeline has measured them, and otherwise from the
  script's own per-section word counts at the same rate as the duration estimate.
  When neither source yields strictly increasing offsets the chapter list is
  returned empty, because a nudged timestamp is invented data.

YouTube's own limits are applied on save, not discovered at publish: 100-character
title, 5,000-character description, at most 15 tags inside a **500-character total
tag budget** (over it, YouTube rejects the entire upload), 3 hashtags, and a
chapter list that is dropped below three entries or without a marker at exactly
`0:00`, since it would otherwise be silently ignored.

### Credential

`ANTHROPIC_API_KEY` is what both stages need, and `ANTHROPIC_MODEL` selects the
model (default `claude-opus-5`). Without the key, `/api/scripts/generate` and
`POST /api/metadata` refuse up front with `503` and the variable's name — checked
in the route as well as the worker, because otherwise the project would move to
`SCRIPT_GENERATING` and instantly to `FAILED`, which reads as a bug rather than as
something to configure.

---

## Checks

```bash
npm run typecheck
npm run lint
npm test                            # unit tests; no services required
```

Integration tests need a **separate** database, because they `TRUNCATE` between
tests:

```bash
docker exec tally-postgres createdb -U tally tally_test
TEST_DATABASE_URL=postgresql://tally:tally@localhost:5432/tally_test \
  npm run test:integration
```

Without `TEST_DATABASE_URL` the integration suites report as *skipped* rather
than passing — a green run on a machine with no database should not imply
coverage it does not have.

Two dependencies are mocked in the integration tests, both at their provider
boundary and for the same reason — a test suite must not spend real quota or real
credits (§40): `lib/providers/youtube` and `lib/providers/ai`. Everything below
those seams is production code, including Postgres, encryption, HMAC state
signing, session cookies, the brief assembly, the schema validation, the version
transaction, the state machine and every ownership predicate. `googleapis` is
externalised in `vitest.config.ts`; it is a barrel over thousands of modules and
running it through Vite's transform pipeline costs minutes per file.

---

## Non-negotiables

These are enforced in code, not by convention:

- **Passwords** are scrypt hashes with per-user salts. The plaintext is never
  stored, logged, or recoverable.
- **OAuth tokens** are AES-256-GCM encrypted at rest and never serialised to the
  frontend. Tally asks for a Google authorisation, never a YouTube password.
- **Provider API keys** are server-side only. Nothing that reads `env()` can be
  imported into a client component — `server-only` makes that a build error.
- **Plan entitlements** are read from the `subscriptions` table on every check.
  A request body claiming a tier grants nothing.
- **`PUBLISHED`** is reachable only from `PUBLISHING`, i.e. after YouTube has
  confirmed the upload. The state machine makes any other path unwritable.
- **Progress** always reflects real job state. Where a provider reports no
  percentage the UI shows an indeterminate indicator rather than an invented one.
- **Originality**: Tally generates original content from trend research. It does
  not download or republish other people's videos.
- **Tenant isolation** is part of every query predicate, and covered by tests
  that hold a valid id from another account and confirm it is refused.

See `.env.example` for the full, commented configuration surface.
