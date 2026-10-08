CREATE TABLE `admin_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`target_id` text NOT NULL,
	`action` text NOT NULL,
	`detail` text,
	`created_at` integer DEFAULT (unixepoch()*1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `admin_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`direction` text NOT NULL,
	`dispatch_id` text,
	`ticket_id` text,
	`actor_id` text,
	`from_address` text NOT NULL,
	`to_address` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`html` text,
	`reply_to` text,
	`provider_id` text,
	`status` text NOT NULL,
	`error` text,
	`attachments` text DEFAULT '[]' NOT NULL,
	`read_at` integer,
	`attempted_at` integer,
	`lease_until` integer,
	`created_at` integer DEFAULT (unixepoch()*1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_emails_provider_id_unique` ON `admin_emails` (`provider_id`);--> statement-breakpoint
CREATE INDEX `admin_email_dispatch_idx` ON `admin_emails` (`dispatch_id`);--> statement-breakpoint
CREATE INDEX `admin_email_status_idx` ON `admin_emails` (`status`);--> statement-breakpoint
CREATE TABLE `deleted_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`original_user_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`actor_id` text NOT NULL,
	`reason` text NOT NULL,
	`snapshot` text NOT NULL,
	`media_delete_after` integer NOT NULL,
	`media_purged_at` integer,
	`created_at` integer DEFAULT (unixepoch()*1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `email_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`type` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()*1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `email_event_provider_idx` ON `email_events` (`provider_id`);--> statement-breakpoint
CREATE TABLE `mail_dispatches` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`subject` text NOT NULL,
	`heading` text NOT NULL,
	`body` text NOT NULL,
	`audience` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()*1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `support_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`author_type` text NOT NULL,
	`author_name` text NOT NULL,
	`author_email` text NOT NULL,
	`channel` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()*1000) NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `support_tickets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `support_message_ticket_idx` ON `support_messages` (`ticket_id`);--> statement-breakpoint
CREATE TABLE `support_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`requester_email` text NOT NULL,
	`requester_name` text NOT NULL,
	`subject` text NOT NULL,
	`category` text NOT NULL,
	`status` text DEFAULT 'Open' NOT NULL,
	`unread` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()*1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `support_user_idx` ON `support_tickets` (`user_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `suspended_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `plan_override` text;