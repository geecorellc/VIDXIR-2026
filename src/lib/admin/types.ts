export type TicketStatus = "Open" | "In progress" | "Resolved";
export interface Ticket {
  id: string;
  user_id: string | null;
  requester_email: string;
  requester_name: string;
  subject: string;
  category: string;
  status: TicketStatus;
  unread: number;
  created_at: number;
  updated_at: number;
  tier?: string;
}
export interface TicketMessage {
  id: string;
  ticket_id: string;
  author_type: string;
  author_name: string;
  author_email: string;
  channel: string;
  body: string;
  created_at: number;
}
export interface TicketThread extends Ticket {
  messages: TicketMessage[];
}
export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: "user" | "admin";
  email_verified_at: number | null;
  suspended_at: number | null;
  plan_override: string | null;
  created_at: number;
  last_login_at: number | null;
  tier: string;
  subscription_status: string;
}
export interface UserDetail extends AdminUser {
  credits: {
    available: number;
    unlimited?: boolean;
    granted: number;
    purchased: number;
    spent: number;
  };
  projects: { id: string; title: string; status: string; created_at: number }[];
  channels: {
    id: string;
    title: string;
    youtube_channel_id: string;
    disconnected_at: number | null;
  }[];
  publications: {
    id: string;
    project_id: string;
    title: string;
    channel_title: string;
    youtube_video_id: string;
    upload_status: string | null;
    privacy_status: string | null;
    published_at: number | null;
    scheduled_publish_at: number | null;
    created_at: number;
  }[];
  actions: {
    id: string;
    actor_id: string;
    action: string;
    detail: string | null;
    created_at: number;
  }[];
}
export interface MailRow {
  id: string;
  direction: string;
  dispatch_id: string | null;
  ticket_id: string | null;
  from_address: string;
  to_address: string;
  subject: string;
  body: string;
  html: string | null;
  reply_to: string | null;
  provider_id: string | null;
  status: string;
  error: string | null;
  attachments: string;
  read_at: number | null;
  attempted_at: number | null;
  lease_until: number | null;
  created_at: number;
}
export interface Audience {
  tiers: string[];
  verification: "any" | "verified" | "unverified";
  joinedFrom?: string;
  joinedTo?: string;
  specificEmails?: string[];
}
export interface MailDraft {
  subject: string;
  heading: string;
  message: string;
  audience: Audience;
}
export interface DispatchProgress {
  id: string;
  status: "queued" | "sending" | "completed";
  recipientCount: number;
  processedCount: number;
  sentCount: number;
  failedCount: number;
  failedEmails: string[];
}
export interface Archive {
  id: string;
  original_user_id: string;
  email: string;
  name: string;
  source: string;
  actor_id: string;
  reason: string;
  media_delete_after: number;
  media_purged_at: number | null;
  created_at: number;
  snapshot?: Record<string, unknown>;
}

export interface DispatchSummary extends Omit<
  DispatchProgress,
  "failedEmails"
> {
  subject: string;
  actor_name: string;
  created_at: number;
}
export interface DispatchDetail extends DispatchProgress {
  draft: MailDraft;
  actor_name: string;
  created_at: number;
}
