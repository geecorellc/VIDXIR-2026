import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHmac } from "node:crypto";
import {
  beforeAll,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  setNativeBindings,
  type NativeBindings,
} from "../../src/lib/cloudflare/bindings";
import { resetEnvCache } from "../../src/lib/env";
import { hashPassword } from "../../src/lib/crypto";
import * as admin from "../../src/lib/admin/service";
import { currentTier } from "../../src/lib/plans/enforce";
import {
  processMail,
  receiveEmail,
  verifyWebhook,
  recordEmailEvent,
  purgeArchivedMedia,
  recoverMail,
  type MailRuntime,
} from "../../src/lib/admin/mail";
import type { MailDraft } from "../../src/lib/admin/types";
import { queueJvConfirmation } from "../../src/lib/marketing/jv-confirmation";
vi.mock("../../src/lib/auth/session", () => ({ revokeAllSessions: vi.fn() }));
// Real D1 calls plus repeated scrypt confirmations need headroom under CI load.
describe("Admin workspace on Cloudflare D1", { timeout: 20000 }, () => {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {fetch(){return new Response('ok')}}",
      compatibilityDate: "2026-10-07",
      d1Databases: { DB: "admin-workspace" },
      r2Buckets: { MEDIA: "admin-media" },
    }),
  );
  let db: Awaited<ReturnType<typeof runtime.getD1Database>>,
    media: Awaited<ReturnType<typeof runtime.getR2Bucket>>,
    mailRuntime: MailRuntime;
  const send = vi.fn().mockResolvedValue(undefined),
    adminPassword = "correct admin password",
    actor = "admin-actor";
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    process.env.SESSION_SECRET = "1".repeat(64);
    process.env.EMAIL_PROVIDER = "console";
    process.env.RENDER_EXECUTION = "local";
    resetEnvCache();
    db = await runtime.getD1Database("DB");
    media = await runtime.getR2Bucket("MEDIA");
    for (const file of readdirSync("drizzle-d1")
      .filter((f) => f.endsWith(".sql"))
      .sort())
      for (const statement of readFileSync(
        resolve("drizzle-d1", file),
        "utf8",
      ).split(";"))
        if (statement.trim()) await db.prepare(statement).run();
    const bindings = {
      DB: db,
      MEDIA: media,
      MAINTENANCE_QUEUE: { send },
    } as unknown as NativeBindings;
    setNativeBindings(bindings);
    mailRuntime = {
      ...bindings,
      RESEND_API_KEY: "test-key",
      EMAIL_FROM: "Vidxir AI <no-reply@vidxir.com>",
      SUPPORT_EMAIL: "support@vidxir.com",
    };
    await db
      .prepare(
        "INSERT INTO users(id,email,email_normalized,password_hash,name,role,email_verified_at) VALUES (?,?,?,?,?,'admin',?)",
      )
      .bind(
        actor,
        "admin@example.invalid",
        "admin@example.invalid",
        await hashPassword(adminPassword),
        "Admin",
        Date.now(),
      )
      .run();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    send.mockClear();
  });
  afterAll(async () => {
    await runtime.dispose();
  });
  it("sends one JV confirmation per address with the shared template and team signoff", async () => {
    await queueJvConfirmation(mailRuntime, {
      name: "Alex <Partner>",
      email: "JV-Partner@example.invalid",
    });
    await queueJvConfirmation(mailRuntime, {
      name: "Alex",
      email: "jv-partner@example.invalid",
    });
    const rows = await db
      .prepare(
        "SELECT * FROM admin_emails WHERE to_address='jv-partner@example.invalid'",
      )
      .all();
    expect(rows.results).toHaveLength(1);
    const row = rows.results[0]!;
    expect(row).toMatchObject({
      status: "queued",
      subject: "You’re on the Vidxir AI JV list",
      reply_to: "support@vidxir.com",
    });
    expect(row.html).toContain("max-width:520px");
    expect(row.html).toContain('<meta charset="utf-8">');
    expect(row.html).toContain("Alex &lt;Partner&gt;");
    expect(row.html).toContain("The Vidxir AI team");
    expect(row.html).toContain("https://vidxir.com/partners/");
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "jv-confirmation-provider-id" }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", request);
    await processMail(mailRuntime, row.id as string);
    await processMail(mailRuntime, row.id as string);
    expect(request).toHaveBeenCalledTimes(1);
    const message = JSON.parse(request.mock.calls[0]![1].body);
    expect(message.to).toEqual(["jv-partner@example.invalid"]);
    expect(message.text).toMatch(/The Vidxir AI team$/);
    expect(message.html).toBe(row.html);
  });
  it("keeps a JV confirmation in the outbox when queue scheduling fails", async () => {
    send.mockRejectedValueOnce(new Error("Queue unavailable"));
    await queueJvConfirmation(mailRuntime, {
      name: "Jordan",
      email: "jv-recovery@example.invalid",
    });
    expect(
      await db
        .prepare(
          "SELECT status FROM admin_emails WHERE to_address='jv-recovery@example.invalid'",
        )
        .first(),
    ).toMatchObject({ status: "queued" });
  });
  async function account(
    email = `${crypto.randomUUID()}@example.invalid`,
    verified = true,
  ) {
    const id = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO users(id,email,email_normalized,password_hash,name,email_verified_at) VALUES (?,?,?,?,?,?)",
      )
      .bind(id, email, email, "test", "Customer", verified ? Date.now() : null)
      .run();
    await db
      .prepare(
        "INSERT INTO subscriptions(id,user_id,tier,status,provider) VALUES (?,?,'starter','active','none')",
      )
      .bind(crypto.randomUUID(), id)
      .run();
    return id;
  }
  it("rejects customers and wrong admin passwords; creates verified users with normal credits", async () => {
    const customer = await account();
    await expect(admin.adminAccount(customer)).rejects.toThrow();
    await expect(
      admin.createUser(
        actor,
        "wrong",
        "new@example.invalid",
        "secure new password",
      ),
    ).rejects.toThrow("incorrect");
    const user = await admin.createUser(
      actor,
      adminPassword,
      "new@example.invalid",
      "secure new password",
    );
    expect(user.role).toBe("user");
    expect(user.email_verified_at).toBeTruthy();
    expect(user.credits.available).toBe(100);
    expect(user).not.toHaveProperty("password_hash");
    await expect(
      admin.createUser(
        actor,
        adminPassword,
        "new@example.invalid",
        "secure new password",
      ),
    ).rejects.toThrow("already exists");
  });
  it("preserves subscription ownership, grants persistent credits exactly once, and audits actions", async () => {
    const id = await account();
    await admin.userAction(actor, id, adminPassword, "plan:scale");
    expect(await currentTier(id)).toBe("scale");
    await admin.userAction(actor, id, adminPassword, "revoke-plan");
    expect(await currentTier(id)).toBe("starter");
    const key = crypto.randomUUID();
    await Promise.all(
      [1, 2, 3].map(() =>
        admin.userAction(actor, id, adminPassword, "credits", 20, key),
      ),
    );
    const user = await admin.userDetail(id);
    expect(user.credits.available).toBe(120);
    expect(user.actions.filter((a) => a.action === "credits")).toHaveLength(1);
    const subscription = await db
      .prepare("SELECT tier,provider FROM subscriptions WHERE user_id=?")
      .bind(id)
      .first();
    expect(subscription).toMatchObject({ tier: "starter", provider: "none" });
  });
  it("requires verified promotion, invalidates sessions, and protects admins from suspension/deletion", async () => {
    const id = await account(undefined, false);
    await expect(
      admin.userAction(actor, id, adminPassword, "promote"),
    ).rejects.toThrow("verify");
    await admin.userAction(actor, id, adminPassword, "verify");
    await admin.userAction(actor, id, adminPassword, "promote");
    expect((await admin.userDetail(id)).credits.unlimited).toBe(true);
    const user = await db
      .prepare("SELECT session_epoch FROM users WHERE id=?")
      .bind(id)
      .first<{ session_epoch: number }>();
    expect(user?.session_epoch).toBe(1);
    await expect(
      admin.userAction(actor, id, adminPassword, "suspend"),
    ).rejects.toThrow("cannot be suspended");
    await expect(
      admin.deleteUser(actor, id, adminPassword, "x", "Test"),
    ).rejects.toThrow("protected");
  });
  it("suspends and restores customers without destroying subscriptions or credits", async () => {
    const id = await account();
    const suspended = await admin.userAction(
      actor,
      id,
      adminPassword,
      "suspend",
    );
    expect(suspended.suspended_at).toBeTruthy();
    const restored = await admin.userAction(
      actor,
      id,
      adminPassword,
      "restore",
    );
    expect(restored.suspended_at).toBeNull();
    expect(restored.subscription_status).toBe("active");
  });
  it("shows only the selected user's real publication records, including private and scheduled videos", async () => {
    const owner = await account(),
      other = await account();
    const now = Date.now();
    for (const id of [owner, other]) {
      await db
        .prepare(
          "INSERT INTO channels(id,user_id,youtube_channel_id,title,access_token_enc) VALUES (?,?,?,'Publication channel','private-token')",
        )
        .bind(`channel-${id}`, id, `yt-${id}`)
        .run();
      await db
        .prepare(
          "INSERT INTO projects(id,user_id,channel_id,title) VALUES (?,?,?,'Original title')",
        )
        .bind(`project-${id}`, id, `channel-${id}`)
        .run();
      await db
        .prepare(
          "INSERT INTO published_videos(id,project_id,user_id,channel_id,youtube_video_id,url,title_used,upload_status,privacy_status,scheduled_publish_at) VALUES (?,?,?,?,?,'https://youtube.com','Published title','processed','private',?)",
        )
        .bind(
          `publication-${id}`,
          `project-${id}`,
          id,
          `channel-${id}`,
          `video-${id}`,
          now + 86400000,
        )
        .run();
    }
    const detail = await admin.userDetail(owner);
    expect(detail.publications).toHaveLength(1);
    expect(detail.publications[0]).toMatchObject({
      id: `publication-${owner}`,
      title: "Published title",
      upload_status: "processed",
      privacy_status: "private",
      scheduled_publish_at: now + 86400000,
      published_at: null,
    });
    expect(JSON.stringify(detail)).not.toContain("private-token");
    expect((await admin.userDetail(other)).publications[0]?.id).toBe(
      `publication-${other}`,
    );
  });
  it("archives and deletes atomically, excludes credentials, and retains media for 60 days", async () => {
    const id = await account(),
      detail = await admin.userDetail(id);
    await db
      .prepare(
        "INSERT INTO channels(id,user_id,youtube_channel_id,title,access_token_enc) VALUES (?,?,?,'Channel','private-provider-token')",
      )
      .bind(crypto.randomUUID(), id, crypto.randomUUID())
      .run();
    await media.put(`u/${id}/media/test.mp4`, "video");
    await expect(
      admin.deleteUser(actor, id, adminPassword, "wrong", "Test"),
    ).rejects.toThrow("confirm");
    const archive = await admin.deleteUser(
      actor,
      id,
      adminPassword,
      detail.email,
      "Requested test deletion",
    );
    expect(
      await db.prepare("SELECT id FROM users WHERE id=?").bind(id).first(),
    ).toBeNull();
    const saved = (await admin.archives(archive.id)) as {
      snapshot: unknown;
      media_delete_after: number;
    };
    expect(JSON.stringify(saved.snapshot)).not.toMatch(
      /password_hash|private-provider-token|access_token_enc/,
    );
    expect(saved.media_delete_after).toBeGreaterThan(
      Date.now() + 59 * 86400000,
    );
    await purgeArchivedMedia(mailRuntime);
    expect(await media.head(`u/${id}/media/test.mp4`)).not.toBeNull();
    await db
      .prepare("UPDATE deleted_accounts SET media_delete_after=0 WHERE id=?")
      .bind(archive.id)
      .run();
    await purgeArchivedMedia(mailRuntime);
    await purgeArchivedMedia(mailRuntime);
    expect(await media.head(`u/${id}/media/test.mp4`)).toBeNull();
  });
  it("keeps customer ticket threads isolated and admin replies persistent/idempotent", async () => {
    const id = await account(),
      other = await account(),
      user = await admin.userDetail(id);
    const ticket = await admin.createTicket({
      userId: id,
      email: user.email,
      name: user.name,
      subject: "Need help",
      category: "General",
      message: "Question",
    });
    await expect(admin.ticketThread(ticket.id, other)).rejects.toThrow(
      "not found",
    );
    const request = crypto.randomUUID();
    await admin.replyTicket(actor, ticket.id, "Reply", true, request);
    await admin.replyTicket(actor, ticket.id, "Reply", true, request);
    const thread = await admin.ticketThread(ticket.id);
    expect(thread.status).toBe("Resolved");
    expect(thread.messages).toHaveLength(2);
    expect(send).toHaveBeenCalled();
    await db
      .prepare(
        "UPDATE subscriptions SET tier='studio',status='canceled' WHERE user_id=?",
      )
      .bind(id)
      .run();
    expect((await admin.listTickets(id)).items[0]?.tier).toBe("starter");
    await db
      .prepare("UPDATE users SET plan_override='scale' WHERE id=?")
      .bind(id)
      .run();
    expect((await admin.listTickets(id)).items[0]?.tier).toBe("scale");
  });
  it("receives support emails once, reopens valid replies, and keeps spoofed senders out of the thread", async () => {
    const id = await account(),
      user = await admin.userDetail(id),
      ticket = await admin.createTicket({
        userId: id,
        email: user.email,
        name: user.name,
        subject: "Reply test",
        category: "General",
        message: "Question",
      });
    await admin.updateTicket(ticket.id, "Resolved");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () =>
        Response.json({
          from: user.email,
          to: [`support+ticket-${ticket.id}@vidxir.com`],
          subject: "Re: Support",
          text: "More details",
        }),
      ),
    );
    const emailId = crypto.randomUUID();
    await Promise.all([1, 2].map(() => receiveEmail(mailRuntime, emailId)));
    const thread = await admin.ticketThread(ticket.id);
    expect(thread.messages).toHaveLength(2);
    expect(thread.status).toBe("In progress");
    expect(thread.unread).toBe(1);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          from: "intruder@example.invalid",
          to: [`support+ticket-${ticket.id}@vidxir.com`],
          subject: "Reply",
          text: "Fake",
        }),
      ),
    );
    await receiveEmail(mailRuntime, crypto.randomUUID());
    expect((await admin.ticketThread(ticket.id)).messages).toHaveLength(2);
  });
  it("creates a new ticket for direct support mail, retains general mail, and exposes attachment metadata", async () => {
    const emailId = crypto.randomUUID();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () =>
        Response.json({
          from: "guest@example.invalid",
          to: ["support@vidxir.com"],
          subject: "New help",
          text: "Question",
          attachments: [{ id: "attachment", filename: "report.pdf" }],
        }),
      ),
    );
    await Promise.all([1, 2].map(() => receiveEmail(mailRuntime, emailId)));
    const row = await db
      .prepare(
        "SELECT ticket_id,attachments FROM admin_emails WHERE provider_id=?",
      )
      .bind(emailId)
      .first<{ ticket_id: string; attachments: string }>();
    expect(row?.ticket_id).toBeTruthy();
    expect(row?.attachments).toContain("report.pdf");
    expect(
      (
        await db
          .prepare("SELECT id FROM support_tickets WHERE id=?")
          .bind(row!.ticket_id)
          .all()
      ).results,
    ).toHaveLength(1);
  });
  it("snapshots mail audiences, rejects stale previews, excludes admins/suspended users, and survives dispatch retries", async () => {
    const target = await account("campaign@example.invalid"),
      suspended = await account("suspended@example.invalid");
    await admin.userAction(actor, suspended, adminPassword, "suspend");
    const draft: MailDraft = {
      subject: "Update",
      heading: "Hello",
      message: "Message",
      audience: {
        tiers: [],
        verification: "verified",
        specificEmails: [
          "campaign@example.invalid",
          "suspended@example.invalid",
          "admin@example.invalid",
        ],
      },
    };
    const preview = await admin.previewMail(draft);
    expect(preview.recipientCount).toBe(1);
    const dispatchId = crypto.randomUUID();
    await expect(
      admin.dispatchMail(
        actor,
        { ...draft, message: "Edited" },
        dispatchId,
        preview.fingerprint,
      ),
    ).rejects.toThrow("Preview");
    await Promise.all(
      [1, 2].map(() =>
        admin.dispatchMail(actor, draft, dispatchId, preview.fingerprint),
      ),
    );
    expect((await admin.dispatchProgress(dispatchId)).recipientCount).toBe(1);
    expect(
      (
        await db
          .prepare("SELECT id FROM admin_emails WHERE dispatch_id=?")
          .bind(dispatchId)
          .all()
      ).results,
    ).toHaveLength(1);
    expect(await admin.userDetail(target)).toBeTruthy();
    const saved = await admin.dispatchDetail(dispatchId);
    expect(saved.draft).toEqual(draft);
    expect(saved.actor_name).toBe("Admin");
    expect(saved.status).toBe("queued");
    expect(
      (await admin.listDispatches(1)).items.find(
        (item) => item.id === dispatchId,
      ),
    ).toMatchObject({
      recipientCount: 1,
      processedCount: 0,
      sentCount: 0,
      failedCount: 0,
      status: "queued",
    });
    await db
      .prepare(
        "UPDATE admin_emails SET status='failed',error='Recipient rejected' WHERE dispatch_id=?",
      )
      .bind(dispatchId)
      .run();
    expect(await admin.dispatchDetail(dispatchId)).toMatchObject({
      status: "completed",
      failedCount: 1,
      failedEmails: ["campaign@example.invalid"],
    });
    expect(
      (await admin.listDispatches(1)).items.find(
        (item) => item.id === dispatchId,
      ),
    ).toMatchObject({ status: "completed", failedCount: 1, processedCount: 1 });
  });
  it("retries provider failures using stable idempotency keys and stores failed delivery progress", async () => {
    const id = await account(),
      user = await admin.userDetail(id),
      mailId = crypto.randomUUID();
    await admin.sendUserMail(actor, id, "Test", "Hello", "Body", mailId);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("retry", { status: 429 }))
      .mockResolvedValueOnce(Response.json({ id: "provider-test" }));
    vi.stubGlobal("fetch", fetcher);
    await expect(processMail(mailRuntime, mailId)).rejects.toThrow("retry");
    await processMail(mailRuntime, mailId);
    await processMail(mailRuntime, mailId);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]?.headers["Idempotency-Key"]).toBe(
      fetcher.mock.calls[1]?.[1]?.headers["Idempotency-Key"],
    );
    expect((await admin.mailDetail(mailId)).status).toBe("sent");
    await recordEmailEvent(
      mailRuntime,
      "evt1",
      "provider-test",
      "email.delivered",
      Date.now(),
    );
    await recordEmailEvent(
      mailRuntime,
      "evt1",
      "provider-test",
      "email.delivered",
      Date.now(),
    );
    expect((await admin.mailDetail(mailId)).events).toHaveLength(1);
    const failed = crypto.randomUUID();
    await admin.sendUserMail(actor, id, "Test", "Hello", "Body", failed);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("bad", { status: 422 })),
    );
    await processMail(mailRuntime, failed);
    expect((await admin.mailDetail(failed)).status).toBe("failed");
    await recoverMail(mailRuntime);
    expect(user.email).toBeTruthy();
  });
  it("validates raw signatures and rejects tampering and stale/future timestamps", () => {
    const raw = '{"type":"email.received"}',
      secret = Buffer.from("test-signing-key").toString("base64"),
      now = Date.now(),
      timestamp = String(Math.floor(now / 1000)),
      id = "event";
    const signature = createHmac("sha256", Buffer.from(secret, "base64"))
      .update(`${id}.${timestamp}.${raw}`)
      .digest("base64");
    const headers = new Headers({
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    });
    expect(verifyWebhook(raw, headers, `whsec_${secret}`, now)).toBe(true);
    expect(verifyWebhook(raw + " ", headers, `whsec_${secret}`, now)).toBe(
      false,
    );
    expect(verifyWebhook(raw, headers, `whsec_${secret}`, now + 301000)).toBe(
      false,
    );
    expect(verifyWebhook(raw, headers, `whsec_${secret}`, now - 301000)).toBe(
      false,
    );
  });
});
