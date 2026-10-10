import { createHash } from "node:crypto";
import { nativeBindings } from "@/lib/cloudflare/bindings";
import { env } from "@/lib/env";
import { hashPassword, verifyPassword } from "@/lib/crypto";
import { assertPasswordAcceptable } from "@/lib/auth/service";
import { creditBalanceFor, ensureMonthlyGrant } from "@/lib/credits/service";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import {
  enqueueMail,
  renderMail,
  supportReplyAddress,
  type MailRuntime,
} from "./mail";
import type {
  AdminUser,
  Archive,
  DispatchProgress,
  DispatchSummary,
  DispatchDetail,
  MailDraft,
  MailRow,
  Ticket,
  TicketThread,
  UserDetail,
} from "./types";

const database = () => nativeBindings().DB;
export function mailRuntime(): MailRuntime {
  const config = env();
  return {
    ...nativeBindings(),
    RESEND_API_KEY: config.RESEND_API_KEY,
    EMAIL_FROM: config.EMAIL_FROM,
    JV_EMAIL_FROM: config.JV_EMAIL_FROM,
    SUPPORT_EMAIL: config.SUPPORT_EMAIL,
  };
}
const USER_COLUMNS = `u.id,u.email,u.name,u.role,u.email_verified_at,u.suspended_at,u.plan_override,u.created_at,u.last_login_at,
  COALESCE(u.plan_override,CASE WHEN s.status IN ('active','trialing') THEN s.tier ELSE 'starter' END,'starter') AS tier,
  COALESCE(s.status,'active') AS subscription_status`;
export async function adminAccount(actorId: string) {
  const actor = await database()
    .prepare(
      "SELECT id,email,name,role,email_verified_at,suspended_at,password_hash FROM users WHERE id=?",
    )
    .bind(actorId)
    .first<{
      id: string;
      email: string;
      name: string;
      role: string;
      email_verified_at: number | null;
      suspended_at: number | null;
      password_hash: string;
    }>();
  if (
    !actor ||
    actor.role !== "admin" ||
    !actor.email_verified_at ||
    actor.suspended_at
  )
    throw new ForbiddenError("Verified administrator access required.");
  return actor;
}
export async function confirmedAdmin(actorId: string, password: string) {
  const actor = await adminAccount(actorId);
  if (!(await verifyPassword(password, actor.password_hash)))
    throw new ForbiddenError("Your administrator password is incorrect.");
  return actor;
}
/** Recheck role and password inside the action transaction, not just before it. */
function actorGuard(actor: Awaited<ReturnType<typeof confirmedAdmin>>) {
  const guard = crypto.randomUUID();
  return [
    database()
      .prepare(
        "UPDATE users SET updated_at=updated_at WHERE id=? AND role='admin' AND password_hash=? AND email_verified_at IS NOT NULL AND suspended_at IS NULL",
      )
      .bind(actor.id, actor.password_hash),
    database()
      .prepare(
        "INSERT INTO _atomic_guards(id,valid) VALUES (?,CASE WHEN changes()>0 THEN 1 ELSE 0 END)",
      )
      .bind(guard),
    database().prepare("DELETE FROM _atomic_guards WHERE id=?").bind(guard),
  ];
}
function audit(
  actorId: string,
  targetId: string,
  action: string,
  detail?: string,
) {
  return database()
    .prepare(
      "INSERT INTO admin_actions(id,actor_id,target_id,action,detail) VALUES (?,?,?,?,?)",
    )
    .bind(crypto.randomUUID(), actorId, targetId, action, detail ?? null);
}
export async function listUsers(search: string, page: number, limit: number) {
  const pattern = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const predicate = "(u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')";
  const { results } = await database()
    .prepare(
      `SELECT ${USER_COLUMNS} FROM users u LEFT JOIN subscriptions s ON s.user_id=u.id WHERE ${predicate} ORDER BY u.created_at DESC,u.id LIMIT ? OFFSET ?`,
    )
    .bind(pattern, pattern, limit, (page - 1) * limit)
    .all<AdminUser>();
  const total = await database()
    .prepare(`SELECT COUNT(*) AS total FROM users u WHERE ${predicate}`)
    .bind(pattern, pattern)
    .first<{ total: number }>();
  return { items: results, total: total?.total ?? 0, page, limit };
}
export async function userDetail(id: string): Promise<UserDetail> {
  const user = await database()
    .prepare(
      `SELECT ${USER_COLUMNS} FROM users u LEFT JOIN subscriptions s ON s.user_id=u.id WHERE u.id=?`,
    )
    .bind(id)
    .first<AdminUser>();
  if (!user) throw new NotFoundError("User not found.");
  const [credits, projects, channels, publications, actions] =
    await Promise.all([
      creditBalanceFor(id),
      database()
        .prepare(
          "SELECT id,title,status,created_at FROM projects WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
        )
        .bind(id)
        .all<UserDetail["projects"][number]>(),
      database()
        .prepare(
          "SELECT id,title,youtube_channel_id,disconnected_at FROM channels WHERE user_id=?",
        )
        .bind(id)
        .all<UserDetail["channels"][number]>(),
      database()
        .prepare(
          `SELECT v.id,v.project_id,COALESCE(v.title_used,p.title) AS title,c.title AS channel_title,
        v.youtube_video_id,v.upload_status,v.privacy_status,v.published_at,v.scheduled_publish_at,v.created_at
        FROM published_videos v JOIN projects p ON p.id=v.project_id JOIN channels c ON c.id=v.channel_id
        WHERE v.user_id=? ORDER BY v.created_at DESC,v.id LIMIT 100`,
        )
        .bind(id)
        .all<UserDetail["publications"][number]>(),
      database()
        .prepare(
          "SELECT id,actor_id,action,detail,created_at FROM admin_actions WHERE target_id=? ORDER BY created_at DESC LIMIT 50",
        )
        .bind(id)
        .all<UserDetail["actions"][number]>(),
    ]);
  return {
    ...user,
    credits,
    projects: projects.results,
    channels: channels.results,
    publications: publications.results,
    actions: actions.results,
  };
}
export async function createUser(
  actorId: string,
  adminPassword: string,
  email: string,
  password: string,
) {
  const actor = await confirmedAdmin(actorId, adminPassword);
  assertPasswordAcceptable(password);
  const digest = await hashPassword(password);
  const id = crypto.randomUUID(),
    normalized = email.trim().toLowerCase();
  try {
    await database().batch([
      ...actorGuard(actor),
      database()
        .prepare(
          "INSERT INTO users(id,email,email_normalized,password_hash,name,email_verified_at) VALUES (?,?,?,?,?,?)",
        )
        .bind(
          id,
          normalized,
          normalized,
          digest,
          normalized.split("@")[0]!.slice(0, 120),
          Date.now(),
        ),
      database()
        .prepare(
          "INSERT INTO subscriptions(id,user_id,tier,status,provider) VALUES (?,?,'starter','active','none')",
        )
        .bind(crypto.randomUUID(), id),
      audit(actorId, id, "create", "Created verified account"),
    ]);
  } catch (error) {
    if (
      String(error).includes("users_email_normalized_key") ||
      String(error).includes("users.email_normalized")
    )
      throw new ConflictError(
        "An account already exists for this email address.",
      );
    throw error;
  }
  await ensureMonthlyGrant(id);
  return userDetail(id);
}
export async function userAction(
  actorId: string,
  targetId: string,
  password: string,
  action: string,
  credits = 0,
  requestId = "",
) {
  const actor = await confirmedAdmin(actorId, password);
  const target = await userDetail(targetId);
  const queries = [...actorGuard(actor)];
  if (action === "promote") {
    if (!target.email_verified_at)
      throw new ValidationError(
        "The user must verify their email before promotion.",
      );
    queries.push(
      database()
        .prepare(
          "UPDATE users SET role='admin',session_epoch=session_epoch+1,updated_at=? WHERE id=? AND email_verified_at IS NOT NULL",
        )
        .bind(Date.now(), targetId),
    );
    queries.push(
      database()
        .prepare("DELETE FROM email_tokens WHERE user_id=?")
        .bind(targetId),
    );
  } else if (action === "suspend" || action === "restore") {
    if (target.role === "admin")
      throw new ConflictError("Administrator accounts cannot be suspended.");
    queries.push(
      database()
        .prepare(
          "UPDATE users SET suspended_at=?,session_epoch=session_epoch+1,updated_at=? WHERE id=? AND role<>'admin'",
        )
        .bind(action === "suspend" ? Date.now() : null, Date.now(), targetId),
    );
  } else if (action === "verify") {
    queries.push(
      database()
        .prepare(
          "UPDATE users SET email_verified_at=COALESCE(email_verified_at,?),updated_at=? WHERE id=?",
        )
        .bind(Date.now(), Date.now(), targetId),
    );
  } else if (action.startsWith("plan:") || action === "revoke-plan") {
    const tier = action === "revoke-plan" ? null : action.slice(5);
    if (tier !== null && !["starter", "studio", "scale"].includes(tier))
      throw new ValidationError("Choose a valid plan.");
    queries.push(
      database()
        .prepare("UPDATE users SET plan_override=?,updated_at=? WHERE id=?")
        .bind(tier, Date.now(), targetId),
    );
  } else if (action === "credits") {
    if (
      !Number.isSafeInteger(credits) ||
      credits < 1 ||
      credits > 1000000 ||
      !requestId
    )
      throw new ValidationError("Enter 1–1,000,000 credits and a request ID.");
    // Purchased-style grants survive monthly resets. The same batch includes the
    // actor guard and audit, so a credential change cannot race the grant.
    await ensureMonthlyGrant(targetId);
    const ledgerId = crypto.randomUUID();
    const key = `admin-grant:${requestId}`;
    const existing = await database()
      .prepare("SELECT user_id FROM credit_ledger WHERE idempotency_key=?")
      .bind(key)
      .first<{ user_id: string }>();
    if (existing && existing.user_id !== targetId)
      throw new ConflictError("Grant ID was already used for another account.");
    await database().batch([
      ...queries,
      database()
        .prepare(
          "INSERT OR IGNORE INTO credit_ledger(id,user_id,reason,amount,balance_after,period,idempotency_key,description,meta) VALUES (?,?,'adjustment',?,0,?,?,?,?)",
        )
        .bind(
          ledgerId,
          targetId,
          credits,
          new Date().toISOString().slice(0, 7),
          key,
          "Administrator credit grant",
          JSON.stringify({ actorId }),
        ),
      database()
        .prepare(
          `INSERT INTO credit_balances(user_id,granted,purchased,spent,period)
        SELECT ?,0,?,0,? WHERE EXISTS(SELECT 1 FROM credit_ledger WHERE id=?)
        ON CONFLICT(user_id) DO UPDATE SET purchased=purchased+?,updated_at=?`,
        )
        .bind(
          targetId,
          credits,
          new Date().toISOString().slice(0, 7),
          ledgerId,
          credits,
          Date.now(),
        ),
      database()
        .prepare(
          "UPDATE credit_ledger SET balance_after=(SELECT granted+purchased-spent FROM credit_balances WHERE user_id=?) WHERE id=?",
        )
        .bind(targetId, ledgerId),
      database()
        .prepare(
          "INSERT INTO admin_actions(id,actor_id,target_id,action,detail) SELECT ?,?,?,'credits',? WHERE EXISTS(SELECT 1 FROM credit_ledger WHERE id=?)",
        )
        .bind(
          crypto.randomUUID(),
          actorId,
          targetId,
          `${credits} credits`,
          ledgerId,
        ),
    ]);
    return userDetail(targetId);
  } else throw new ValidationError("Choose a valid user action.");
  queries.push(audit(actorId, targetId, action));
  await database().batch(queries);
  return userDetail(targetId);
}
export async function deleteUser(
  actorId: string,
  targetId: string,
  password: string,
  confirmation: string,
  reason: string,
  source = "admin",
) {
  const actor = await confirmedAdmin(actorId, password);
  const target = await userDetail(targetId);
  if (targetId === actorId || target.role === "admin")
    throw new ConflictError(
      "Administrator accounts are protected from deletion.",
    );
  if (confirmation.toLowerCase() !== target.email.toLowerCase())
    throw new ValidationError(
      "Type the user's email address to confirm deletion.",
    );
  const id = crypto.randomUUID();
  // Build the sanitized snapshot with SQL subqueries evaluated inside the same
  // transaction as deletion. No concurrent write can fall between snapshot/delete.
  const tables = await database()
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    )
    .all<{ name: string }>();
  const parts = [
    "'user',json((SELECT json_object('id',id,'email',email,'name',name,'role',role,'email_verified_at',email_verified_at,'created_at',created_at,'plan_override',plan_override) FROM users WHERE id=?))",
  ];
  let tableCount = 0;
  for (const { name } of tables.results) {
    if (
      !/^[a-z_]+$/.test(name) ||
      ["users", "sessions", "email_tokens"].includes(name)
    )
      continue;
    const columns = await database()
      .prepare(`PRAGMA table_info("${name}")`)
      .all<{ name: string }>();
    if (!columns.results.some((c) => c.name === "user_id")) continue;
    const safe = columns.results.filter(
      (c) => !/password|token|secret|credential|api_key/i.test(c.name),
    );
    const fields = safe.map((c) => `'${c.name}',"${c.name}"`).join(",");
    parts.push(
      `'${name}',json((SELECT COALESCE(json_group_array(json_object(${fields})),'[]') FROM "${name}" WHERE user_id=?))`,
    );
    tableCount++;
  }
  const snapshot = `json_object(${parts.join(",")})`;
  // Account-owned running work can no longer authenticate; mail to the deleted
  // recipient is cancelled, while delivered history and the archive are retained.
  await database().batch([
    ...actorGuard(actor),
    database()
      .prepare(
        `INSERT INTO deleted_accounts(id,original_user_id,email,name,source,actor_id,reason,snapshot,media_delete_after)
      SELECT ?,id,email,name,?,?,?,${snapshot},? FROM users WHERE id=? AND role<>'admin'`,
      )
      .bind(
        id,
        source,
        actorId,
        reason,
        ...Array(tableCount + 1).fill(targetId),
        Date.now() + 60 * 86400000,
        targetId,
      ),
    database()
      .prepare(
        "INSERT INTO _atomic_guards(id,valid) VALUES (?,CASE WHEN changes()>0 THEN 1 ELSE 0 END)",
      )
      .bind(id),
    database().prepare("DELETE FROM _atomic_guards WHERE id=?").bind(id),
    database()
      .prepare(
        "UPDATE admin_emails SET status='cancelled',error='Recipient account deleted.' WHERE to_address=? AND status='queued'",
      )
      .bind(target.email),
    database()
      .prepare("DELETE FROM users WHERE id=? AND role<>'admin'")
      .bind(targetId),
    audit(actorId, targetId, "delete", reason),
  ]);
  return { id };
}
export async function archives(
  id?: string,
): Promise<Archive | { items: Archive[] }> {
  if (id) {
    const item = await database()
      .prepare("SELECT * FROM deleted_accounts WHERE id=?")
      .bind(id)
      .first<Archive & { snapshot: string }>();
    if (!item) throw new NotFoundError("Archive not found.");
    return {
      ...item,
      snapshot: JSON.parse(item.snapshot) as Record<string, unknown>,
    };
  }
  const { results } = await database()
    .prepare(
      "SELECT id,original_user_id,email,name,source,actor_id,reason,media_delete_after,media_purged_at,created_at FROM deleted_accounts ORDER BY created_at DESC LIMIT 500",
    )
    .all<Archive>();
  return { items: results };
}
export async function listTickets(userId?: string, search = "", status = "") {
  const { results } = await database()
    .prepare(
      `SELECT t.*,COALESCE(u.plan_override,CASE WHEN s.status IN ('active','trialing') THEN s.tier END,'starter') AS tier FROM support_tickets t
    LEFT JOIN users u ON u.id=t.user_id LEFT JOIN subscriptions s ON s.user_id=t.user_id
    WHERE (? IS NULL OR t.user_id=?) AND (?='' OR t.status=?) AND (t.subject LIKE ? OR t.requester_email LIKE ?)
    ORDER BY t.updated_at DESC LIMIT 200`,
    )
    .bind(
      userId ?? null,
      userId ?? null,
      status,
      status,
      `%${search}%`,
      `%${search}%`,
    )
    .all<Ticket>();
  return { items: results };
}
export async function ticketThread(
  id: string,
  userId?: string,
  markRead = false,
): Promise<TicketThread> {
  const ticket = await database()
    .prepare(
      "SELECT * FROM support_tickets WHERE id=? AND (? IS NULL OR user_id=?)",
    )
    .bind(id, userId ?? null, userId ?? null)
    .first<Ticket>();
  if (!ticket) throw new NotFoundError("Support ticket not found.");
  if (markRead)
    await database()
      .prepare("UPDATE support_tickets SET unread=0 WHERE id=?")
      .bind(id)
      .run();
  const { results } = await database()
    .prepare(
      "SELECT * FROM support_messages WHERE ticket_id=? ORDER BY created_at,id",
    )
    .bind(id)
    .all<TicketThread["messages"][number]>();
  return { ...ticket, messages: results };
}
export async function createTicket(input: {
  userId?: string;
  email: string;
  name: string;
  subject: string;
  category: string;
  message: string;
}) {
  const id = crypto.randomUUID(),
    mailId = crypto.randomUUID(),
    now = Date.now(),
    runtime = mailRuntime();
  const text = `Hi ${input.name},\n\nYour support ticket is open. Reply to this email to add more detail to the same thread.\n\n${input.message}`;
  await database().batch([
    database()
      .prepare(
        "INSERT INTO support_tickets(id,user_id,requester_email,requester_name,subject,category,updated_at) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        input.userId ?? null,
        input.email,
        input.name,
        input.subject,
        input.category,
        now,
      ),
    database()
      .prepare(
        "INSERT INTO support_messages(id,ticket_id,author_type,author_name,author_email,channel,body) VALUES (?,?,'user',?,?,'web',?)",
      )
      .bind(crypto.randomUUID(), id, input.name, input.email, input.message),
    mailInsert(runtime, {
      id: mailId,
      ticketId: id,
      to: input.email,
      subject: `Support ticket ${id} — ${input.subject}`,
      heading: "Your support ticket is open",
      body: text,
      replyTo: supportReplyAddress(id, runtime.SUPPORT_EMAIL),
    }),
  ]);
  await enqueueMail(runtime, mailId);
  return ticketThread(id, input.userId);
}
function mailInsert(
  runtime: MailRuntime,
  input: {
    id: string;
    ticketId?: string;
    dispatchId?: string;
    actorId?: string;
    to: string;
    subject: string;
    heading: string;
    body: string;
    replyTo?: string;
  },
) {
  return runtime.DB.prepare(
    `INSERT OR IGNORE INTO admin_emails(id,direction,ticket_id,dispatch_id,actor_id,from_address,to_address,subject,body,html,reply_to,status)
    VALUES (?,'outbound',?,?,?,?,?,?,?,?,?,'queued')`,
  ).bind(
    input.id,
    input.ticketId ?? null,
    input.dispatchId ?? null,
    input.actorId ?? null,
    runtime.EMAIL_FROM ?? "Vidxir AI Support <support@vidxir.com>",
    input.to,
    input.subject,
    input.body,
    renderMail(input.heading, input.body),
    input.replyTo ?? runtime.SUPPORT_EMAIL ?? "support@vidxir.com",
  );
}
export async function replyTicket(
  actorId: string,
  id: string,
  message: string,
  closeTicket: boolean,
  requestId: string,
) {
  const actor = await adminAccount(actorId),
    thread = await ticketThread(id),
    runtime = mailRuntime();
  const mailId = `reply:${requestId}`;
  const existing = await database()
    .prepare("SELECT ticket_id,actor_id,body FROM admin_emails WHERE id=?")
    .bind(mailId)
    .first<{ ticket_id: string; actor_id: string; body: string }>();
  if (
    existing &&
    (existing.ticket_id !== id ||
      existing.actor_id !== actorId ||
      existing.body !== message)
  )
    throw new ConflictError("Reply ID was already used.");
  if (existing) {
    await enqueueMail(runtime, mailId);
    return ticketThread(id);
  }
  await database().batch([
    mailInsert(runtime, {
      id: mailId,
      ticketId: id,
      actorId,
      to: thread.requester_email,
      subject: `Re: Support ticket ${id} — ${thread.subject}`,
      heading: closeTicket
        ? "Your ticket has been resolved"
        : "A reply from Vidxir support",
      body: message,
      replyTo: supportReplyAddress(id, runtime.SUPPORT_EMAIL),
    }),
    database()
      .prepare(
        "INSERT OR IGNORE INTO support_messages(id,ticket_id,author_type,author_name,author_email,channel,body) VALUES (?,?,'admin',?,?,'email',?)",
      )
      .bind(mailId, id, actor.name, actor.email, message),
    database()
      .prepare(
        "UPDATE support_tickets SET status=?,unread=0,updated_at=? WHERE id=? AND changes()>0",
      )
      .bind(
        closeTicket
          ? "Resolved"
          : thread.status === "Open"
            ? "In progress"
            : thread.status,
        Date.now(),
        id,
      ),
  ]);
  await enqueueMail(runtime, mailId);
  return ticketThread(id);
}
export async function updateTicket(id: string, status: string) {
  await ticketThread(id);
  await database()
    .prepare("UPDATE support_tickets SET status=?,updated_at=? WHERE id=?")
    .bind(status, Date.now(), id)
    .run();
  return ticketThread(id);
}
export function audienceQuery(draft: MailDraft): {
  where: string;
  params: unknown[];
} {
  const params: unknown[] = [],
    conditions = ["u.role<>'admin'", "u.suspended_at IS NULL"];
  const audience = draft.audience;
  if (audience.verification !== "any")
    conditions.push(
      `u.email_verified_at IS ${audience.verification === "verified" ? "NOT " : ""}NULL`,
    );
  if (audience.tiers.length) {
    conditions.push(
      `COALESCE(u.plan_override,CASE WHEN s.status IN ('active','trialing') THEN s.tier END,'starter') IN (${audience.tiers.map(() => "?").join(",")})`,
    );
    params.push(...audience.tiers);
  }
  if (audience.joinedFrom) {
    conditions.push("u.created_at>=?");
    params.push(Date.parse(audience.joinedFrom));
  }
  if (audience.joinedTo) {
    conditions.push("u.created_at<?");
    params.push(Date.parse(audience.joinedTo) + 86400000);
  }
  if (audience.specificEmails?.length) {
    conditions.push(`u.email_normalized IN (SELECT value FROM json_each(?))`);
    params.push(JSON.stringify(audience.specificEmails));
  }
  return { where: conditions.join(" AND "), params };
}
function draftFingerprint(draft: MailDraft) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        subject: draft.subject,
        heading: draft.heading,
        message: draft.message,
        audience: draft.audience,
      }),
    )
    .digest("hex");
}
export async function previewMail(draft: MailDraft) {
  const { where, params } = audienceQuery(draft);
  const row = await database()
    .prepare(
      `SELECT COUNT(*) AS total FROM users u LEFT JOIN subscriptions s ON s.user_id=u.id WHERE ${where}`,
    )
    .bind(...params)
    .first<{ total: number }>();
  return {
    html: renderMail(draft.heading, draft.message),
    recipientCount: row?.total ?? 0,
    fingerprint: draftFingerprint(draft),
  };
}
export async function dispatchMail(
  actorId: string,
  draft: MailDraft,
  id: string,
  fingerprint: string,
) {
  if (fingerprint !== draftFingerprint(draft))
    throw new ConflictError("Preview the current draft before sending.");
  const existing = await database()
    .prepare("SELECT actor_id,fingerprint FROM mail_dispatches WHERE id=?")
    .bind(id)
    .first<{ actor_id: string; fingerprint: string }>();
  if (existing) {
    if (existing.actor_id !== actorId || existing.fingerprint !== fingerprint)
      throw new ConflictError("Dispatch ID was already used.");
    return dispatchProgress(id);
  }
  const preview = await previewMail(draft);
  if (!preview.recipientCount)
    throw new ValidationError("No users match this audience.");
  const runtime = mailRuntime(),
    { where, params } = audienceQuery(draft);
  // INSERT SELECT snapshots the recipient audience atomically. A single request
  // cannot grow into hundreds of slow provider calls or lose in-memory progress.
  await database().batch([
    database()
      .prepare(
        "INSERT OR IGNORE INTO mail_dispatches(id,actor_id,subject,heading,body,audience,fingerprint) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        actorId,
        draft.subject,
        draft.heading,
        draft.message,
        JSON.stringify(draft.audience),
        fingerprint,
      ),
    database()
      .prepare(
        `INSERT OR IGNORE INTO admin_emails(id,direction,dispatch_id,actor_id,from_address,to_address,subject,body,html,reply_to,status)
      SELECT ?||':'||u.id,'outbound',?,?,?,u.email,?,?,?,?,'queued' FROM users u LEFT JOIN subscriptions s ON s.user_id=u.id WHERE ${where} AND changes()>0`,
      )
      .bind(
        id,
        id,
        actorId,
        runtime.EMAIL_FROM ?? "Vidxir AI Support <support@vidxir.com>",
        draft.subject,
        draft.message,
        renderMail(draft.heading, draft.message),
        runtime.SUPPORT_EMAIL ?? "support@vidxir.com",
        ...params,
      ),
    database()
      .prepare(
        "INSERT OR IGNORE INTO admin_actions(id,actor_id,target_id,action,detail) SELECT ?,?,?,'mail-dispatch',? WHERE EXISTS(SELECT 1 FROM mail_dispatches WHERE id=? AND actor_id=? AND fingerprint=?)",
      )
      .bind(
        `dispatch:${id}`,
        actorId,
        id,
        `${preview.recipientCount} recipients`,
        id,
        actorId,
        fingerprint,
      ),
  ]);
  const saved = await database()
    .prepare("SELECT actor_id,fingerprint FROM mail_dispatches WHERE id=?")
    .bind(id)
    .first<{ actor_id: string; fingerprint: string }>();
  if (saved?.actor_id !== actorId || saved?.fingerprint !== fingerprint)
    throw new ConflictError("Dispatch ID was already used.");
  const { results } = await database()
    .prepare("SELECT id FROM admin_emails WHERE dispatch_id=? LIMIT 100")
    .bind(id)
    .all<{ id: string }>();
  for (const row of results) await enqueueMail(runtime, row.id);
  return dispatchProgress(id);
}
export async function dispatchProgress(id: string): Promise<DispatchProgress> {
  if (
    !(await database()
      .prepare("SELECT id FROM mail_dispatches WHERE id=?")
      .bind(id)
      .first())
  )
    throw new NotFoundError("Mail dispatch not found.");
  const row = await database()
    .prepare(
      `SELECT COUNT(*) AS total,SUM(status IN ('sent','failed','cancelled')) AS processed,SUM(status='sent') AS sent,SUM(status IN ('failed','cancelled')) AS failed,SUM(status='sending') AS sending FROM admin_emails WHERE dispatch_id=?`,
    )
    .bind(id)
    .first<{
      total: number;
      processed: number;
      sent: number;
      failed: number;
      sending: number;
    }>();
  const { results } = await database()
    .prepare(
      "SELECT to_address FROM admin_emails WHERE dispatch_id=? AND status IN ('failed','cancelled')",
    )
    .bind(id)
    .all<{ to_address: string }>();
  return {
    id,
    status:
      row?.processed === row?.total
        ? "completed"
        : row?.sending
          ? "sending"
          : "queued",
    recipientCount: row?.total ?? 0,
    processedCount: row?.processed ?? 0,
    sentCount: row?.sent ?? 0,
    failedCount: row?.failed ?? 0,
    failedEmails: results.map((r) => r.to_address),
  };
}
export async function sendUserMail(
  actorId: string,
  userId: string,
  subject: string,
  heading: string,
  message: string,
  id: string,
) {
  const target = await userDetail(userId),
    runtime = mailRuntime();
  const existing = await database()
    .prepare(
      "SELECT actor_id,to_address,subject,body FROM admin_emails WHERE id=?",
    )
    .bind(id)
    .first<{
      actor_id: string;
      to_address: string;
      subject: string;
      body: string;
    }>();
  if (
    existing &&
    (existing.actor_id !== actorId ||
      existing.to_address !== target.email ||
      existing.subject !== subject ||
      existing.body !== message)
  )
    throw new ConflictError("Email ID was already used.");
  await mailInsert(runtime, {
    id,
    actorId,
    to: target.email,
    subject,
    heading,
    body: message,
  }).run();
  await enqueueMail(runtime, id);
  return { id };
}
export async function listMail(
  direction: string,
  search: string,
  page: number,
) {
  const where =
    "(?='' OR direction=?) AND (subject LIKE ? OR from_address LIKE ? OR to_address LIKE ?)";
  const params = [
    direction,
    direction,
    `%${search}%`,
    `%${search}%`,
    `%${search}%`,
  ];
  const { results } = await database()
    .prepare(
      `SELECT id,direction,dispatch_id,ticket_id,from_address,to_address,subject,status,error,read_at,created_at,
    (SELECT type FROM email_events WHERE provider_id=admin_emails.provider_id ORDER BY occurred_at DESC,created_at DESC LIMIT 1) AS latest_event
    FROM admin_emails WHERE ${where} ORDER BY created_at DESC LIMIT 30 OFFSET ?`,
    )
    .bind(...params, (page - 1) * 30)
    .all<MailRow>();
  const total = await database()
    .prepare(`SELECT COUNT(*) AS total FROM admin_emails WHERE ${where}`)
    .bind(...params)
    .first<{ total: number }>();
  return { items: results, total: total?.total ?? 0, page };
}
export async function mailDetail(id: string) {
  const row = await database()
    .prepare("SELECT * FROM admin_emails WHERE id=?")
    .bind(id)
    .first<MailRow>();
  if (!row) throw new NotFoundError("Email not found.");
  await database()
    .prepare("UPDATE admin_emails SET read_at=? WHERE id=?")
    .bind(Date.now(), id)
    .run();
  const events = await database()
    .prepare(
      "SELECT id,type,occurred_at FROM email_events WHERE provider_id=? ORDER BY occurred_at",
    )
    .bind(row.provider_id)
    .all<{ id: string; type: string; occurred_at: number }>();
  return { ...row, events: events.results };
}

/** Campaign history survives reloads and is shared by authorized administrators. */
export async function listDispatches(page: number) {
  const { results } = await database()
    .prepare(
      `SELECT d.id,d.subject,d.created_at,COALESCE(u.name,'Former administrator') AS actor_name,
    COUNT(m.id) AS recipientCount,COALESCE(SUM(m.status IN ('sent','failed','cancelled')),0) AS processedCount,
    COALESCE(SUM(m.status='sent'),0) AS sentCount,COALESCE(SUM(m.status IN ('failed','cancelled')),0) AS failedCount,
    CASE WHEN COUNT(m.id)=COALESCE(SUM(m.status IN ('sent','failed','cancelled')),0) THEN 'completed'
      WHEN COALESCE(SUM(m.status='sending'),0)>0 THEN 'sending' ELSE 'queued' END AS status
    FROM mail_dispatches d LEFT JOIN users u ON u.id=d.actor_id LEFT JOIN admin_emails m ON m.dispatch_id=d.id
    GROUP BY d.id ORDER BY d.created_at DESC,d.id LIMIT 20 OFFSET ?`,
    )
    .bind((page - 1) * 20)
    .all<DispatchSummary>();
  const count = await database()
    .prepare("SELECT COUNT(*) AS total FROM mail_dispatches")
    .first<{ total: number }>();
  return { items: results, total: count?.total ?? 0, page };
}
export async function dispatchDetail(id: string): Promise<DispatchDetail> {
  const row = await database()
    .prepare(
      `SELECT d.*,COALESCE(u.name,'Former administrator') AS actor_name FROM mail_dispatches d
    LEFT JOIN users u ON u.id=d.actor_id WHERE d.id=?`,
    )
    .bind(id)
    .first<{
      subject: string;
      heading: string;
      body: string;
      audience: string;
      actor_name: string;
      created_at: number;
    }>();
  if (!row) throw new NotFoundError("Mail dispatch not found.");
  return {
    ...(await dispatchProgress(id)),
    draft: {
      subject: row.subject,
      heading: row.heading,
      message: row.body,
      audience: JSON.parse(row.audience) as MailDraft["audience"],
    },
    actor_name: row.actor_name,
    created_at: row.created_at,
  };
}
