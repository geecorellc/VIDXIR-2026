# Vidxir AI

AI YouTube automation platform. Research a niche, find an opportunity, write an
original script, generate voiceover, visuals, music and captions, render a video,
design a thumbnail, write metadata, and publish to a real YouTube channel — with
progress you can trust and nothing faked in between.

The UI is a direct port of the Vidxir AI design prototype: dark charcoal surfaces,
Vidxir AI red `#E8332B`, Oswald display / Inter body, compact creator-studio layout.

---

## Architecture

The app runs on Cloudflare. See [CLOUDFLARE.md](CLOUDFLARE.md) for release commands,
resource bindings, operator secrets and validation. Long renders run in Containers
so they never block a web request:

| Service | Configuration | Responsibility |
|---|---|---|
| **Web / API Worker** | `wrangler.jsonc` | Next.js pages, REST API, auth, OAuth callbacks |
| **Backend Worker + Containers** | `wrangler.native.jsonc` | Pipeline execution, FFmpeg rendering, thumbnails and publishing |
| **Cron Triggers** | Backend Worker | Automation, analytics refresh, session pruning |
| **D1** | `DB` binding | Persistent relational state and durable job records |
| **Queues + Durable Objects** | Native bindings | Delivery, retries, ownership, locks and rate limiting |
| **R2** | `MEDIA` binding | Private audio, video and image artifacts |

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
drizzle-d1/       Active D1 migrations
drizzle/          Legacy PostgreSQL migrations
tests/            Integration tests + harness
```

---

## Running it locally

Requires Node 20.11+. Docker is needed for the background FFmpeg Container.

```bash
cp .env.example .env.local          # then fill in what you have
npm install
npm run db:migrate:d1               # local D1 schema and plan catalogue
npm run dev -- --port 3002           # http://localhost:3002
```

Generate the two required secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`ENCRYPTION_KEY` encrypts stored OAuth tokens; `SESSION_SECRET` derives HMAC keys.
Rotating `ENCRYPTION_KEY` invalidates every stored token and forces channels to
be reconnected.

Background work uses the backend Worker, Queues and its Container. For a local
backend session, run `npx wrangler dev --config wrangler.native.jsonc` with Docker
running. Deployment and current operational instructions are in [CLOUDFLARE.md](CLOUDFLARE.md).
The PostgreSQL/BullMQ verification and operations notes later in this document
describe the previous deployment; they are retained as historical references.

### Development mode (§40)

`VIDXIR_USE_MOCK_PROVIDERS=true` and `VIDXIR_BLOCK_REAL_PUBLISH=true` in
`.env.local` keep local work from spending provider credits or touching a real
channel. **Production refuses to boot with either of these set** — that check
lives in `src/lib/env.ts` and is deliberate, not a bug. If `next start` fails
with *"VIDXIR_USE_MOCK_PROVIDERS must be false in production"*, you are running a
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

### AI provider

Every AI feature — research angles, scripts, scene direction, thumbnail concepts,
metadata — goes through the single factory in `src/lib/providers/ai.ts`. There is
one entry point, `generateJson()`, and two transports to the same Claude models.
`AI_PROVIDER` picks one:

| | `AI_PROVIDER=anthropic` (default) | `AI_PROVIDER=bedrock` |
|---|---|---|
| Credentials | `ANTHROPIC_API_KEY` | standard AWS provider chain |
| Region | n/a | `BEDROCK_REGION`, or `AWS_REGION` |
| Model | `ANTHROPIC_MODEL` (`claude-opus-5`) | `BEDROCK_MODEL` (`anthropic.claude-opus-5`) |
| SDK | `@anthropic-ai/sdk` | `@anthropic-ai/bedrock-sdk` |

Callers cannot tell which one answered: the options struct, the Zod validation,
the `api_usage` accounting and the error taxonomy are identical. What is recorded
*does* differ, deliberately — `api_usage.provider`, `ideas.generated_by` and
`script_versions.provider`/`model` store the transport and model that actually
produced the row, so provenance survives a later change of configuration (§29).

Three things are worth knowing before switching to Bedrock.

**Credentials never enter Vidxir AI's configuration.** There is no
`BEDROCK_ACCESS_KEY_ID`. The client is constructed without credentials, which is
what selects the standard AWS chain — environment variables,
`~/.aws/credentials`, an SSO cache, or an instance/container role (§33). The IAM
principal needs `bedrock:InvokeModel`. Confirm the identity with
`aws sts get-caller-identity`.

**Model ids are namespaced.** Bedrock answers the bare `claude-opus-5` with a 404
"does not exist"; it wants `anthropic.claude-opus-5`. The prefix is added when
absent, so either form in `BEDROCK_MODEL` works. A 404 from Bedrock is translated
into a message naming `BEDROCK_MODEL` and `BEDROCK_REGION`, because the usual
cause is a model that is not enabled for the account in that region rather than a
bad credential.

**The two surfaces do not accept the same request.** Bedrock rejects
`output_config.format` (*"Extra inputs are not permitted"*) and `strict: true` on
a tool, so the first-party path uses a `json_schema` output format while the
Bedrock path uses a single-tool schema with a forced `tool_choice`. Both send
adaptive thinking and `ANTHROPIC_EFFORT`. This is the only branch in the module,
and it is confined to `requestFor()` and `extractPayload()`. The consequence
matters: on Bedrock the schema is advisory rather than enforced by the decoder,
which is why the local Zod pass in `generateJson()` is load-bearing there and not
merely a second opinion.

Readiness is reported honestly on both. `BEDROCK_REGION` (or `AWS_REGION`) is
checkable, so a missing one is `not_configured` naming the variable. AWS
credentials are **not** checked up front: the chain resolves them asynchronously
from sources this process cannot inspect, so claiming to have verified them would
be a guess dressed as a fact (§42). An absent or expired credential surfaces
instead as `provider_auth_failed` pointing at the AWS chain — never at
`ANTHROPIC_API_KEY`, which would send the operator to a console they do not use.

Verify a real call end-to-end with `npm run verify:providers claude`, which prints
the transport and model that answered.

---

## Connecting YouTube

Vidxir AI reaches YouTube through Google OAuth. It never asks for a YouTube password
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

`yt-analytics-monetary.readonly` is deliberately **not** requested, so Vidxir AI does
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

## Research and the Vidxir AI Opportunity Score

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
2. **Score** each observation on six factors, then combine them into the **Vidxir AI
   Opportunity Score**. Weights live in `channel_settings.score_weights` and
   default to trend .22, velocity .22, competition .18, audience fit .18,
   opportunity .12, freshness .08.
3. **Generate original angles** with Claude, given the scored evidence. The model
   is asked to diagnose *why* a topic is working and propose a distinct angle; the
   schema requires `angle` and `rationale` as separate fields, every idea records
   the `research_results` rows it came from, and an idea whose title overlaps a
   source title by more than 60% of content words is rejected as derivative.

The score is **Vidxir AI's own metric, not a YouTube one**, and the README says so
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

A configured AI provider is what step 3 needs — `ANTHROPIC_API_KEY` on the
first-party API, or `BEDROCK_REGION` plus AWS credentials when
`AI_PROVIDER=bedrock` (see [AI provider](#ai-provider)). Without one, signal
collection and scoring still run and persist; idea generation throws
`NotConfiguredError`, the run is recorded as `blocked_not_configured`, and the
Research screen names the missing variable instead of displaying invented ideas.

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

A configured AI provider is what both stages need; see
[AI provider](#ai-provider) for the two ways to supply one and which variable
selects the model. Without one, `/api/scripts/generate` and `POST /api/metadata`
refuse up front with `503` and the name of whichever variable is actually missing
for the selected transport — checked in the route as well as the worker, because
otherwise the project would move to `SCRIPT_GENERATING` and instantly to
`FAILED`, which reads as a bug rather than as something to configure.

---

## The video pipeline

`POST /api/video/build` queues the first stage and returns a job id and the scene
count the plan will produce. It does not return a video, because at that moment
there isn't one. Seven jobs then run on the `pipeline` queue, each enqueueing the
next, so a crash resumes at a stage boundary instead of restarting the render:

| Job | Stage | Produces |
|---|---|---|
| `video-scene-plan` | `SCENE_PLAN` | Scene rows with measured narration offsets |
| `video-voiceover` | `VOICEOVER` | One narration asset per scene |
| `video-visuals` | `VISUALS` | One visual per scene (stock, else generated) |
| `video-music` | `MUSIC` | A bed sized to the measured runtime |
| `video-captions` | `CAPTIONS` | Cues from the real audio, plus SRT/VTT |
| `video-timeline` | `TIMELINE` | The timeline document the renderer consumes |
| `video-render` | `RENDER` | The MP4, stored in object storage |

Progress is the sum of the weights of the stages that have finished — never a
timer. The weights live in one table (`PIPELINE_STAGES`) that sums to 100, and
`RENDER` is worth 25 of it, so a bar that sits at 75% is telling the truth about
where the work is.

Scene durations come from the encoded audio, not from an estimate: `wavDurationMs`
reads the WAV header and the MP3 path parses frame headers, so the visual slot is
as long as the narration actually is. A scene plan whose narration is missing
fails with `asset_missing` rather than rendering a silent gap.

### Renderer

`RENDER_PROVIDER` selects one of three, and there is deliberately **no mock
renderer** — even a development build produces a real, playable MP4 (§42):

- **`ffmpeg`** (default) — encodes on the worker with the bundled `ffmpeg-static`
  binary. No account, no per-minute cost. `FFMPEG_PATH` overrides the bundled
  binary with a system one (e.g. an NVENC build); it must support `libx264`,
  `aac` and the `subtitles` filter, since captions are burned in through libass.
- **`shotstack`** — hosted. `SHOTSTACK_API_KEY` plus `SHOTSTACK_ENV`
  (`stage` while testing). Renders are submitted, then polled, and every poll
  writes the provider's own percentage to `renders.progress`.
- **`remotion-lambda`** — your own render farm. `REMOTION_AWS_REGION`,
  `REMOTION_LAMBDA_FUNCTION_NAME` and `REMOTION_SERVE_URL`; the deployed site must
  expose a composition named `VidxirVideo` that accepts Vidxir AI's timeline document as
  its input props.

A local encode is a single pass: stills are looped for their scene's slot, scaled
and padded to the output frame, narration is delayed to each scene's offset, the
music bed is mixed with `amix` (`normalize=0`, so a two-input mix does not halve
the narration), captions are burned in, and the result is written with
`+faststart` so the studio preview can stream before the file is fully buffered.
It is capped at 45 minutes; a longer encode is killed and reported, not left
running.

`-xerror` is part of the argument list and is load-bearing rather than tidiness.
`-loop 1 -t <slot>` measures `-t` in *output* time, so an image that never decodes
— a truncated download, a provider serving HTML under an image content-type —
produces no frames, output time never advances, `-t` never fires, and ffmpeg
re-reads the same unreadable file until something kills it. Measured here: a
corrupt PNG spun until the timeout while emitting 18 MB of `inflate returned error
-3` and writing *nothing* to `-progress`, so the progress bar would also sit
still. With `-xerror` the same input exits immediately and the stderr tail names
the decode failure. `render.smoke.test.ts` covers this case explicitly.

### Provider credentials

Every asset provider degrades to a documented configuration state rather than to
fake output (§48). `GET /api/config/providers` reports what is and is not
configured, and `/api/video/build` refuses up front — with the variable's name —
instead of failing three stages later.

| Variable | Stage | Missing behaviour |
|---|---|---|
| `VOICE_PROVIDER` + `ELEVENLABS_API_KEY` | Voiceover | Build refused at the route with `503` |
| `VISUAL_PROVIDERS` + `PEXELS_API_KEY` / `RUNWAY_API_KEY` | Visuals | Falls through the priority list; a scene with no source fails as `asset_missing` |
| `MUSIC_PROVIDER` + `FREESOUND_API_KEY` | Music | Rendered without a bed |
| `TRANSCRIPTION_PROVIDER` + `OPENAI_API_KEY` / `DEEPGRAM_API_KEY` | Captions | Rendered without captions |
| `RENDER_PROVIDER` (+ per-provider keys) | Render | `ffmpeg` needs no credential at all |

`VIDXIR_USE_MOCK_PROVIDERS=true` makes every provider synthetic — real PNG and WAV
bytes, generated in-process — and is the only way tests obtain assets. It is
refused when `NODE_ENV=production`, so it cannot be the reason a paying user's
video is silence over a solid colour (§40).

### Remote assets

Provider URLs are fetched through `lib/providers/fetch`, not `fetch` directly:
private and link-local address ranges are rejected after DNS resolution,
redirects are re-validated rather than followed blindly, the declared content type
must match what the stage asked for, and a size ceiling is enforced while
streaming so a provider cannot fill the disk (§34).

---

## Thumbnails

A generation produces **four** concepts and composites a real 1280×720 JPEG for
each. The concepts come from Claude, reading the finished script — the same brief
the metadata stage uses, plus the channel's niche, audience and brand palette, and
a list of headlines already tried on this project so a second run does not return
the first run's ideas in a different order.

Generation requires a **finished render**, not just a script. That is not a policy
choice: `THUMBNAIL_GENERATING` is only reachable from `VIDEO_READY`,
`READY_TO_PUBLISH` and `FAILED`, and the prerequisite is checked against the
`renders` table rather than against the project's status label, because a `FAILED`
project can reach this state having never produced a video.

The background for variant 0 is the render's own poster frame when the render
produced one (`renders.poster_asset_id`); the rest come from the stock library
through the same `acquireVisual` path the video pipeline uses, so licence,
attribution and provider are recorded per asset. Nothing downloads a third party's
YouTube video (§29).

Headline text is drawn by ffmpeg's `drawtext` from a **`textfile=` with
`expansion=none`**, never as an inline `text=` argument. A model-written headline
can contain `:`, `'`, `%` or `\`, each of which changes the meaning of a filter
argument; routing it through a file makes it data rather than syntax and removes
the whole class of escaping bugs. The output is re-encoded down a quality ladder
until it fits YouTube's 2 MB ceiling, and a variant that cannot be made to fit
fails rather than producing bytes the upload would reject.

Each variant composites independently. One failed background download leaves that
row with `image_asset_id` null — the studio then says *"Image not rendered"* rather
than drawing a placeholder (§42) — while the other three keep their images. Only
when *all four* fail does the stage error, as `asset_missing`.

A failure never moves the project to `FAILED`. It returns to whichever of
`VIDEO_READY` / `READY_TO_PUBLISH` it came from and records the reason on the
`thumbnails` row, because a rendered video that is one step from publishing should
not look broken on account of a thumbnail.

`POST /api/thumbnails/select` refuses a variant with no composited image. Selecting
a concept whose picture does not exist would publish a video with no thumbnail
while the UI showed a tick beside it.

### Credential

Concepts need a configured [AI provider](#ai-provider); backgrounds need a
configured visual provider.
The third requirement is a **font file**, which is where thumbnails differ from
captions: `drawtext` needs a path, while libass takes a font *name* and lets
fontconfig resolve it.

Nothing is bundled — Oswald and Inter reach the browser through a Google Fonts
`@import`, which is no use to a worker, and a licensed TTF does not belong in the
repository. A well-known system font is used when one is found (Impact or Arial
Bold on Windows, DejaVu Sans Bold on Debian/Ubuntu). Otherwise the `thumbnail`
capability reports `not_configured` and the route refuses with `503`.

| Variable | Purpose | Missing behaviour |
|---|---|---|
| `THUMBNAIL_FONT_FILE` | Headline face | A system font is searched; if none is found, generation is refused |
| `THUMBNAIL_FONT_FILE_BODY` | Subline face | Falls back to a system body font, then to the headline face |

Set both in production: the system font that happens to exist on the host is not
the channel's brand face. A path that is set but does not exist is reported as
`not_configured` and does **not** fall back to the system search — an operator who
names a file means that file. In a slim image, `apt-get install -y
fonts-dejavu-core` provides one at
`/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`.

---

## Billing

One rule, and everything else follows from it: **a plan tier changes only because a
signature-verified Stripe event said the money moved.**

`POST /api/billing/checkout` returns a Stripe-hosted URL and writes nothing. Its
response says `tierGranted: false` in as many words, because the client must not be
able to read a successful call as an upgrade — a user who follows the URL, abandons
the page and comes back is still on Starter, which is the correct outcome (§24, §42).
The body names a **tier**, never a price id; price ids come from the server's
environment, since a caller who could name a price could name a free one.

`src/lib/billing/webhook.ts` is the only code in Vidxir AI that can write
`subscriptions.tier`. Four properties, each corresponding to a way real webhooks go
wrong:

- **Signature first.** The route reads `request.text()` and verifies the HMAC before
  the body is parsed. Anyone can POST to a public webhook URL; the signature is the
  only thing separating Stripe from someone granting themselves Scale with one curl.
- **Idempotent.** Stripe redelivers on any non-2xx and guarantees only at-least-once
  delivery. The unique index on `billing_events (provider, provider_event_id)` makes
  a redelivery lose its insert, and a lost insert means the change is not applied
  twice. `onConflictDoNothing` rather than a read-then-write, so two concurrent
  deliveries of one event cannot both decide they are the first.
- **Order-independent.** Delivery order is explicitly not guaranteed. The
  `subscriptions.last_event_at` comparison lives **inside** the UPDATE's `WHERE`, so
  an older `customer.subscription.updated` arriving after a newer one is recorded and
  skipped rather than silently reverting the tier.
- **Tier from the price, not from metadata.** `vidxirTier` metadata is written at
  checkout and is only a hint; the authoritative tier is whichever configured price
  the subscription is actually on. If the two disagree — someone switched plans in the
  portal — the price wins, because that is what the customer is being charged for. A
  price this deployment does not sell grants **Starter**, never the highest tier.

Failed payments really do remove access. `past_due`, `unpaid`, `canceled`,
`incomplete` and Stripe's `paused` (mapped to `unpaid`, since no access is no access)
all keep the recorded tier but `currentTier()` refuses to honour it — so a cleared
payment restores the right plan instead of dropping the customer to Starter
permanently.

The webhook route is the one route not wrapped in `handle()`. That wrapper's
`assertSameOrigin` rejects requests with no `Origin` and no same-origin
`Sec-Fetch-Site`, and Stripe is a server: it sends neither, so every delivery would
be refused. The HMAC replaces CSRF protection and does more than it did — CSRF
defends against a browser being tricked into sending a request, whereas the signature
proves the request came from Stripe at all.

Status codes are chosen for Stripe's retry behaviour: **200** for anything verified
and processed *including* duplicates, stale deliveries and unused event types (a
non-2xx would make Stripe redeliver forever and eventually disable the endpoint);
**403** for a failed signature, which Stripe does not retry, correctly — a body that
fails the HMAC will never start passing it; **503** when the signing secret is unset,
so an operator who sets it recovers the backlog; **500** when a genuine event failed
to process, so Stripe retries with backoff for up to three days.

Card changes, invoices, plan switches and cancellation all happen on Stripe's hosted
pages via `POST /api/billing/portal`. That is deliberate rather than lazy: Vidxir AI never
receives a card number, so there is no cardholder data in this codebase to protect,
and cancellation is always available without Vidxir AI mediating it. A second checkout for
an account that already pays is refused with `409` — Stripe would happily bill two
subscriptions in parallel — so plan *changes* go through the portal, which swaps the
price on the existing subscription.

### Credential

| Variable | Purpose | Missing behaviour |
|---|---|---|
| `BILLING_PROVIDER` | `stripe` or `mock` | Defaults to `mock`, which can never grant a paid tier |
| `STRIPE_SECRET_KEY` | API calls | Checkout and portal return `503` naming it |
| `STRIPE_WEBHOOK_SECRET` | Signature verification | No upgrade button is offered at all |
| `STRIPE_PRICE_STUDIO` | Studio price id | Studio is not purchasable |
| `STRIPE_PRICE_SCALE` | Scale price id | Scale is not purchasable |

`canUpgrade()` requires the **webhook secret** as well as the key and the prices,
because checkout without a verified webhook is the worst available state: the customer
is charged and nothing ever grants them the plan. Better to offer no button and say
which variable is missing (§48). `VIDXIR_USE_MOCK_PROVIDERS=true` resolves billing to
`mock`, which never reports configured — a development build must not be able to hand
out paid tiers (§40).

Local setup, once the products exist in the dashboard:

```bash
stripe listen --forward-to localhost:3000/api/billing/webhook
```

That prints the `whsec_…` value for `STRIPE_WEBHOOK_SECRET`. Point the production
endpoint at `/api/billing/webhook` and subscribe it to
`checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`invoice.payment_succeeded` and `invoice.payment_failed`. Any other event type is
recorded and acknowledged.

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
docker exec vidxir-postgres createdb -U vidxir vidxir_test
TEST_DATABASE_URL=postgresql://vidxir:vidxir@localhost:5432/vidxir_test \
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

Integration runs use their own Redis namespace (`QUEUE_PREFIX=vidxir-test`, set in
`tests/integration/setup.ts`). Without it a test run enqueues real BullMQ messages
into the development namespace and then truncates the `jobs` rows they point at,
so a developer's worker wakes up to hundreds of jobs it can never complete.

### What the test suite cannot check

`vitest.config.ts` aliases `server-only` away, so a module graph that could never boot
passes green — that gap hid real defects twice, once behind 541 passing tests. Every
script below runs with no aliases, in a real Node process, against real
infrastructure. None is a substitute for the suite; each covers something the suite
cannot reach by construction.

```bash
npm run verify:worker           # the standalone worker boots and runs a job
npm run verify:automation       # the scheduler's queries, cadence maths and publish queue
npm run verify:billing          # the billing schema, idempotency index and HMAC
npm run verify:analytics        # the analytics schema, revenue precision and experiment policy
npm run verify:hardening        # the sixteen production safety invariants
npm run verify:video-providers  # the video model layer is honest about what it can do
npm run verify:credits          # the ledger, the prices and the money, end to end
npm run verify:editor           # a real project opens, edits, saves and exports to MP4
npm run verify:continuity       # the continuity check and regeneration stages really run
npm run verify:abandoned-source # a never-analysed source id reaches no screen
```

All ten are free: they reach this deployment's own Postgres, Redis and MinIO, and no
paid API. Three of them prove it rather than promise it — `credits` and `continuity`
audit `api_usage` at the end to show no billable call was made, and `video-providers`
asserts against its own source that it contains no network call, upload, publication or
database write at all. One script is different:

```bash
npm run verify:providers    # one real call per configured provider — SPENDS MONEY
```

`verify:providers` is the only script here that bills anything. It is also the only
one that can answer "does this key work", which is why it exists — but run it
deliberately, not as part of a sweep.

**`verify:worker`** runs the worker's boot path in a real Node process: env,
BullMQ, Postgres, the provider layer, and one deterministic `maintenance` job
enqueued through the real `enqueue()`, consumed by a real `Worker`, and asserted
to reach `succeeded` on its `jobs` row. Vitest cannot cover this, because Vitest
*is* the thing that hides it — it aliases `server-only` and transpiles to
CommonJS, so a module the worker cannot actually load imports fine under test. Two
defects lived in that gap: every shared module carried `import "server-only"`
(whose Node implementation throws unconditionally), and `ffmpegBinary()` used a
bare `require`, which is undefined under ESM. The worker could not start, and once
it could, it reported `render: not_configured` on a machine with a working
encoder. 541 tests were green throughout. It uses `QUEUE_PREFIX=vidxir-verify` and
obliterates the queue afterwards.

**`verify:providers`** makes one cheap real call per provider — a sentence of
narration, a two-second clip, one search page. The unit tests pin every adapter
against recorded responses, which proves the parsing and the error taxonomy; they
cannot prove a key is accepted, an account is funded, a model id still exists, or
that a response shape has not drifted since the fixture was recorded. It reads
`.env.local` exactly as the app does, overrides `VIDXIR_USE_MOCK_PROVIDERS` for the
run (verifying a mock would prove nothing — §42), and leaves the per-provider
selectors alone, so `VOICE_PROVIDER=mock` honestly reports *not configured* rather
than silently upgrading to a paid provider. Exit is non-zero only for a
*configured* provider that failed; "not configured" is a documented state (§48).

The transcription check synthesises its audio through the voice provider rather
than using a silent WAV. That was the first attempt and it was wrong:
`transcribe()` deliberately rejects an empty cue list, because in the pipeline
that means a truncated upload, so verifying with silence reported a failure for a
perfectly good key. Synthesising first costs a few cents and proves more — it is
the same composition the captions stage performs.

**`verify:automation`** and **`verify:billing`** cover the same gap for the scheduler
and the billing path. Both exist because of a defect the suite could have missed:
`dueChannels` interpolated a `Date` into a raw `sql` template, which postgres.js
rejects at Bind, so the scheduler's first query threw on every tick. Billing has one
raw `sql` fragment of the same kind — the `last_event_at` comparison — so
`verify:billing` executes it against real Postgres, then proves the unique event index
genuinely rejects a redelivery (the whole idempotency story rests on
`onConflictDoNothing` returning zero rows, and nothing else would notice if a
migration dropped that index), that an unrecognised price maps to no tier, and that
the real HMAC accepts a signed body and rejects one edited after signing. It makes no
Stripe API call: it creates no customer, no session and no subscription, so it cannot
charge anyone, and it writes only to `billing_events` under a synthetic provider name
that it deletes again.

**`verify:hardening`** proves the sixteen safety invariants of §24 in one real
process: the production configuration guards, the database timeouts and migration
state, credential storage, cross-tenant refusal, the route-level authorization and
validation audit, the atomic rate-limit window, worker retry classification and
enqueue idempotency, distributed locking with stale recovery, webhook
signature/replay/idempotency, the error taxonomy, response and log redaction, the
liveness/readiness split, and the production/mock guards.

Two of those are checked structurally rather than by import, and deliberately.
`lib/api/guard` and `lib/api/rate-limit` carry `server-only`, so the script reads the
uuid pattern and the Redis Lua window out of their own source and exercises those —
a change to the real ones changes what it proves — and audits every route file for
the guard, validation and rate-limit calls it must make. That static audit is the
stronger check anyway: it covers every route under `src/app/api` rather than whichever
one a runtime probe happened to touch, so a route added later without a guard fails the
script. The count is discovered rather than fixed — 52 at the time of writing, and the
script prints the figure it found, along with how many are session-guarded, have their
mutations rate-limited and validate their bodies with zod.

The production guards run in child `tsx` processes, because proving them in-process
would mean setting `NODE_ENV=production` and poisoning every later step. A fresh
process parsing a fresh environment is what a deployment actually does.

It performs no upload, no publication, no Stripe charge, checkout, subscription or
portal session, and touches no credential. The only external systems it contacts are
this deployment's own Postgres and Redis; every write is namespaced and removed in a
`finally`, so a failed run leaves nothing behind either. Where a dependency is
genuinely absent it reports `NOT_CONFIGURED` and names what was therefore not proven
— currently only the client-bundle scan, which needs a `npm run build` first.

**`verify:video-providers`** asks a different question of the video layer than
`verify:providers` does, because the obvious one is not askable: §24 forbids a live
generation request, and one premium clip costs real money. So instead of "does the
credential work", it proves the layer **tells the truth about what it can do and
refuses everything else** — which is where this layer's failures actually live, and
they are all quiet ones. A provider that reports itself ready without a key produces a
500 after the user has waited through scripting. A registry that accepts an unknown
model id interpolates a client string into a vendor URL. A picker payload carrying a
credential leaks it to every browser that opens the page. None of those fail a unit
test that mocks the environment; all are visible to a process reading the real one.

Fifteen checks. Steps 1–10 run with mocks *off* — the honest reading of a deployment
that has configured nothing — and 11–13 turn them on, since that is the only way to
exercise the generation path for free. Two are worth naming: step 5 audits the source
for a vendor name in any customer-facing label and for any client string reaching a
request path, and step 6 refuses an undeclared resolution rather than snapping it to a
supported one. Step 15 asserts against this script's own source that it performs no
network call, upload, publication, database write or child process.

**`verify:credits`** proves the money and the numbers agree, in a real process against
real Postgres. Sixteen checks: every plan's included credits ascend with price, every
model the *live* registry resolves has an explicit price at every quality, a charge
lowers the balance by exactly the figure a picker would have quoted, a replay charges
nothing, an unaffordable charge is refused with a 402 naming no vendor and writing no
row, **eight concurrent charges against a balance of three spend exactly three**, a
refund returns what was charged however many times it is called, and the ledger
reconciles against the balance after every one of those.

It is free because it charges for generations that never happen — the credit service
takes no provider argument and reaches no network. Step 14 calls
`completeCreditPurchase` directly, handed a session id and a payment status exactly as
a verified webhook event would hand it one, so a top-up is exercised with no Stripe
call anywhere in the file. Step 16 audits `api_usage` afterwards to prove the run was
inert. Everything it writes belongs to two fixture tenants, reset at the start of each
run — including `credit_purchases`, whose unique session key made an earlier version
single-use.

**`verify:editor`** runs the editor against a real generated project, in fifteen checks
built around **one real export** — save → export → `RENDER_JOB` → real Worker → real
ffmpeg → MP4 — after which it asserts the resulting file is playable and that its own
header duration reflects the edit. In between, every gesture the UI dispatches (move, trim,
split, duplicate, delete, text, volume, undo, redo) is the same `applyOperation` call
the components make, a stale save and a malformed save are both refused without
touching the row, and another tenant can neither open nor save the cut.

`RENDER_PROVIDER` resolves to `ffmpeg`, so the export is a local encode: no provider
call, no quota, nothing published. It reads the source project's rows, duplicates them
under a fixture user, and edits the *copy* — so the real project's status, renders and
`project_edits` are never touched, which step 7 asserts rather than assumes, and the
copy is a genuine second tenant, which is what makes the isolation checks real.

What it does not prove is the browser layer — that pointer capture drags, that
`<video>` seeks, that the rAF clock advances. There is no browser driver in this repo,
so those are reported as hand-checked rather than claimed.

**`verify:continuity`** proves the two continuity stages really run through the shipped
`HANDLERS` map and a real BullMQ `Worker`, against real Postgres, Redis and MinIO. The
suites cover the arithmetic and the persistence; what nothing under vitest can prove is
that the registry those two new entries live in can be loaded by the process that
consumes the queue. Eighteen checks: the check scores a video a `fail`, the verdict
lands in `quality_checks`, regeneration is enqueued **for exactly the failed scenes**,
each repointed scene gets a new asset and an incremented counter while the untouched
scene is left alone, and the project never leaves `VIDEO_READY` — continuity cannot
fail a paid render.

Three of them are about cost, and they are the reason the script is worth running: a
re-check reads the constraints the redraw actually carried, so the repaired scenes pass
and **nothing is re-billed**; a further re-run with no regeneration between scores
identically (§12's determinism, end to end, on inputs that genuinely did not move); and
the regeneration ceiling refuses a further attempt and spends nothing.

Mocks are forced on at module scope, so each regeneration is a PNG synthesised
in-process — step 1 asserts that rather than assuming it, and a later step audits
`api_usage` to prove no real backend was reached. The planner is deliberately *not*
exercised: `planContinuity` reaches a model through `generateJson` and `lib/providers/ai`
has no mock branch, so calling it would be a real billable request. The bible and scene
states are seeded directly instead.

**`verify:abandoned-source`** answers a question a fixture cannot: "is that raw video id
still on my screen?" The distinction it enforces is *a user submitted a URL* ≠ *Vidxir AI
successfully analysed the source* — `projects.source_video_id` is written the moment a
link is pasted, before any worker runs, so its presence proves the first and never the
second. It loads real rows through the same server functions the pages call —
`getProject`, `getLinkStudioData`, `getStageContext`, `buildBrief`, `buildScriptPrompt`,
`getOverview` — and scans what comes back, including the exact prop expression each page
evaluates and the fully rendered provider prompt, which is the one path where this bug
reached a model rather than a screen.

It audits every channel-less link-seeded project by default, or one named on the
command line:

```bash
npx tsx scripts/verify-abandoned-source.ts <project-id>
```

Read-only and free: it opens no queue, enqueues nothing and writes no row, asserted at
the end by re-reading `updated_at` and comparing it to what was read first. It does not
rewrite the offending rows either — the fix is in the reads, because §9 asks for the
failure history to be preserved.

### Why lint, not `server-only`

`server-only` is a bundler directive, not a runtime guard: its package exports
resolve to an empty module under Next's `react-server` condition and to a module
that throws unconditionally everywhere else. A shared module carrying it is
therefore unimportable by the standalone BullMQ worker, which is a plain Node
process — and the worker legitimately needs `env`, `db`, the queue and every
provider, since running the pipeline is its entire job.

So the client-bundle boundary (§34) is enforced by `no-restricted-imports` in
`eslint.config.mjs`, which applies to both runtimes and names the offending line.
`allowTypeImports` is on deliberately: `import type` is erased by the compiler, so
a view type shared between a server page and the client component it renders
carries no runtime code.

Four modules still carry the marker, and only these four — `lib/api/guard`,
`lib/api/rate-limit`, `lib/auth/session` and `lib/channels/oauth-state`. Three of
them import `next/server` or `next/headers` and cannot run outside a Next request at
all. `lib/api/rate-limit` imports nothing from Next, but keeping the marker there
costs nothing: no background process needs it.

The same question decided two Phase 10 changes the other way, and the deciding test
was always *does a Node entrypoint need this module*:

- **`lib/health` lost the marker.** It imports nothing from Next, and it defines a
  `worker` readiness mode — which the worker could not use, because the marker made
  the module unimportable by the one process that needed it. `@/lib/health` was added
  to the `no-restricted-imports` group in the same change, so the client-bundle
  boundary is unchanged.
- **`pruneSessions` moved out of `lib/auth/session`** into `lib/auth/session-maintenance`.
  That one was not a design question but a live defect: the scheduler imported it from
  the marked module, so `npm run scheduler` died at its first import — before its
  logger existed. Session pruning, channel-stats refresh, analytics ingestion and
  every automation tick had never run. `lib/auth/session` re-exports it, so nothing
  else changed. The prune touches no cookie, header or request; it never belonged
  behind the marker.

Both are covered by tests that spawn the real entrypoints as `tsx` processes rather
than importing them, since a test that imports them runs under vitest's
`server-only` alias and proves nothing about `npm run worker`.

Running the worker under `--conditions react-server` was considered and rejected.
It would make a plain Node process claim to be a React Server Components runtime,
so any dependency shipping a `react-server` entry point would hand the worker a
*different implementation* than the web app runs — a silent divergence between
what renders a video and what serves the page, which is worse than the crash it
would paper over.

### Dependency advisories

`npm audit` is not clean, and that is a considered position rather than neglect. Every
advisory below was checked for reachability in this codebase; the deciding question was
always whether the vulnerable code path is one Vidxir AI executes.

**Runtime, not reachable:**

- **`drizzle-orm` <0.45.2 — high, SQL injection via improperly escaped identifiers.**
  Requires attacker-controlled SQL *identifiers* (table or column names). Vidxir AI has
  zero `sql.identifier` and zero `sql.raw` calls; every identifier is a compile-time
  constant from `lib/db/schema`, and every value is a bound parameter. See below for
  why the fix is not applied.
- **`sharp` <0.35.0 — high, inherited libvips CVEs**, via `next`. Reached only through
  the `next/image` optimizer, which Vidxir AI does not use — nothing imports the component
  and no `images` config is set. (`_next/image` appears in the `middleware.ts` matcher
  as an exclusion, and `next.config.ts` computes a CSP `img-src` list; neither invokes
  the optimizer.) Thumbnail rendering uses Vidxir AI's own direct `sharp` dependency, on
  images Vidxir AI generated itself.
- **`uuid` <11.1.1 — moderate, missing buffer bounds check**, via `googleapis`. Only
  affects v3/v5/v6 with a caller-supplied `buf`. Vidxir AI calls `randomUUID()` from
  `node:crypto`.
- **`postcss` — path traversal via `sourceMappingURL`**, via `next`. A build-time CSS
  processing path, on CSS in this repository.

**Development-only, not shipped:** `vitest` (critical — but only *when the Vitest UI
server is listening*, and `@vitest/ui` is not installed and never started), `vite`,
`esbuild`, `drizzle-kit`. None is in `dependencies`; none runs in production.

#### The `drizzle-orm` upgrade was tested and rejected

Not waved away — installed, and reverted on evidence. `0.45.2` typechecked cleanly and
all 647 unit tests passed, but two integration tests failed, and the cause matters more
than the count: **0.45.x wraps driver errors in a `DrizzleQueryError`**, moving the
Postgres `SQLSTATE` from `error.code` to `error.cause.code`.

`asDatabaseError` classifies on `code` + `severity`. With the SQLSTATE one level
deeper, it stops seeing it — so a unique violation classifies as `internal_error`
instead of a conflict, and a dropped connection (`08006`) stops being **retryable**.
Two concrete regressions, both worse than the advisory they would fix:

- A concurrent duplicate publication returned an unclassified 500 instead of a 409.
- Recoverable database blips would have been treated as permanent failures, so the
  worker would abandon work a retry would have completed.

The wrapper also stringifies the failing statement *and its bound parameters* into the
error message, which is a new leak surface for anything that logs an error message
directly (§14).

Fixing this is a real change to the error taxonomy plus new tests — §19 permits an
upgrade only when compatibility is understood *and* tests prove the application still
works, and a change that silently makes database failures non-retryable is the
opposite of hardening. So the version stays at `0.38.4`, the advisory is documented as
unreachable, and the upgrade is scoped as its own work with the taxonomy change it
requires. `verify:hardening` asserts the current classification, so whoever does that
upgrade will see these two properties break immediately rather than in production.

---

## Deployment

Vidxir AI is three processes against three stateful dependencies. Nothing here assumes a
particular host: they are ordinary Node processes and can run wherever that works.

| Process | Command | Scale | Notes |
| --- | --- | --- | --- |
| Web | `npm run build` then `npm run start` | Horizontal, freely | Stateless. Sessions live in Postgres, not in memory. |
| Worker | `npm run worker` | Horizontal, freely | BullMQ distributes; concurrency per queue is in `worker/registry.ts`. |
| Scheduler | `npm run scheduler` | Horizontal, but see below | Safe to run more than one — each task takes a Redis lock per tick — though one is enough. |

Two replicas of the scheduler is a supported configuration rather than a hazard, and
that is deliberate: it is what makes a rolling restart safe. Overlap is prevented
twice over — an in-process `Set` stops a slow pass stacking behind itself, and a Redis
lock stops a second replica running the same task on the same tick. Automation has a
third guard underneath both: it claims each channel's slot with a conditional
`UPDATE`, so even a lock failure cannot double-start a video.

### Required configuration

Six variables have no default, and the process **refuses to boot** without them —
deliberately, since a half-configured backend degrades into exactly the fake
behaviour §42 forbids:

```
DATABASE_URL           ENCRYPTION_KEY          S3_BUCKET
REDIS_URL              SESSION_SECRET          S3_ACCESS_KEY_ID
                                               S3_SECRET_ACCESS_KEY
```

`ENCRYPTION_KEY` and `SESSION_SECRET` are each 64 hex characters (32 bytes):
`openssl rand -hex 32`. **`ENCRYPTION_KEY` cannot be rotated casually** — it decrypts
every stored OAuth token, so changing it invalidates every connected channel and every
user has to reconnect YouTube. Treat it as permanent unless you are prepared to
re-authorise the entire user base.

Four further guards apply in production only, each a refusal to start rather than a
warning, because none of these is visible in a smoke test:

- `VIDXIR_USE_MOCK_PROVIDERS` must be `false`. Otherwise Vidxir AI fabricates voiceovers
  and visuals for paying customers (§40).
- `EMAIL_PROVIDER` must not be `console`, which prints every verification and reset
  email to stdout.
- `BILLING_PROVIDER=stripe` requires **both** `STRIPE_SECRET_KEY` and
  `STRIPE_WEBHOOK_SECRET`. Live billing config is explicit, never inferred: with only
  the first, checkout takes money while signature verification has nothing to verify
  against.
- `APP_URL` must be `https`. Session and OAuth cookies are issued `Secure` and a
  browser will not return them over `http` — the symptom is a login that appears to
  succeed and then doesn't.

`npm run verify:hardening` exercises all of these in child processes and fails if any
is accepted. Provider credentials are all optional: a missing key surfaces as a
`not_configured` state in the UI, never as a fallback to fakery (§48).

### Migrations

```bash
npm run db:migrate     # apply; idempotent, safe to run on every deploy
npm run db:generate    # author a new migration from the schema
```

Additive and forward-only. Run migrations **before** starting the new web and worker
processes: every migration so far adds tables, columns or indexes, so an old process
against a new schema is fine, while a new process against an old schema is not. There
is no down-migration path — a bad migration is corrected by a new one.

Do not hand-edit anything in `drizzle/`. The `_journal.json` file and the applied-set
in `drizzle.__drizzle_migrations` have to agree; `verify:hardening` checks that they
do, because a partially-migrated database produces the most confusing possible
failures — a route that works until it touches the one column that is missing.

### Health and readiness

Two endpoints, and the distinction matters operationally:

| Endpoint | Question | Failure means |
| --- | --- | --- |
| `GET /api/health` | Is this process alive? | Restart the container. |
| `GET /api/ready?mode=web` | Can this instance serve traffic? | Drain traffic; do not restart. |

Point the **liveness** probe at `/api/health` and the **readiness** probe at
`/api/ready`. Liveness consults nothing external, on purpose: if it touched Postgres,
one database blip would restart every replica in the fleet simultaneously.

`mode` selects which dependencies count. `web` wants Postgres and treats Redis as a
degradation; `worker` requires both, since a worker without Redis has nothing to
consume; `full` checks everything. Readiness returns `200` when ready and `503`
otherwise, and unconfigured *optional* providers never make an instance unready — an
unset ElevenLabs key is a product state, not an outage.

The response carries dependency names and statuses only. Set `HEALTH_PROBE_TOKEN` and
pass it as `x-vidxir-probe-token` to see the `detail` strings and mode flags; without
it, in production, they are withheld. Neither endpoint ever includes a connection
string, a token or an environment value.

### Startup order

1. Postgres, Redis and object storage reachable.
2. `npm run db:migrate`.
3. Worker and scheduler. Both run a dependency preflight and log one legible line
   before consuming anything. It is intentionally **non-fatal**: a supervisor
   restarting into an outage produces a crash loop, and BullMQ's own reconnect
   handles a Redis blip better than a restart does.
4. Web tier, once `/api/ready` returns `200`.

### Shutdown

All three handle `SIGTERM` and `SIGINT`. The worker stops accepting jobs and lets
in-flight ones finish — a stage killed mid-flight leaves a project stuck between
states, which is what the persisted state machine exists to avoid. The scheduler
clears its timers and waits up to 15 seconds for a running pass. Allow **at least 60
seconds** of termination grace; a render is the long pole.

An uncaught exception logs through the logger and then exits, in both background
processes. Exiting is the point: after an uncaught throw the process state is unknown,
and a worker that keeps pulling jobs in an unknown state fails them one at a time
until the retry budgets are gone. The supervisor restarts it, BullMQ returns the
in-flight job when its lock lapses, and the durable `jobs` row means nothing vanishes.

---

## Backup and recovery

What an operator needs to know to rebuild this deployment. No script here performs a
backup or a restore — that belongs to whatever runs the database.

### What is stateful

| Store | Contents | If lost |
| --- | --- | --- |
| **Postgres** | Everything durable: users, sessions, channels (with encrypted OAuth tokens), projects, scripts, jobs, analytics, subscriptions, billing events | Unrecoverable. This is the backup that matters. |
| **Object storage** | Rendered video, audio, thumbnails, uploaded assets | Rows survive and point at missing keys. Recoverable only by re-rendering. |
| **Redis** | Queue messages, rate-limit counters, scheduler locks | **Not a backup target.** See below. |

Redis is deliberately not backed up. Every queue message has a durable `jobs` row
behind it — `enqueue()` writes Postgres *before* pushing to Redis, and the BullMQ job
id equals the row id, which is what makes a repeated push idempotent. Rate-limit
counters and scheduler locks are meant to expire. A flushed Redis costs in-flight
jobs, which are visible in `jobs` and can be requeued; it loses no durable state.

### Restore order

1. **Postgres**, from your snapshot. Then `npm run db:migrate` — the dump may predate
   the current code.
2. **Object storage**, from its own snapshot. Independent of the database, but restore
   both to the *same* point in time or rows will reference keys that never existed.
3. **Redis**: create it empty. Do not restore it. A stale queue replayed against a
   restored database re-runs work that already completed.
4. **Configuration** — all six required variables, and `ENCRYPTION_KEY` must be the
   *same value* the dump was written with. A restored database with a different key is
   a database whose channel tokens cannot be decrypted, and there is no recovery from
   that beyond every user reconnecting.
5. **Verify** before serving: `npm run verify:hardening`, then `/api/ready`.

### External dependencies that do not come back with a restore

- **YouTube OAuth.** Grants live in the restored rows, so they survive — but only
  while the Google client credentials are unchanged. Restoring against a different
  OAuth client, or a revoked one, means every channel needs reconnecting. Vidxir AI
  handles this honestly rather than silently: a rejected refresh sets the re-auth flag
  and the UI prompts, so the failure mode is a reconnect prompt rather than silent
  breakage.
- **Stripe webhooks.** The endpoint URL and its signing secret live in the Stripe
  dashboard, not in this repository. A new deployment URL means a new endpoint and a
  new `STRIPE_WEBHOOK_SECRET`. Missed deliveries during downtime can be replayed from
  the dashboard: `billing_events` has a unique index on
  `(provider, provider_event_id)`, so replaying is safe — a duplicate is recorded and
  skipped, never applied twice.
- **Provider accounts.** API keys are configuration, not data. An exhausted balance
  restores as an exhausted balance, and reports as `provider_out_of_credit` — a state
  an operator clears, distinct from a bug.

### Recovery-time reality check

The database is the only irreplaceable component. Rendered media is expensive to
regenerate but reproducible from the rows describing it; queue state is designed to be
disposable. Set the Postgres snapshot interval by how much user work you are willing
to lose, and test that a snapshot actually restores — an untested backup is a
hypothesis.

---

## Non-negotiables

These are enforced in code, not by convention:

- **Passwords** are scrypt hashes with per-user salts. The plaintext is never
  stored, logged, or recoverable.
- **OAuth tokens** are AES-256-GCM encrypted at rest and never serialised to the
  frontend. Vidxir AI asks for a Google authorisation, never a YouTube password.
- **Provider API keys** are server-side only. Nothing that reads `env()` can be
  imported into a client component — the `no-restricted-imports` rule in
  `eslint.config.mjs` makes that a lint error. See
  [Why lint, not `server-only`](#why-lint-not-server-only).
- **Plan entitlements** are read from the `subscriptions` table on every check.
  A request body claiming a tier grants nothing.
- **`PUBLISHED`** is reachable only from `PUBLISHING`, i.e. after YouTube has
  confirmed the upload. The state machine makes any other path unwritable.
- **Progress** always reflects real job state. Where a provider reports no
  percentage the UI shows an indeterminate indicator rather than an invented one.
- **Originality**: Vidxir AI generates original content from trend research. It does
  not download or republish other people's videos.
- **Tenant isolation** is part of every query predicate, and covered by tests
  that hold a valid id from another account and confirm it is refused.

See `.env.example` for the full, commented configuration surface.
