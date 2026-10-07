CREATE TABLE `analytics_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`published_video_id` text,
	`date` integer NOT NULL,
	`views` integer,
	`likes` integer,
	`comments` integer,
	`shares` integer,
	`subscribers_gained` integer,
	`subscribers_lost` integer,
	`impressions` integer,
	`ctr` real,
	`ctr_source` text,
	`watch_time_minutes` real,
	`average_view_duration_seconds` real,
	`average_view_percentage` real,
	`estimated_revenue_cents` integer,
	`estimated_revenue` real,
	`revenue_currency` text,
	`revenue_state` text,
	`revenue_final` integer,
	`raw` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`published_video_id`) REFERENCES `published_videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analytics_snapshots_video_date_key` ON `analytics_snapshots` (`channel_id`,`published_video_id`,`date`) WHERE "analytics_snapshots"."published_video_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `analytics_snapshots_channel_date_key` ON `analytics_snapshots` (`channel_id`,`date`) WHERE "analytics_snapshots"."published_video_id" is null;--> statement-breakpoint
CREATE INDEX `analytics_snapshots_user_id_idx` ON `analytics_snapshots` (`user_id`);--> statement-breakpoint
CREATE INDEX `analytics_snapshots_channel_date_idx` ON `analytics_snapshots` (`channel_id`,`date`);--> statement-breakpoint
CREATE TABLE `api_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`project_id` text,
	`job_id` text,
	`provider` text NOT NULL,
	`operation` text NOT NULL,
	`model` text,
	`quantity` integer,
	`unit` text,
	`estimated_cost_cents` integer,
	`http_status` integer,
	`ok` integer DEFAULT true NOT NULL,
	`error_code` text,
	`duration_ms` integer,
	`trace_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `api_usage_provider_created_idx` ON `api_usage` (`provider`,`created_at`);--> statement-breakpoint
CREATE INDEX `api_usage_user_created_idx` ON `api_usage` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text,
	`channel_id` text,
	`kind` text NOT NULL,
	`storage_key` text,
	`mime_type` text,
	`bytes` integer,
	`width` integer,
	`height` integer,
	`duration_ms` integer,
	`checksum_sha256` text,
	`provider` text,
	`provider_asset_id` text,
	`source_url` text,
	`license` text,
	`attribution` text,
	`author_name` text,
	`meta` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `assets_project_kind_idx` ON `assets` (`project_id`,`kind`);--> statement-breakpoint
CREATE INDEX `assets_user_id_idx` ON `assets` (`user_id`);--> statement-breakpoint
CREATE TABLE `automation_settings` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`level` text DEFAULT 'manual' NOT NULL,
	`publish_days` text DEFAULT '[1,3,5]' NOT NULL,
	`publish_times` text DEFAULT '["18:00"]' NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`videos_per_week` integer DEFAULT 3 NOT NULL,
	`auto_publish` integer DEFAULT false NOT NULL,
	`require_approval` integer DEFAULT true NOT NULL,
	`last_run_at` integer,
	`next_run_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `automation_settings_user_id_idx` ON `automation_settings` (`user_id`);--> statement-breakpoint
CREATE INDEX `automation_settings_next_run_idx` ON `automation_settings` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE TABLE `billing_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`user_id` text,
	`provider_customer_id` text,
	`provider_subscription_id` text,
	`event_created_at` integer NOT NULL,
	`applied` integer DEFAULT false NOT NULL,
	`skip_reason` text,
	`payload` text NOT NULL,
	`received_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_events_provider_event_key` ON `billing_events` (`provider`,`provider_event_id`);--> statement-breakpoint
CREATE INDEX `billing_events_user_received_idx` ON `billing_events` (`user_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `billing_events_subscription_idx` ON `billing_events` (`provider_subscription_id`);--> statement-breakpoint
CREATE TABLE `brand_kits` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`brand_name` text,
	`logo_asset_id` text,
	`primary_color` text,
	`secondary_color` text,
	`font_preference` text,
	`intro_asset_id` text,
	`outro_asset_id` text,
	`default_cta` text,
	`caption_style` text,
	`thumbnail_style` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `brand_kits_user_id_idx` ON `brand_kits` (`user_id`);--> statement-breakpoint
CREATE TABLE `captions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`language` text DEFAULT 'en' NOT NULL,
	`provider` text,
	`cues` text DEFAULT '[]' NOT NULL,
	`srt_asset_id` text,
	`vtt_asset_id` text,
	`burned_in` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`srt_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`vtt_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `captions_project_idx` ON `captions` (`project_id`);--> statement-breakpoint
CREATE INDEX `captions_user_id_idx` ON `captions` (`user_id`);--> statement-breakpoint
CREATE TABLE `channel_settings` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`niche` text,
	`target_audience` text,
	`content_language` text DEFAULT 'en-US' NOT NULL,
	`preferred_length_seconds` integer DEFAULT 480 NOT NULL,
	`uploads_per_week` integer DEFAULT 1 NOT NULL,
	`content_style` text,
	`video_style` text,
	`thumbnail_style` text,
	`voice_provider_voice_id` text,
	`voice_style` text,
	`voice_speed` real DEFAULT 1 NOT NULL,
	`competitor_channel_ids` text DEFAULT '[]' NOT NULL,
	`keywords` text DEFAULT '[]' NOT NULL,
	`score_weights` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `channel_settings_user_id_idx` ON `channel_settings` (`user_id`);--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`youtube_channel_id` text NOT NULL,
	`title` text NOT NULL,
	`handle` text,
	`description` text,
	`thumbnail_url` text,
	`subscriber_count` integer,
	`video_count` integer,
	`view_count` real,
	`stats_refreshed_at` integer,
	`access_token_enc` text,
	`refresh_token_enc` text,
	`token_expires_at` integer,
	`granted_scopes` text,
	`reauth_required_at` integer,
	`last_token_error_message` text,
	`connected_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`disconnected_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channels_user_youtube_key` ON `channels` (`user_id`,`youtube_channel_id`);--> statement-breakpoint
CREATE INDEX `channels_user_id_idx` ON `channels` (`user_id`);--> statement-breakpoint
CREATE TABLE `credit_balances` (
	`user_id` text PRIMARY KEY NOT NULL,
	`granted` integer DEFAULT 0 NOT NULL,
	`purchased` integer DEFAULT 0 NOT NULL,
	`spent` integer DEFAULT 0 NOT NULL,
	`period` text NOT NULL,
	`granted_for_tier` text DEFAULT 'starter' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "credit_balances_non_negative" CHECK("credit_balances"."granted" >= 0 AND "credit_balances"."purchased" >= 0 AND "credit_balances"."spent" >= 0 AND "credit_balances"."granted" + "credit_balances"."purchased" - "credit_balances"."spent" >= 0)
);
--> statement-breakpoint
CREATE INDEX `credit_balances_period_idx` ON `credit_balances` (`period`);--> statement-breakpoint
CREATE TABLE `credit_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`reason` text NOT NULL,
	`amount` integer NOT NULL,
	`balance_after` integer NOT NULL,
	`operation` text,
	`model_id` text,
	`quality` text,
	`project_id` text,
	`idempotency_key` text,
	`period` text NOT NULL,
	`description` text,
	`meta` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "credit_ledger_sign_matches_reason" CHECK(("credit_ledger"."reason" = 'spend' AND "credit_ledger"."amount" < 0) OR ("credit_ledger"."reason" <> 'spend' AND "credit_ledger"."amount" > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_ledger_idempotency_key` ON `credit_ledger` (`idempotency_key`) WHERE "credit_ledger"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `credit_ledger_user_created_idx` ON `credit_ledger` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `credit_ledger_user_period_idx` ON `credit_ledger` (`user_id`,`period`);--> statement-breakpoint
CREATE INDEX `credit_ledger_project_idx` ON `credit_ledger` (`project_id`);--> statement-breakpoint
CREATE TABLE `credit_purchases` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`pack` text NOT NULL,
	`credits` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'usd' NOT NULL,
	`provider_session_id` text NOT NULL,
	`provider_payment_intent_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`ledger_id` text,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ledger_id`) REFERENCES `credit_ledger`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_purchases_session_key` ON `credit_purchases` (`provider_session_id`);--> statement-breakpoint
CREATE INDEX `credit_purchases_user_created_idx` ON `credit_purchases` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `email_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`purpose` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_tokens_token_hash_key` ON `email_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `email_tokens_user_purpose_idx` ON `email_tokens` (`user_id`,`purpose`);--> statement-breakpoint
CREATE TABLE `ideas` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`channel_id` text,
	`run_id` text,
	`title` text NOT NULL,
	`angle` text,
	`rationale` text,
	`hook` text,
	`trend_signal` text,
	`topic` text,
	`target_keywords` text DEFAULT '[]' NOT NULL,
	`source_result_ids` text DEFAULT '[]' NOT NULL,
	`trend_score` real,
	`opportunity_score` real,
	`competition_score` real,
	`audience_fit_score` real,
	`velocity_score` real,
	`freshness_score` real,
	`vidxir_score` real,
	`score_breakdown` text,
	`state` text DEFAULT 'new' NOT NULL,
	`generated_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `research_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ideas_channel_state_idx` ON `ideas` (`channel_id`,`state`);--> statement-breakpoint
CREATE INDEX `ideas_user_id_idx` ON `ideas` (`user_id`);--> statement-breakpoint
CREATE INDEX `ideas_score_idx` ON `ideas` (`channel_id`,`vidxir_score`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text,
	`channel_id` text,
	`queue` text NOT NULL,
	`name` text NOT NULL,
	`stage` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`status_message` text,
	`priority` integer DEFAULT 1 NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`queue_job_id` text,
	`trace_id` text,
	`payload` text,
	`result` text,
	`error` text,
	`error_code` text,
	`not_configured_provider` text,
	`scheduled_for` integer,
	`started_at` integer,
	`finished_at` integer,
	`duration_ms` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jobs_project_stage_idx` ON `jobs` (`project_id`,`stage`);--> statement-breakpoint
CREATE INDEX `jobs_user_status_idx` ON `jobs` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `jobs_queue_job_idx` ON `jobs` (`queue_job_id`);--> statement-breakpoint
CREATE INDEX `jobs_trace_idx` ON `jobs` (`trace_id`);--> statement-breakpoint
CREATE TABLE `music_tracks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`asset_id` text,
	`role` text DEFAULT 'background' NOT NULL,
	`mood` text,
	`bpm` integer,
	`volume` real DEFAULT 0.14 NOT NULL,
	`duck_under_narration` integer DEFAULT true NOT NULL,
	`start_ms` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `music_tracks_project_idx` ON `music_tracks` (`project_id`);--> statement-breakpoint
CREATE INDEX `music_tracks_user_id_idx` ON `music_tracks` (`user_id`);--> statement-breakpoint
CREATE TABLE `onboarding_profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`declared_channel_url` text,
	`niche` text,
	`target_audience` text,
	`content_language` text DEFAULT 'en-US' NOT NULL,
	`preferred_length_seconds` integer DEFAULT 480 NOT NULL,
	`uploads_per_week` integer DEFAULT 1 NOT NULL,
	`content_style` text,
	`voice_preference` text,
	`automation_level` text DEFAULT 'manual' NOT NULL,
	`publish_days` text DEFAULT '[1,3,5]' NOT NULL,
	`publish_times` text DEFAULT '["18:00"]' NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`last_step` integer DEFAULT 0 NOT NULL,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `plans` (
	`tier` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`price_cents` integer NOT NULL,
	`max_channels` integer,
	`max_videos_per_month` integer,
	`monthly_credits` integer DEFAULT 0 NOT NULL,
	`features` text DEFAULT '{}' NOT NULL,
	`queue_priority` integer DEFAULT 1 NOT NULL,
	`stripe_price_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_edits` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`document` text NOT NULL,
	`duration_ms` integer,
	`last_rendered_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_edits_project_key` ON `project_edits` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_edits_user_id_idx` ON `project_edits` (`user_id`);--> statement-breakpoint
CREATE TABLE `project_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`stage` text,
	`message` text,
	`meta` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_events_project_idx` ON `project_events` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`channel_id` text,
	`idea_id` text,
	`title` text NOT NULL,
	`status` text DEFAULT 'IDEA' NOT NULL,
	`current_stage` text,
	`progress` integer DEFAULT 0 NOT NULL,
	`failed_stage` text,
	`error_message` text,
	`error_code` text,
	`failed_at` integer,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`origin` text DEFAULT 'manual' NOT NULL,
	`trace_id` text,
	`target_duration_seconds` integer,
	`generation_mode` text,
	`generation_model` text,
	`video_format` text,
	`video_quality` text,
	`source_video_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`idea_id`) REFERENCES `ideas`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `projects_user_status_idx` ON `projects` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `projects_channel_created_idx` ON `projects` (`channel_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `publish_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`visibility` text DEFAULT 'public' NOT NULL,
	`scheduled_for` integer,
	`approved_by_user_id` text,
	`approved_at` integer,
	`upload_progress` integer DEFAULT 0 NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`error` text,
	`error_code` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`approved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `publish_jobs_status_sched_idx` ON `publish_jobs` (`status`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `publish_jobs_project_idx` ON `publish_jobs` (`project_id`);--> statement-breakpoint
CREATE INDEX `publish_jobs_user_id_idx` ON `publish_jobs` (`user_id`);--> statement-breakpoint
CREATE TABLE `published_videos` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`publish_job_id` text,
	`youtube_video_id` text NOT NULL,
	`url` text NOT NULL,
	`upload_status` text,
	`privacy_status` text,
	`published_at` integer,
	`scheduled_publish_at` integer,
	`thumbnail_variant_id` text,
	`title_used` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`publish_job_id`) REFERENCES `publish_jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`thumbnail_variant_id`) REFERENCES `thumbnail_variants`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `published_videos_youtube_id_key` ON `published_videos` (`youtube_video_id`);--> statement-breakpoint
CREATE INDEX `published_videos_channel_idx` ON `published_videos` (`channel_id`,`published_at`);--> statement-breakpoint
CREATE INDEX `published_videos_user_id_idx` ON `published_videos` (`user_id`);--> statement-breakpoint
CREATE TABLE `quality_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`verdict` text NOT NULL,
	`findings` text DEFAULT '[]' NOT NULL,
	`asset_licenses` text DEFAULT '[]' NOT NULL,
	`acknowledged_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `quality_checks_project_idx` ON `quality_checks` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `quality_checks_user_id_idx` ON `quality_checks` (`user_id`);--> statement-breakpoint
CREATE TABLE `renders` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_render_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`timeline` text,
	`width` integer DEFAULT 1920 NOT NULL,
	`height` integer DEFAULT 1080 NOT NULL,
	`fps` integer DEFAULT 30 NOT NULL,
	`duration_ms` integer,
	`output_asset_id` text,
	`poster_asset_id` text,
	`error` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`output_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`poster_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `renders_project_idx` ON `renders` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `renders_user_id_idx` ON `renders` (`user_id`);--> statement-breakpoint
CREATE INDEX `renders_provider_render_idx` ON `renders` (`provider_render_id`);--> statement-breakpoint
CREATE TABLE `research_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`user_id` text NOT NULL,
	`channel_id` text,
	`source` text NOT NULL,
	`youtube_video_id` text,
	`youtube_channel_id` text,
	`channel_title` text,
	`title` text NOT NULL,
	`url` text,
	`published_at` integer,
	`view_count` real,
	`like_count` integer,
	`comment_count` integer,
	`views_per_hour` real,
	`engagement_rate` real,
	`topic` text,
	`raw` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `research_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `research_results_run_idx` ON `research_results` (`run_id`);--> statement-breakpoint
CREATE INDEX `research_results_channel_idx` ON `research_results` (`channel_id`);--> statement-breakpoint
CREATE INDEX `research_results_video_idx` ON `research_results` (`youtube_video_id`);--> statement-breakpoint
CREATE TABLE `research_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`channel_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`description` text,
	`source_video_id` text,
	`source_title` text,
	`source_channel_title` text,
	`source_analysis` text,
	`niche` text,
	`keywords` text DEFAULT '[]' NOT NULL,
	`sources` text DEFAULT '[]' NOT NULL,
	`demand_series` text,
	`error` text,
	`error_code` text,
	`project_id` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `research_runs_channel_created_idx` ON `research_runs` (`channel_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `research_runs_user_id_idx` ON `research_runs` (`user_id`);--> statement-breakpoint
CREATE INDEX `research_runs_project_idx` ON `research_runs` (`project_id`);--> statement-breakpoint
CREATE TABLE `scenes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`script_version_id` text,
	`index` integer NOT NULL,
	`label` text,
	`narration` text NOT NULL,
	`visual_prompt` text,
	`search_terms` text DEFAULT '[]' NOT NULL,
	`on_screen_text` text,
	`start_ms` integer,
	`duration_ms` integer,
	`transition` text,
	`visual_asset_id` text,
	`continuity_state` text,
	`continuity_prompt` text,
	`continuity_regenerations` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`script_version_id`) REFERENCES `script_versions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scenes_project_index_key` ON `scenes` (`project_id`,`index`);--> statement-breakpoint
CREATE INDEX `scenes_user_id_idx` ON `scenes` (`user_id`);--> statement-breakpoint
CREATE TABLE `script_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`script_id` text NOT NULL,
	`user_id` text NOT NULL,
	`version` integer NOT NULL,
	`title` text NOT NULL,
	`title_ideas` text DEFAULT '[]' NOT NULL,
	`hook` text NOT NULL,
	`introduction` text,
	`sections` text DEFAULT '[]' NOT NULL,
	`conclusion` text,
	`cta` text,
	`story_structure` text,
	`references` text DEFAULT '[]' NOT NULL,
	`estimated_duration_seconds` integer,
	`word_count` integer,
	`source` text DEFAULT 'ai' NOT NULL,
	`provider` text,
	`model` text,
	`prompt_tokens` integer,
	`output_tokens` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`script_id`) REFERENCES `scripts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `script_versions_script_version_key` ON `script_versions` (`script_id`,`version`);--> statement-breakpoint
CREATE INDEX `script_versions_user_id_idx` ON `script_versions` (`user_id`);--> statement-breakpoint
CREATE TABLE `scripts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`active_version_id` text,
	`approved_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scripts_project_key` ON `scripts` (`project_id`);--> statement-breakpoint
CREATE INDEX `scripts_user_id_idx` ON `scripts` (`user_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`user_agent` text,
	`ip_address` text,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`last_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_key` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `story_bibles` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`level` text DEFAULT 'off' NOT NULL,
	`document` text NOT NULL,
	`generated_by` text,
	`edited_by_user` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `story_bibles_project_key` ON `story_bibles` (`project_id`);--> statement-breakpoint
CREATE INDEX `story_bibles_user_id_idx` ON `story_bibles` (`user_id`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tier` text DEFAULT 'starter' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`provider` text DEFAULT 'none' NOT NULL,
	`provider_customer_id` text,
	`provider_subscription_id` text,
	`current_period_start` integer,
	`current_period_end` integer,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`trial_ends_at` integer,
	`last_event_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_user_id_key` ON `subscriptions` (`user_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_provider_sub_idx` ON `subscriptions` (`provider_subscription_id`);--> statement-breakpoint
CREATE TABLE `thumbnail_experiment_arms` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_id` text NOT NULL,
	`user_id` text NOT NULL,
	`thumbnail_variant_id` text NOT NULL,
	`position` integer NOT NULL,
	`is_control` integer DEFAULT false NOT NULL,
	`impressions` integer,
	`clicks` integer,
	`views` integer,
	`ctr` real,
	`metrics_source` text,
	`observation_days` integer DEFAULT 0 NOT NULL,
	`last_observed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`experiment_id`) REFERENCES `thumbnail_experiments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thumbnail_variant_id`) REFERENCES `thumbnail_variants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thumbnail_experiment_arms_position_key` ON `thumbnail_experiment_arms` (`experiment_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `thumbnail_experiment_arms_variant_key` ON `thumbnail_experiment_arms` (`experiment_id`,`thumbnail_variant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `thumbnail_experiment_arms_control_key` ON `thumbnail_experiment_arms` (`experiment_id`) WHERE "thumbnail_experiment_arms"."is_control";--> statement-breakpoint
CREATE INDEX `thumbnail_experiment_arms_user_idx` ON `thumbnail_experiment_arms` (`user_id`);--> statement-breakpoint
CREATE TABLE `thumbnail_experiment_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_id` text NOT NULL,
	`arm_id` text NOT NULL,
	`user_id` text NOT NULL,
	`date` integer NOT NULL,
	`impressions` integer,
	`clicks` integer,
	`views` integer,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`experiment_id`) REFERENCES `thumbnail_experiments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`arm_id`) REFERENCES `thumbnail_experiment_arms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thumbnail_experiment_observations_arm_date_key` ON `thumbnail_experiment_observations` (`arm_id`,`date`);--> statement-breakpoint
CREATE INDEX `thumbnail_experiment_observations_experiment_idx` ON `thumbnail_experiment_observations` (`experiment_id`,`date`);--> statement-breakpoint
CREATE INDEX `thumbnail_experiment_observations_user_idx` ON `thumbnail_experiment_observations` (`user_id`);--> statement-breakpoint
CREATE TABLE `thumbnail_experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`published_video_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`winning_arm_id` text,
	`outcome` text,
	`decision_policy` text,
	`decision` text,
	`decided_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`published_video_id`) REFERENCES `published_videos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`winning_arm_id`) REFERENCES `thumbnail_experiment_arms`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thumbnail_experiments_live_video_key` ON `thumbnail_experiments` (`published_video_id`) WHERE "thumbnail_experiments"."status" in ('draft', 'running');--> statement-breakpoint
CREATE INDEX `thumbnail_experiments_user_idx` ON `thumbnail_experiments` (`user_id`);--> statement-breakpoint
CREATE INDEX `thumbnail_experiments_channel_status_idx` ON `thumbnail_experiments` (`channel_id`,`status`);--> statement-breakpoint
CREATE TABLE `thumbnail_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`thumbnail_id` text NOT NULL,
	`user_id` text NOT NULL,
	`index` integer NOT NULL,
	`headline` text NOT NULL,
	`subline` text,
	`concept` text,
	`emotion` text,
	`background_asset_id` text,
	`image_asset_id` text,
	`impressions` integer,
	`clicks` integer,
	`ctr` real,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`thumbnail_id`) REFERENCES `thumbnails`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`background_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`image_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thumbnail_variants_thumb_index_key` ON `thumbnail_variants` (`thumbnail_id`,`index`);--> statement-breakpoint
CREATE INDEX `thumbnail_variants_user_id_idx` ON `thumbnail_variants` (`user_id`);--> statement-breakpoint
CREATE TABLE `thumbnails` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`selected_variant_id` text,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thumbnails_project_idx` ON `thumbnails` (`project_id`);--> statement-breakpoint
CREATE INDEX `thumbnails_user_id_idx` ON `thumbnails` (`user_id`);--> statement-breakpoint
CREATE TABLE `usage_counters` (
	`user_id` text NOT NULL,
	`period` text NOT NULL,
	`videos_started` integer DEFAULT 0 NOT NULL,
	`videos_published` integer DEFAULT 0 NOT NULL,
	`renders_completed` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `period`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`email_normalized` text NOT NULL,
	`password_hash` text NOT NULL,
	`name` text NOT NULL,
	`email_verified_at` integer,
	`onboarded_at` integer,
	`session_epoch` integer DEFAULT 0 NOT NULL,
	`failed_login_count` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`last_login_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_normalized_key` ON `users` (`email_normalized`);--> statement-breakpoint
CREATE TABLE `video_metadata` (
	`project_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`hashtags` text DEFAULT '[]' NOT NULL,
	`chapters` text DEFAULT '[]' NOT NULL,
	`category_id` text DEFAULT '28' NOT NULL,
	`default_language` text,
	`made_for_kids` integer DEFAULT false NOT NULL,
	`edited_by_user` integer DEFAULT false NOT NULL,
	`generated_by` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `video_metadata_user_id_idx` ON `video_metadata` (`user_id`);--> statement-breakpoint
CREATE TABLE `voiceovers` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`asset_id` text,
	`provider` text NOT NULL,
	`voice_id` text,
	`voice_name` text,
	`language` text,
	`speed` real,
	`style` text,
	`duration_ms` integer,
	`segments` text,
	`characters_billed` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `voiceovers_project_idx` ON `voiceovers` (`project_id`);--> statement-breakpoint
CREATE INDEX `voiceovers_user_id_idx` ON `voiceovers` (`user_id`);
--> statement-breakpoint
-- Reference data from src/lib/plans/index.ts.
INSERT INTO plans (tier,name,price_cents,max_channels,max_videos_per_month,monthly_credits,features,queue_priority) VALUES ('starter','Starter',0,1,4,100,'{"aiVoiceover":false,"brollLibrary":false,"aiVideoGeneration":false,"premiumVideoModels":false,"thumbnailAbTest":false,"autoPublish":false,"scheduling":false,"crossChannelAnalytics":false,"priorityRenderQueue":false}',1) ON CONFLICT(tier) DO NOTHING;
INSERT INTO plans (tier,name,price_cents,max_channels,max_videos_per_month,monthly_credits,features,queue_priority) VALUES ('studio','Studio',3900,3,NULL,2500,'{"aiVoiceover":true,"brollLibrary":true,"aiVideoGeneration":true,"premiumVideoModels":false,"thumbnailAbTest":true,"autoPublish":true,"scheduling":true,"crossChannelAnalytics":false,"priorityRenderQueue":false}',5) ON CONFLICT(tier) DO NOTHING;
INSERT INTO plans (tier,name,price_cents,max_channels,max_videos_per_month,monthly_credits,features,queue_priority) VALUES ('scale','Scale',9900,NULL,NULL,10000,'{"aiVoiceover":true,"brollLibrary":true,"aiVideoGeneration":true,"premiumVideoModels":true,"thumbnailAbTest":true,"autoPublish":true,"scheduling":true,"crossChannelAnalytics":true,"priorityRenderQueue":true}',10) ON CONFLICT(tier) DO NOTHING;
