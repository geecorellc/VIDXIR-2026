CREATE TYPE "public"."analytics_metric_source" AS ENUM('provider', 'derived_views_impressions', 'provider_unsupported', 'provider_null');--> statement-breakpoint
CREATE TYPE "public"."experiment_outcome" AS ENUM('winner', 'no_winner', 'tie', 'insufficient_data', 'stopped');--> statement-breakpoint
CREATE TYPE "public"."experiment_status" AS ENUM('draft', 'running', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."revenue_state" AS ENUM('reported', 'reported_zero', 'scope_missing', 'not_monetized', 'unavailable', 'not_requested');--> statement-breakpoint
CREATE TABLE "thumbnail_experiment_arms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experiment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"thumbnail_variant_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"is_control" boolean DEFAULT false NOT NULL,
	"impressions" integer,
	"clicks" integer,
	"views" integer,
	"ctr" numeric(9, 6),
	"metrics_source" "analytics_metric_source",
	"observation_days" integer DEFAULT 0 NOT NULL,
	"last_observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thumbnail_experiment_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experiment_id" uuid NOT NULL,
	"arm_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"impressions" integer,
	"clicks" integer,
	"views" integer,
	"source" "analytics_metric_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thumbnail_experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"published_video_id" uuid NOT NULL,
	"status" "experiment_status" DEFAULT 'draft' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"winning_arm_id" uuid,
	"outcome" "experiment_outcome",
	"decision_policy" jsonb,
	"decision" jsonb,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "analytics_snapshots_scope_date_key";--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ALTER COLUMN "ctr" SET DATA TYPE numeric(9, 6);--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD COLUMN "ctr_source" "analytics_metric_source";--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD COLUMN "estimated_revenue" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD COLUMN "revenue_currency" char(3);--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD COLUMN "revenue_state" "revenue_state";--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD COLUMN "revenue_final" boolean;--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "thumbnail_experiment_arms" ADD CONSTRAINT "thumbnail_experiment_arms_experiment_id_thumbnail_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."thumbnail_experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thumbnail_experiment_arms" ADD CONSTRAINT "thumbnail_experiment_arms_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thumbnail_experiment_arms" ADD CONSTRAINT "thumbnail_experiment_arms_thumbnail_variant_id_thumbnail_variants_id_fk" FOREIGN KEY ("thumbnail_variant_id") REFERENCES "public"."thumbnail_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thumbnail_experiment_observations" ADD CONSTRAINT "thumbnail_experiment_observations_experiment_id_thumbnail_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."thumbnail_experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thumbnail_experiment_observations" ADD CONSTRAINT "thumbnail_experiment_observations_arm_id_thumbnail_experiment_arms_id_fk" FOREIGN KEY ("arm_id") REFERENCES "public"."thumbnail_experiment_arms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thumbnail_experiment_observations" ADD CONSTRAINT "thumbnail_experiment_observations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thumbnail_experiments" ADD CONSTRAINT "thumbnail_experiments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thumbnail_experiments" ADD CONSTRAINT "thumbnail_experiments_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thumbnail_experiments" ADD CONSTRAINT "thumbnail_experiments_published_video_id_published_videos_id_fk" FOREIGN KEY ("published_video_id") REFERENCES "public"."published_videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thumbnail_experiments" ADD CONSTRAINT "thumbnail_experiments_winning_arm_id_thumbnail_experiment_arms_id_fk" FOREIGN KEY ("winning_arm_id") REFERENCES "public"."thumbnail_experiment_arms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "thumbnail_experiment_arms_position_key" ON "thumbnail_experiment_arms" USING btree ("experiment_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "thumbnail_experiment_arms_variant_key" ON "thumbnail_experiment_arms" USING btree ("experiment_id","thumbnail_variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "thumbnail_experiment_arms_control_key" ON "thumbnail_experiment_arms" USING btree ("experiment_id") WHERE "thumbnail_experiment_arms"."is_control";--> statement-breakpoint
CREATE INDEX "thumbnail_experiment_arms_user_idx" ON "thumbnail_experiment_arms" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "thumbnail_experiment_observations_arm_date_key" ON "thumbnail_experiment_observations" USING btree ("arm_id","date");--> statement-breakpoint
CREATE INDEX "thumbnail_experiment_observations_experiment_idx" ON "thumbnail_experiment_observations" USING btree ("experiment_id","date");--> statement-breakpoint
CREATE INDEX "thumbnail_experiment_observations_user_idx" ON "thumbnail_experiment_observations" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "thumbnail_experiments_live_video_key" ON "thumbnail_experiments" USING btree ("published_video_id") WHERE "thumbnail_experiments"."status" in ('draft', 'running');--> statement-breakpoint
CREATE INDEX "thumbnail_experiments_user_idx" ON "thumbnail_experiments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "thumbnail_experiments_channel_status_idx" ON "thumbnail_experiments" USING btree ("channel_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_snapshots_video_date_key" ON "analytics_snapshots" USING btree ("channel_id","published_video_id","date") WHERE "analytics_snapshots"."published_video_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_snapshots_channel_date_key" ON "analytics_snapshots" USING btree ("channel_id","date") WHERE "analytics_snapshots"."published_video_id" is null;--> statement-breakpoint
CREATE INDEX "analytics_snapshots_channel_date_idx" ON "analytics_snapshots" USING btree ("channel_id","date");