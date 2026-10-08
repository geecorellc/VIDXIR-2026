import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
const now = () =>
  integer("created_at")
    .notNull()
    .default(sql`(unixepoch()*1000)`);
export const adminActions = sqliteTable("admin_actions", {
  id: text("id").primaryKey(),
  actorId: text("actor_id").notNull(),
  targetId: text("target_id").notNull(),
  action: text("action").notNull(),
  detail: text("detail"),
  createdAt: now(),
});
export const deletedAccounts = sqliteTable("deleted_accounts", {
  id: text("id").primaryKey(),
  originalUserId: text("original_user_id").notNull(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  source: text("source").notNull(),
  actorId: text("actor_id").notNull(),
  reason: text("reason").notNull(),
  snapshot: text("snapshot", { mode: "json" }).notNull(),
  mediaDeleteAfter: integer("media_delete_after").notNull(),
  mediaPurgedAt: integer("media_purged_at"),
  createdAt: now(),
});
export const supportTickets = sqliteTable(
  "support_tickets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    requesterEmail: text("requester_email").notNull(),
    requesterName: text("requester_name").notNull(),
    subject: text("subject").notNull(),
    category: text("category").notNull(),
    status: text("status").notNull().default("Open"),
    unread: integer("unread").notNull().default(1),
    updatedAt: integer("updated_at").notNull(),
    createdAt: now(),
  },
  (t) => [index("support_user_idx").on(t.userId)],
);
export const supportMessages = sqliteTable(
  "support_messages",
  {
    id: text("id").primaryKey(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => supportTickets.id),
    authorType: text("author_type").notNull(),
    authorName: text("author_name").notNull(),
    authorEmail: text("author_email").notNull(),
    channel: text("channel").notNull(),
    body: text("body").notNull(),
    createdAt: now(),
  },
  (t) => [index("support_message_ticket_idx").on(t.ticketId)],
);
export const mailDispatches = sqliteTable("mail_dispatches", {
  id: text("id").primaryKey(),
  actorId: text("actor_id").notNull(),
  subject: text("subject").notNull(),
  heading: text("heading").notNull(),
  body: text("body").notNull(),
  audience: text("audience").notNull(),
  fingerprint: text("fingerprint").notNull(),
  createdAt: now(),
});
export const adminEmails = sqliteTable(
  "admin_emails",
  {
    id: text("id").primaryKey(),
    direction: text("direction").notNull(),
    dispatchId: text("dispatch_id"),
    ticketId: text("ticket_id"),
    actorId: text("actor_id"),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    html: text("html"),
    replyTo: text("reply_to"),
    providerId: text("provider_id").unique(),
    status: text("status").notNull(),
    error: text("error"),
    attachments: text("attachments").notNull().default("[]"),
    readAt: integer("read_at"),
    attemptedAt: integer("attempted_at"),
    leaseUntil: integer("lease_until"),
    createdAt: now(),
  },
  (t) => [
    index("admin_email_dispatch_idx").on(t.dispatchId),
    index("admin_email_status_idx").on(t.status),
  ],
);
export const emailEvents = sqliteTable(
  "email_events",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id").notNull(),
    type: text("type").notNull(),
    occurredAt: integer("occurred_at").notNull(),
    createdAt: now(),
  },
  (t) => [index("email_event_provider_idx").on(t.providerId)],
);
