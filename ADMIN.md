# Administration

Verified, unsuspended accounts with `users.role = 'admin'` can open
`https://app.vidxir.com/admin`. Public signup cannot assign that role. The server
checks the database role on every admin request. Administrators can change their
password using **Password** in the admin header, without completing studio setup.
A password change invalidates all existing sessions.

## Support

Customers submit requests from `/dashboard/support`; guests use `/support`.
Both pages include searchable Vidxir help articles and links to relevant flows.
Administrators can search tickets, read their conversation, change status and
send an email reply, optionally resolving the ticket. New requests receive a
queued acknowledgement. Email replies use a ticket-specific support reply-to
address. An incoming reply appends only when its sender matches the requester;
it marks the conversation unread and reopens a resolved ticket. Other incoming
email remains in the mailbox. Customer endpoints enforce ticket ownership.

## Users and archives

The user directory supports search, pagination, verified account creation and
details for credits, plans, channels, projects and administrator actions.
YouTube publication records show the actual uploaded title, channel, processing
status, visibility, and published/scheduled date, with a link to the video.
Password-confirmed actions include verification, promotion, suspension/restore,
manual plan access, non-expiring credit grants and deletion. Plan overrides
preserve paid subscription records; removing an override restores normal billing
entitlements. Credit grants use idempotent ledger entries. Administrators have
unlimited generation credits; feature and project quotas still follow their plan.

Suspension invalidates sessions and prevents new scheduled generation and
analytics work. Promotion invalidates existing sessions and email tokens.
Administrators cannot suspend or delete admin accounts. Deletion also requires
the account's email and a reason, writes a sanitized snapshot atomically, cancels
queued mail for that recipient and removes the live account and its owned data.
Passwords, sessions, tokens and provider credentials are excluded from snapshots.

Archive records are read-only; they do not restore accounts. Retained R2 media
is eligible for deletion after 60 days and is purged by the backend cron. The
archive keeps the sanitized account snapshot and records media cleanup status.

## Mail

The mailbox includes incoming messages, queued/sent messages, delivery events,
authenticated attachment links and links to associated support tickets. Received
HTML is not executed. Campaign previews use an isolated sandboxed iframe.

Campaigns target existing customer accounts by plan, verification state and join
date, or an explicit email list. Administrators and suspended accounts are
excluded. Sending requires a current preview and explicit confirmation. Recipient
selection is snapshotted in D1; each message has a durable outbox record and a
stable Resend idempotency key. Progress and recipient failures are recorded.
The **Campaigns** tab keeps a paginated history and lets administrators reopen
a campaign after navigation or reload to follow delivery progress. Its original
content can populate a fresh draft; failed recipient addresses can populate a
new draft for a targeted retry. Every new draft must be previewed and confirmed.
Individual emails use the same outbox and preview flow.

The maintenance queue sends email directly from `vidxir-backend`. Cron recovers
pending messages after queue/network failures. Provider timeouts can retry safely
within Resend's idempotency window; ambiguous attempts older than that window are
marked failed rather than risking duplicate delivery. No bonuses or vaults are
included in this implementation.

## Resend setup

1. Keep the verified sending domain and receiving MX records configured in
   Resend. If receiving is enabled on another subdomain, set `SUPPORT_EMAIL` on
   both Workers to a mailbox on that receiving domain. The default is
   `support@vidxir.com`.
2. Set a Resend API key with permission to send and read received email as
   `RESEND_API_KEY` on both `vidxir` and `vidxir-backend`.
3. Create a Resend webhook pointing to
   `https://app.vidxir.com/api/webhooks/resend`. Select `email.received` and the
   outbound delivery/activity events you want to track, including
   `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`,
   `email.complained`, `email.failed`, `email.opened` and `email.clicked`.
4. Copy its signing secret into **`RESEND_WEBHOOK_SECRET` on `vidxir` only**.
   Save/deploy the variable change in Cloudflare. Keep this value secret;
   it does not belong in Wrangler `vars` or Git.
5. Send an email to the receiving support address, then check **Admin → Mail →
   Inbox** and **Support**. Reply from Support and answer that email to confirm
   the same conversation receives the reply. Check Resend webhook attempts if
   the incoming message does not appear.

Webhook verification authenticates the raw payload and enforces a five-minute
timestamp window. Duplicate incoming events and delivery events are idempotent.
Webhook failures return an error so Resend can retry. Existing inbound messages
are not automatically backfilled: the integration processes new webhook events.

## Deployment

Apply D1 migrations before releasing either Worker:

```sh
npm run db:migrate:d1:remote
npm run typecheck
npm run lint
npm run test:cloudflare
```

The production branch is `feat/cloudflare-native`. Both Workers must deploy that
branch: the web Worker serves the UI and webhook; the backend drains the outbox
and handles retention. Runtime secrets remain operator-managed.
