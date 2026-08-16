CREATE TABLE "onboarding_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"declared_channel_url" text,
	"niche" varchar(160),
	"target_audience" text,
	"content_language" varchar(16) DEFAULT 'en-US' NOT NULL,
	"preferred_length_seconds" integer DEFAULT 480 NOT NULL,
	"uploads_per_week" integer DEFAULT 1 NOT NULL,
	"content_style" varchar(64),
	"voice_preference" varchar(64),
	"automation_level" "automation_level" DEFAULT 'manual' NOT NULL,
	"publish_days" jsonb DEFAULT '[1,3,5]'::jsonb NOT NULL,
	"publish_times" jsonb DEFAULT '["18:00"]'::jsonb NOT NULL,
	"timezone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"last_step" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "onboarding_profiles" ADD CONSTRAINT "onboarding_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;