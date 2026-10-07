# Cloudflare deployment

The public app is live at **https://app.vidxir.com**. Its Next.js frontend and API
run on Cloudflare Workers through OpenNext. The Custom Domain created the DNS
record automatically. Wrangler is already authenticated on this machine.

```sh
npm run cf:whoami
# For a new machine:
npm run cf:login
```

## Cloudflare-only backend migration

The selected backend uses Cloudflare services rather than Render, Neon,
Upstash, or a separately hosted BullMQ server:

| Purpose | Cloudflare service | Current state |
| --- | --- | --- |
| Web frontend/API | Workers + OpenNext | Live |
| Relational data | D1 | Created; schema and plan catalogue applied |
| Media files | R2 | Private production bucket created |
| Background job delivery | Queues | Five queues created; consumers not connected |
| Locks and rate limiting | Durable Objects | Application adapter pending |
| Scheduled work | Cron Triggers | Scheduler conversion pending |
| FFmpeg/video processing | Containers | Requires Workers Paid; application adapter pending |

**These provisioned services are not yet used by the live application's backend.**
The current runtime still imports the PostgreSQL schema/client and BullMQ/Redis
adapters. Switching a binding alone cannot migrate those implementations. The
public frontend remains on its last tested deployment while this conversion is
prepared on `feat/cloudflare-native`.

Cloudflare rejected `wrangler containers list` with:

> You do not have access to Cloudflare Containers. Deploying containers requires the Workers Paid plan.

Enable **Workers Paid** in the authenticated account at
https://dash.cloudflare.com/?to=/:account/workers/plans. It starts at $5/month,
with additional usage charges. No billing plan was changed by this setup.
See [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/).

## Provisioned resources

`wrangler.native.jsonc` records the backend resource bindings. It is a resource
configuration for migration commands; it does not yet have a deployable Worker
entry point and must not replace `wrangler.jsonc` during a web release.

- D1: `vidxir-production`, ID `90189a29-b52e-4723-b83e-1d0d7be77359`.
- R2: `vidxir-media-production`.
- Queues: `vidxir-research`, `vidxir-pipeline`, `vidxir-publish`,
  `vidxir-analytics`, and `vidxir-maintenance`.

The D1 schema is in `src/lib/db/schema.d1.ts`; existing PostgreSQL migrations
and the active application schema are preserved separately. The D1 migration
creates all 42 tables and seeds Starter, Studio, and Scale from the plan
catalogue. It includes partial unique indexes, credit ledger sign checks, and
balance constraints. Timestamps use UTC epoch milliseconds, JSON uses SQLite
text, and fractional metrics use REAL storage.

```sh
# Validate on a fresh local D1 database:
npm run db:migrate:d1
npm run test:cloudflare

# Apply new migrations to the provisioned production D1 database:
npm run db:migrate:d1:remote

# Generate subsequent schema changes; inspect the SQL before applying:
npm run db:generate:d1
```

The initial migration includes hand-authored plan inserts after generated DDL.
Keep applied migrations immutable; catalogue changes require a new migration.

## Remaining implementation and activation

1. Replace the PostgreSQL client and SQL expressions with D1, and convert the
   interactive transaction callbacks to atomic D1 batches. D1 does not support
   PostgreSQL-style interactive transactions. Credit charging, refunds, quota
   claims, and state changes must retain rollback and idempotency guarantees.
2. Replace BullMQ producers/consumers with Queues, preserving the durable jobs
   table, retries, job progress, duplicate-delivery handling, and publish locks.
3. Add native R2 access and Durable Object locking/rate limiting. Connect the
   existing scheduler tasks to Cron Triggers.
4. After Workers Paid is enabled, adapt the FFmpeg image to a Cloudflare
   Container. Use D1/R2-backed state, since a container filesystem is ephemeral.
   Do not put a production PostgreSQL or Redis database on that disk.
5. Configure encryption/session secrets and required email/AI/Google credentials.
   External APIs still require their own credentials even when hosting is entirely
   Cloudflare. Never enable mock providers in production.
6. Validate signup, login, tenant isolation, concurrent credit charges, queue
   retries, and a full render/publish workflow in staging. Only then attach the
   completed backend to the live app.

Google OAuth callback: `https://app.vidxir.com/api/channels/callback`.
Stripe webhook, if billing is enabled: `https://app.vidxir.com/api/billing/webhook`.

## Web release commands

```sh
npm run cf:build
npm run cf:preview
npm run cf:deploy
```

Use isolated, build-only environment values for local production builds. Keep
`.env.local`, `.dev.vars`, OAuth credentials, and runtime secrets out of Git and
deployment assets. Production provider keys have not been configured.

## Validation

The D1 migration was validated in the local Workers runtime. The Cloudflare tests
check schema creation, the plan catalogue, Date/JSON mapping, invalid credit
movements, whole-batch rollback on overdraft, and duplicate charge constraints.
These tests validate the new database foundation; they do not assert that the
existing application services have been migrated.

The last live web release includes the dark-mode default and returned HTTPS 200
for the homepage and login page. The full backend is not yet operational.
