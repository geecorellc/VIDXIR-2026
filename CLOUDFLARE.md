# Cloudflare deployment

For the remaining AI/media provider keys and model selectors, see
[PRODUCTION_ENV.md](PRODUCTION_ENV.md).

The public app uses **https://app.vidxir.com**. Cloudflare Custom Domains manage
its DNS and TLS. Wrangler is authenticated on this machine; on another machine,
run `npm run cf:login`, then `npm run cf:whoami`.

## Cloudflare services

| Purpose | Service | Configuration |
| --- | --- | --- |
| Next.js frontend/API | Workers + OpenNext | `wrangler.jsonc`, Worker `vidxir` |
| Database | D1 | `vidxir-production` |
| Private media | R2 | `vidxir-media-production` |
| Background delivery | Queues | Research, pipeline, publish, analytics, maintenance |
| Locks and rate limits | SQLite Durable Objects | `Coordination` in `vidxir-backend` |
| Durable job ownership/retries | SQLite Durable Objects | `JobRunner` in `vidxir-backend` |
| Video and thumbnail processing | Containers | Node 22, FFmpeg, DejaVu fonts |
| Scheduled work | Cron Triggers | Every five minutes; tasks keep their own intervals |

The runtime uses these native bindings. No production Postgres, Redis, S3 access
keys, Render, Neon or Upstash account is needed. The old PostgreSQL schema and
verification tooling are retained for reference; they are not the active runtime.

A job is written to D1 before sending its queue message. The consumer acknowledges
a message after its Durable Object has persisted delivery ownership. Alarms manage
delays, retries, crash recovery and status polling. Duplicate deliveries reuse the
same durable owner. Shared execution leases cap active job containers at five;
queued jobs are admitted in plan-priority order. Individual jobs have a one-hour
execution limit. Containers sleep after inactivity; their local files are temporary.

Containers access D1, R2, queues and coordination through a private outbound HTTP
intercept to the backend Worker. The backend has no public route or workers.dev
URL. Private media stays in R2 and is served through expiring signed `/api/media`
URLs on the app origin, including byte-range reads for video playback.

## Operator secrets

The operator chose to configure secrets manually. No production secrets have been
uploaded by this migration. Add the following as **Secret** variables in Cloudflare
Dashboard → Workers & Pages → each Worker → Settings → Variables and Secrets:

| Secret | `vidxir` | `vidxir-backend` |
| --- | --- | --- |
| `ENCRYPTION_KEY` | Required | Required; use the identical value |
| `SESSION_SECRET` | Required | Required; use the identical value |
| `RESEND_API_KEY` | Required for auth email and reading received email | Required for queued support replies and admin campaigns |
| `RESEND_WEBHOOK_SECRET` | Required for signed incoming/delivery webhooks | Not needed |
| AI/provider credentials | Required for enabled features | Same credentials for background generation |
| Google OAuth credentials | Required for channel linking | Same credentials for channel jobs |
| Stripe credentials | Required only when billing is enabled | Set for any background billing use |

Generate two distinct random 32-byte keys (64 hexadecimal characters). Keep the
same encryption key and session secret on both Workers. Changing the encryption
key after credentials have been stored requires a data/key migration; changing
the session secret invalidates existing sessions and media links.

Two generated keys are already prepared on this machine in a private local file,
`/private/tmp/vidxir-cloudflare-core-secrets.json` (permissions 0600). To upload them
yourself from this checkout, run:

```sh
npx wrangler secret bulk /private/tmp/vidxir-cloudflare-core-secrets.json --config wrangler.native.jsonc
npx wrangler secret bulk /private/tmp/vidxir-cloudflare-core-secrets.json --config wrangler.jsonc
```

Alternatively, use interactive `wrangler secret put NAME --config CONFIG` or the
dashboard. The generated file has not been committed or included in deployment
assets. Store a secure backup and remove the temporary file after configuration.

Scheduled work stays paused while either core secret is missing, avoiding failed
paid-container starts. Pending queue deliveries retry instead of starting work.
Adding the secrets activates scheduled work automatically. Signup/login and
credential encryption also require the web Worker's core secrets.

Provider selectors and non-secret settings belong in both configurations' `vars`
(or managed dashboard variables kept in sync with them). Production mocks remain
**disabled**. Select real providers for features you enable; missing credentials
must surface as configuration states. Hosting on Cloudflare does not supply third
party email, YouTube, AI-generation or payment credentials.

Google callback: `https://app.vidxir.com/api/channels/callback`.
Stripe webhook: `https://app.vidxir.com/api/billing/webhook`.
Verify the email sender domain in Resend before enabling signup emails.

## Release

Workers Paid is enabled. Docker Desktop must be running and unpaused to build
and upload the FFmpeg image. Deploy the backend before the web Worker, because
the web configuration references the backend's coordination namespace.

```sh
npm ci
npm run db:migrate:d1:remote
npm run test:cloudflare
npm run typecheck
npm run lint
npm run cf:backend:deploy
npm run cf:build
npm run cf:deploy
```

For a production build before runtime secrets are configured, supply disposable
build-only `ENCRYPTION_KEY` and `SESSION_SECRET` placeholders, `EMAIL_PROVIDER=resend`
and `APP_URL=https://app.vidxir.com`. Do not save these placeholders as production
secrets. Keep `.env.local`, `.dev.vars` and credential files out of deployment assets.

`wrangler.jsonc` sets `RENDER_EXECUTION=cloudflare`; the backend Container sets
`RENDER_EXECUTION=local` and uses `/usr/bin/ffmpeg`. The web Worker never spawns
FFmpeg. The initial D1 migration creates 42 application tables and seeds the
Starter, Studio and Scale plan catalogue. A later migration adds the atomic batch
guard. Timestamps use epoch milliseconds and JSON is stored as SQLite text.
Keep applied migrations immutable. Generate subsequent changes with
`npm run db:generate:d1` and inspect the SQL before applying them.

## Local development and validation

```sh
npm run db:migrate:d1
npm run dev -- --port 3002
# Preview the actual production Workers build:
npm run cf:build
npx wrangler dev --config wrangler.jsonc --port 3004
```

Next.js development initializes OpenNext's local bindings. Set development-only
core keys in `.env.local`/`.dev.vars`. Backend-dependent locks and background work
also need a local backend session (`npx wrangler dev --config wrangler.native.jsonc`)
with Docker running. Local D1 and R2 use local storage; migration commands do not
copy local users or assets to production.

`npm run test:cloudflare` runs against real local Workers/D1/Durable Object runtimes.
It covers schema mapping, atomic rollback, grants, concurrent idempotent charges,
refunds, purchases, quota races, state transitions, tenant isolation, script
version allocation, token consumption, rate limits, lock ownership, duplicate
queue deliveries, completed-job recovery and signed media grants.

The full regression suite passed 1,480 tests; 605 legacy tests were skipped.
Type checking, lint, OpenNext production build and container image build passed.
A local production Worker preview passed login and session retrieval using D1.
The actual Linux image passed its D1 health check, encoded a real MP4 and rendered
thumbnail text. Its rendered MP4 uploaded to local R2 and read back byte-exactly.
The standalone entry point also pruned an expired session through the private bridge.
A complete live AI generation/render/YouTube publication run still requires
operator credentials and explicit choice of real providers.

## Automatic deployments

Connect both Workers to the `feat/cloudflare-native` branch with the repository
root as the build directory. For `vidxir`, use `npm run cf:build` as the build
command and `npm run cf:deploy` as the deploy command. For `vidxir-backend`, leave
the build command empty and use `npm run cf:backend:deploy` as the deploy command;
this explicitly selects `wrangler.native.jsonc`.

After pushing a commit, check the Builds page for each Worker to confirm that
both deployments succeeded. Configure runtime secrets on each Worker separately
from any secrets required by the web build.

## Admin testing credits

Operator-assigned `users.role = 'admin'` accounts have unlimited generation
credits. Public signup always creates a normal user. Admin generations bypass
credit deductions and refunds; the UI displays Unlimited. Subscription feature
and project quotas still apply. Apply D1 migrations before deploying schema changes.

## Deployment status

The native backend Worker, FFmpeg Container, five queue consumers, Durable
Objects and Cron Trigger are deployed. The web Worker uses their bindings at
`https://app.vidxir.com`. Live read-only checks confirmed the D1 plan catalogue,
R2 reachability, Durable Object coordination and the backend's missing-secret
guard. The core secrets and provider credentials are intentionally left for the
operator to configure. Scheduled work stays paused until the core secrets exist.

Changes are on `feat/cloudflare-native`; the previous working branch is preserved.

Final live verification returned HTTPS 200 for `/`, `/login` and `/api/health`.
`/api/ready` correctly returns 503 (`configuration_invalid`) while core secrets
are absent. Authentication and provider workflows are not claimed operational
until the operator configures their required credentials.

Released versions on 2026-10-07:

- Web: `4e720240-5f13-428f-990d-7c94e2fc08d9`.
- Backend: `eaf0578c-6a2b-4f7d-a0aa-9f5fffcdeee4`.

## Administration and incoming email

See [ADMIN.md](ADMIN.md) for admin permissions, support, account archives and mail.
Support replies and campaigns use a durable D1 outbox and the maintenance queue;
the backend sends them directly without starting a paid video Container. The
five-minute cron recovers pending messages and purges expired archived media.
Apply migration `0002_first_living_mummy.sql` before deploying these features.

Configure the Resend webhook and signing secret as described in ADMIN.md.
Receiving DNS alone does not populate the application inbox.
