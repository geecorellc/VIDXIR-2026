# Cloudflare deployment

The Next.js web/API process targets Cloudflare Workers through OpenNext. The
BullMQ worker and scheduler remain separate Node.js processes; local FFmpeg
rendering needs a host with executable binaries, writable scratch space, and
fonts. Postgres and Redis must be production services reachable by both the web
process and these background processes. Object storage can be Cloudflare R2 via
its S3-compatible endpoint.

## Authentication

```sh
npm run cf:login
npm run cf:whoami
```

Sign in and allow access in the browser opened by the first command. Wrangler
stores OAuth credentials outside this repository. Never commit credentials.

## Production configuration

The selected application URL is `https://app.vidxir.com`. The authenticated
account contains the active zone `vidxir.com`. A Worker Custom Domain creates its
DNS entry when deployed; an A record pointing to localhost is not needed.
The R2 bucket `vidxir-media-production` has been created; its S3 endpoint, region,
and bucket are configured in Wrangler. Create bucket-scoped R2 S3 credentials
and set `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` as runtime secrets. The
existing storage integration uses the S3 API, so it does not need an R2 binding.

Confirm the domain in `wrangler.jsonc` is an active zone in the authenticated
Cloudflare account before deploying. `APP_URL` must match the HTTPS domain.

Set runtime secrets using `npx wrangler secret put NAME`, including:

- `DATABASE_URL`, `REDIS_URL`
- `ENCRYPTION_KEY`, `SESSION_SECRET` (separate 32-byte hex values)
- `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
- `RESEND_API_KEY`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- Provider API keys for the video capabilities you enable
- Stripe secrets if you enable Stripe billing

Set the production storage endpoint, bucket, region, email sender, provider
selection, and other non-secret settings from `.env.example` in Wrangler's
`vars`. For R2 use its account-specific S3 endpoint and `S3_REGION=auto`.
Use the same database, Redis namespace, storage, and encryption/session secrets
on the worker and scheduler host. Preserve an existing encryption key when
migrating existing data.

Development `.env.local` values must not be used in production builds. Configure
Cloudflare Build variables separately when using Cloudflare's Git integration;
build variables and runtime secrets are separate. For local build validation,
use an isolated checkout with build-only values, never production credentials
that could be inlined into the output. Runtime dependency checks must be done
with the actual production configuration.

## Release order

1. Provision Postgres, Redis, storage, and the Node.js worker/scheduler host.
2. Apply migrations against production with `npm run db:migrate`.
3. Start `npm run worker` and `npm run scheduler` on the Node.js host.
4. Run `npm run cf:build`, then `npm run cf:preview` to validate Workers runtime
   compatibility. Compilation alone does not prove login, queues, or provider
   calls work; validate those against staging infrastructure before launch.
5. Run `npm run cf:deploy` after the build and runtime validation pass.
6. Verify `/api/health`, `/api/ready?mode=full`, signup/login, and a complete video
   workflow on the live domain.

Set the Google OAuth redirect to `https://YOUR_DOMAIN/api/channels/callback`
and the Stripe webhook to `https://YOUR_DOMAIN/api/billing/webhook`.

## Background process image

`Dockerfile.worker` installs system FFmpeg and fonts, runs as a non-root user,
and excludes local secret files from the build. Build it with:

```sh
docker build -f Dockerfile.worker -t vidxir-worker .
```

Run two services from that image with production environment variables supplied
by your host: the default command runs the worker; override the command with
`npm run scheduler` for the scheduler. A one-off instance with
`npm run db:migrate` applies migrations. Give the worker at least 60 seconds of
shutdown grace, sufficient CPU/memory, and writable temporary disk for rendering.
This image has not yet been built or deployed; validate it on the selected host.

## Validation performed

An isolated build with build-only values passed the OpenNext Cloudflare build
and Wrangler deployment dry run. The homepage and `/api/health` returned 200
under local `workerd`. TypeScript and Dockerfile configuration checks passed.
The web Worker was published on October 7, 2026 at
`https://app.vidxir.com`, with version
`462ea6bd-6dff-4c3d-871c-73c1b7669786`. The live homepage and login page returned
200 over HTTPS. The custom domain is attached. No production secrets have been
configured; the public pages are available while backend setup is deferred.
Production signup/login actions, database/Redis connections, storage access,
email, provider calls, and a complete video workflow remain unverified.

Authentication or a successful build alone does not publish the app.
