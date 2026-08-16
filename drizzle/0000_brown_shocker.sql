CREATE TYPE "public"."asset_kind" AS ENUM('stock_video', 'stock_image', 'generated_image', 'generated_video', 'voiceover', 'music', 'sfx', 'caption_file', 'render_output', 'thumbnail', 'upload');--> statement-breakpoint
CREATE TYPE "public"."automation_level" AS ENUM('manual', 'assisted', 'autopilot');--> statement-breakpoint
CREATE TYPE "public"."email_token_purpose" AS ENUM('verify_email', 'reset_password');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled', 'blocked_not_configured');--> statement-breakpoint
CREATE TYPE "public"."pipeline_stage" AS ENUM('RESEARCH', 'SCRIPT', 'SCENE_PLAN', 'VOICEOVER', 'VISUALS', 'MUSIC', 'CAPTIONS', 'TIMELINE', 'RENDER', 'QUALITY_CHECK', 'THUMBNAIL', 'METADATA', 'PUBLISH');--> statement-breakpoint
CREATE TYPE "public"."plan_tier" AS ENUM('starter', 'studio', 'scale');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('IDEA', 'SCRIPT_GENERATING', 'SCRIPT_READY', 'ASSETS_GENERATING', 'ASSETS_READY', 'RENDERING', 'VIDEO_READY', 'THUMBNAIL_GENERATING', 'READY_TO_PUBLISH', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."publish_job_status" AS ENUM('queued', 'scheduled', 'publishing', 'published', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."publish_visibility" AS ENUM('public', 'unlisted', 'private');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('active', 'trialing', 'past_due', 'canceled', 'incomplete', 'unpaid');--> statement-breakpoint
CREATE TABLE "analytics_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"published_video_id" uuid,
	"date" timestamp with time zone NOT NULL,
	"views" integer,
	"likes" integer,
	"comments" integer,
	"shares" integer,
	"subscribers_gained" integer,
	"subscribers_lost" integer,
	"impressions" integer,
	"ctr" real,
	"watch_time_minutes" real,
	"average_view_duration_seconds" real,
	"average_view_percentage" real,
	"estimated_revenue_cents" integer,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"project_id" uuid,
	"job_id" uuid,
	"provider" varchar(48) NOT NULL,
	"operation" varchar(64) NOT NULL,
	"model" varchar(64),
	"quantity" integer,
	"unit" varchar(24),
	"estimated_cost_cents" integer,
	"http_status" integer,
	"ok" boolean DEFAULT true NOT NULL,
	"error_code" varchar(64),
	"duration_ms" integer,
	"trace_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"channel_id" uuid,
	"kind" "asset_kind" NOT NULL,
	"storage_key" text,
	"mime_type" varchar(128),
	"bytes" integer,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"checksum_sha256" varchar(64),
	"provider" varchar(48),
	"provider_asset_id" varchar(128),
	"source_url" text,
	"license" varchar(120),
	"attribution" text,
	"author_name" varchar(200),
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_settings" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"level" "automation_level" DEFAULT 'manual' NOT NULL,
	"publish_days" jsonb DEFAULT '[1,3,5]'::jsonb NOT NULL,
	"publish_times" jsonb DEFAULT '["18:00"]'::jsonb NOT NULL,
	"timezone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"videos_per_week" integer DEFAULT 3 NOT NULL,
	"auto_publish" boolean DEFAULT false NOT NULL,
	"require_approval" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_kits" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"brand_name" varchar(120),
	"logo_asset_id" uuid,
	"primary_color" varchar(9),
	"secondary_color" varchar(9),
	"font_preference" varchar(80),
	"intro_asset_id" uuid,
	"outro_asset_id" uuid,
	"default_cta" text,
	"caption_style" jsonb,
	"thumbnail_style" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "captions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"language" varchar(16) DEFAULT 'en' NOT NULL,
	"provider" varchar(48),
	"cues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"srt_asset_id" uuid,
	"vtt_asset_id" uuid,
	"burned_in" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_settings" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"niche" varchar(160),
	"target_audience" text,
	"content_language" varchar(16) DEFAULT 'en-US' NOT NULL,
	"preferred_length_seconds" integer DEFAULT 480 NOT NULL,
	"uploads_per_week" integer DEFAULT 1 NOT NULL,
	"content_style" varchar(64),
	"video_style" varchar(64),
	"thumbnail_style" varchar(64),
	"voice_provider_voice_id" varchar(128),
	"voice_style" varchar(64),
	"voice_speed" real DEFAULT 1 NOT NULL,
	"competitor_channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"score_weights" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"youtube_channel_id" varchar(64) NOT NULL,
	"title" varchar(200) NOT NULL,
	"handle" varchar(120),
	"description" text,
	"thumbnail_url" text,
	"subscriber_count" integer,
	"video_count" integer,
	"view_count" numeric(20, 0),
	"stats_refreshed_at" timestamp with time zone,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"token_expires_at" timestamp with time zone,
	"granted_scopes" text,
	"reauth_required_at" timestamp with time zone,
	"last_token_error_message" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" "email_token_purpose" NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ideas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"run_id" uuid,
	"title" text NOT NULL,
	"angle" text,
	"rationale" text,
	"topic" varchar(200),
	"target_keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_result_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trend_score" real,
	"opportunity_score" real,
	"competition_score" real,
	"audience_fit_score" real,
	"velocity_score" real,
	"freshness_score" real,
	"tally_score" real,
	"score_breakdown" jsonb,
	"state" varchar(16) DEFAULT 'new' NOT NULL,
	"generated_by" varchar(48),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"channel_id" uuid,
	"queue" varchar(48) NOT NULL,
	"name" varchar(64) NOT NULL,
	"stage" "pipeline_stage",
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"status_message" text,
	"priority" integer DEFAULT 1 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"queue_job_id" varchar(128),
	"trace_id" varchar(64),
	"payload" jsonb,
	"result" jsonb,
	"error" text,
	"error_code" varchar(64),
	"not_configured_provider" varchar(48),
	"scheduled_for" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "music_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"asset_id" uuid,
	"role" varchar(16) DEFAULT 'background' NOT NULL,
	"mood" varchar(64),
	"bpm" integer,
	"volume" real DEFAULT 0.14 NOT NULL,
	"duck_under_narration" boolean DEFAULT true NOT NULL,
	"start_ms" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"tier" "plan_tier" PRIMARY KEY NOT NULL,
	"name" varchar(64) NOT NULL,
	"price_cents" integer NOT NULL,
	"max_channels" integer,
	"max_videos_per_month" integer,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"queue_priority" integer DEFAULT 1 NOT NULL,
	"stripe_price_id" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"from_status" "project_status",
	"to_status" "project_status" NOT NULL,
	"stage" "pipeline_stage",
	"message" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"idea_id" uuid,
	"title" text NOT NULL,
	"status" "project_status" DEFAULT 'IDEA' NOT NULL,
	"current_stage" "pipeline_stage",
	"progress" integer DEFAULT 0 NOT NULL,
	"failed_stage" "pipeline_stage",
	"error_message" text,
	"error_code" varchar(64),
	"failed_at" timestamp with time zone,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"origin" varchar(32) DEFAULT 'manual' NOT NULL,
	"trace_id" varchar(64),
	"target_duration_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publish_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"status" "publish_job_status" DEFAULT 'queued' NOT NULL,
	"visibility" "publish_visibility" DEFAULT 'public' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"upload_progress" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error" text,
	"error_code" varchar(64),
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "published_videos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"publish_job_id" uuid,
	"youtube_video_id" varchar(32) NOT NULL,
	"url" text NOT NULL,
	"upload_status" varchar(32),
	"privacy_status" varchar(16),
	"published_at" timestamp with time zone,
	"scheduled_publish_at" timestamp with time zone,
	"thumbnail_variant_id" uuid,
	"title_used" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quality_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"verdict" varchar(8) NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"asset_licenses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "renders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(48) NOT NULL,
	"provider_render_id" varchar(128),
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"timeline" jsonb,
	"width" integer DEFAULT 1920 NOT NULL,
	"height" integer DEFAULT 1080 NOT NULL,
	"fps" integer DEFAULT 30 NOT NULL,
	"duration_ms" integer,
	"output_asset_id" uuid,
	"poster_asset_id" uuid,
	"error" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"source" varchar(48) NOT NULL,
	"youtube_video_id" varchar(32),
	"youtube_channel_id" varchar(64),
	"channel_title" varchar(200),
	"title" text NOT NULL,
	"url" text,
	"published_at" timestamp with time zone,
	"view_count" numeric(20, 0),
	"like_count" integer,
	"comment_count" integer,
	"views_per_hour" real,
	"engagement_rate" real,
	"topic" varchar(200),
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"trigger" varchar(32) DEFAULT 'manual' NOT NULL,
	"niche" varchar(160),
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"demand_series" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scenes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"script_version_id" uuid,
	"index" integer NOT NULL,
	"label" varchar(80),
	"narration" text NOT NULL,
	"visual_prompt" text,
	"search_terms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"on_screen_text" text,
	"start_ms" integer,
	"duration_ms" integer,
	"transition" varchar(32),
	"visual_asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "script_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"script_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"title_ideas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hook" text NOT NULL,
	"introduction" text,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conclusion" text,
	"cta" text,
	"story_structure" text,
	"references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"estimated_duration_seconds" integer,
	"word_count" integer,
	"source" varchar(16) DEFAULT 'ai' NOT NULL,
	"provider" varchar(48),
	"model" varchar(64),
	"prompt_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"active_version_id" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"user_agent" text,
	"ip_address" varchar(45),
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tier" "plan_tier" DEFAULT 'starter' NOT NULL,
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"provider" varchar(32) DEFAULT 'none' NOT NULL,
	"provider_customer_id" varchar(128),
	"provider_subscription_id" varchar(128),
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thumbnail_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thumbnail_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"headline" varchar(80) NOT NULL,
	"subline" varchar(120),
	"concept" text,
	"emotion" varchar(48),
	"background_asset_id" uuid,
	"image_asset_id" uuid,
	"impressions" integer,
	"clicks" integer,
	"ctr" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thumbnails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"selected_variant_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"user_id" uuid NOT NULL,
	"period" varchar(7) NOT NULL,
	"videos_started" integer DEFAULT 0 NOT NULL,
	"videos_published" integer DEFAULT 0 NOT NULL,
	"renders_completed" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counters_user_id_period_pk" PRIMARY KEY("user_id","period")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"email_normalized" varchar(320) NOT NULL,
	"password_hash" text NOT NULL,
	"name" varchar(120) NOT NULL,
	"email_verified_at" timestamp with time zone,
	"onboarded_at" timestamp with time zone,
	"session_epoch" integer DEFAULT 0 NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_metadata" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"title" varchar(100) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hashtags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"chapters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"category_id" varchar(8) DEFAULT '28' NOT NULL,
	"default_language" varchar(16),
	"made_for_kids" boolean DEFAULT false NOT NULL,
	"edited_by_user" boolean DEFAULT false NOT NULL,
	"generated_by" varchar(48),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voiceovers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"asset_id" uuid,
	"provider" varchar(48) NOT NULL,
	"voice_id" varchar(128),
	"voice_name" varchar(120),
	"language" varchar(16),
	"speed" real,
	"style" varchar(64),
	"duration_ms" integer,
	"segments" jsonb,
	"characters_billed" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_published_video_id_published_videos_id_fk" FOREIGN KEY ("published_video_id") REFERENCES "public"."published_videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_settings" ADD CONSTRAINT "automation_settings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_settings" ADD CONSTRAINT "automation_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD CONSTRAINT "brand_kits_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD CONSTRAINT "brand_kits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captions" ADD CONSTRAINT "captions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captions" ADD CONSTRAINT "captions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captions" ADD CONSTRAINT "captions_srt_asset_id_assets_id_fk" FOREIGN KEY ("srt_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captions" ADD CONSTRAINT "captions_vtt_asset_id_assets_id_fk" FOREIGN KEY ("vtt_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_settings" ADD CONSTRAINT "channel_settings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_settings" ADD CONSTRAINT "channel_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_tokens" ADD CONSTRAINT "email_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "music_tracks" ADD CONSTRAINT "music_tracks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "music_tracks" ADD CONSTRAINT "music_tracks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "music_tracks" ADD CONSTRAINT "music_tracks_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_videos" ADD CONSTRAINT "published_videos_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_videos" ADD CONSTRAINT "published_videos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_videos" ADD CONSTRAINT "published_videos_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_videos" ADD CONSTRAINT "published_videos_publish_job_id_publish_jobs_id_fk" FOREIGN KEY ("publish_job_id") REFERENCES "public"."publish_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_videos" ADD CONSTRAINT "published_videos_thumbnail_variant_id_thumbnail_variants_id_fk" FOREIGN KEY ("thumbnail_variant_id") REFERENCES "public"."thumbnail_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD CONSTRAINT "quality_checks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD CONSTRAINT "quality_checks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_output_asset_id_assets_id_fk" FOREIGN KEY ("output_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_poster_asset_id_assets_id_fk" FOREIGN KEY ("poster_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_results" ADD CONSTRAINT "research_results_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_results" ADD CONSTRAINT "research_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_results" ADD CONSTRAINT "research_results_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_script_version_id_script_versions_id_fk" FOREIGN KEY ("script_version_id") REFERENCES "public"."script_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_versions" ADD CONSTRAINT "script_versions_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_versions" ADD CONSTRAINT "script_versions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thumbnail_variants" ADD CONSTRAINT "thumbnail_variants_thumbnail_id_thumbnails_id_fk" FOREIGN KEY ("thumbnail_id") REFERENCES "public"."thumbnails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thumbnail_variants" ADD CONSTRAINT "thumbnail_variants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thumbnail_variants" ADD CONSTRAINT "thumbnail_variants_background_asset_id_assets_id_fk" FOREIGN KEY ("background_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thumbnail_variants" ADD CONSTRAINT "thumbnail_variants_image_asset_id_assets_id_fk" FOREIGN KEY ("image_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thumbnails" ADD CONSTRAINT "thumbnails_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thumbnails" ADD CONSTRAINT "thumbnails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_metadata" ADD CONSTRAINT "video_metadata_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_metadata" ADD CONSTRAINT "video_metadata_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voiceovers" ADD CONSTRAINT "voiceovers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voiceovers" ADD CONSTRAINT "voiceovers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voiceovers" ADD CONSTRAINT "voiceovers_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_snapshots_scope_date_key" ON "analytics_snapshots" USING btree ("channel_id","published_video_id","date");--> statement-breakpoint
CREATE INDEX "analytics_snapshots_user_id_idx" ON "analytics_snapshots" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "api_usage_provider_created_idx" ON "api_usage" USING btree ("provider","created_at");--> statement-breakpoint
CREATE INDEX "api_usage_user_created_idx" ON "api_usage" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "assets_project_kind_idx" ON "assets" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "assets_user_id_idx" ON "assets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "automation_settings_user_id_idx" ON "automation_settings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "automation_settings_next_run_idx" ON "automation_settings" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "brand_kits_user_id_idx" ON "brand_kits" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "captions_project_idx" ON "captions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "captions_user_id_idx" ON "captions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "channel_settings_user_id_idx" ON "channel_settings" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_user_youtube_key" ON "channels" USING btree ("user_id","youtube_channel_id");--> statement-breakpoint
CREATE INDEX "channels_user_id_idx" ON "channels" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_tokens_token_hash_key" ON "email_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "email_tokens_user_purpose_idx" ON "email_tokens" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "ideas_channel_state_idx" ON "ideas" USING btree ("channel_id","state");--> statement-breakpoint
CREATE INDEX "ideas_user_id_idx" ON "ideas" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ideas_score_idx" ON "ideas" USING btree ("channel_id","tally_score");--> statement-breakpoint
CREATE INDEX "jobs_project_stage_idx" ON "jobs" USING btree ("project_id","stage");--> statement-breakpoint
CREATE INDEX "jobs_user_status_idx" ON "jobs" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "jobs_queue_job_idx" ON "jobs" USING btree ("queue_job_id");--> statement-breakpoint
CREATE INDEX "jobs_trace_idx" ON "jobs" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "music_tracks_project_idx" ON "music_tracks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "music_tracks_user_id_idx" ON "music_tracks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "project_events_project_idx" ON "project_events" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "projects_user_status_idx" ON "projects" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "projects_channel_created_idx" ON "projects" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "publish_jobs_status_sched_idx" ON "publish_jobs" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "publish_jobs_project_idx" ON "publish_jobs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "publish_jobs_user_id_idx" ON "publish_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "published_videos_youtube_id_key" ON "published_videos" USING btree ("youtube_video_id");--> statement-breakpoint
CREATE INDEX "published_videos_channel_idx" ON "published_videos" USING btree ("channel_id","published_at");--> statement-breakpoint
CREATE INDEX "published_videos_user_id_idx" ON "published_videos" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "quality_checks_project_idx" ON "quality_checks" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "quality_checks_user_id_idx" ON "quality_checks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "renders_project_idx" ON "renders" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "renders_user_id_idx" ON "renders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "renders_provider_render_idx" ON "renders" USING btree ("provider_render_id");--> statement-breakpoint
CREATE INDEX "research_results_run_idx" ON "research_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "research_results_channel_idx" ON "research_results" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "research_results_video_idx" ON "research_results" USING btree ("youtube_video_id");--> statement-breakpoint
CREATE INDEX "research_runs_channel_created_idx" ON "research_runs" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "research_runs_user_id_idx" ON "research_runs" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scenes_project_index_key" ON "scenes" USING btree ("project_id","index");--> statement-breakpoint
CREATE INDEX "scenes_user_id_idx" ON "scenes" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "script_versions_script_version_key" ON "script_versions" USING btree ("script_id","version");--> statement-breakpoint
CREATE INDEX "script_versions_user_id_idx" ON "script_versions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scripts_project_key" ON "scripts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "scripts_user_id_idx" ON "scripts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_user_id_key" ON "subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "subscriptions_provider_sub_idx" ON "subscriptions" USING btree ("provider_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "thumbnail_variants_thumb_index_key" ON "thumbnail_variants" USING btree ("thumbnail_id","index");--> statement-breakpoint
CREATE INDEX "thumbnail_variants_user_id_idx" ON "thumbnail_variants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "thumbnails_project_idx" ON "thumbnails" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "thumbnails_user_id_idx" ON "thumbnails" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_normalized_key" ON "users" USING btree ("email_normalized");--> statement-breakpoint
CREATE INDEX "video_metadata_user_id_idx" ON "video_metadata" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "voiceovers_project_idx" ON "voiceovers" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "voiceovers_user_id_idx" ON "voiceovers" USING btree ("user_id");