ALTER TABLE "ideas" ALTER COLUMN "channel_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "channel_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "research_results" ALTER COLUMN "channel_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "research_runs" ALTER COLUMN "channel_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "hook" text;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "trend_signal" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "generation_mode" varchar(16);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "generation_model" varchar(64);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "video_format" varchar(16);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "source_video_id" varchar(32);--> statement-breakpoint
ALTER TABLE "research_runs" ADD COLUMN "source_video_id" varchar(32);--> statement-breakpoint
ALTER TABLE "research_runs" ADD COLUMN "source_title" text;--> statement-breakpoint
ALTER TABLE "research_runs" ADD COLUMN "source_channel_title" varchar(200);--> statement-breakpoint
ALTER TABLE "research_runs" ADD COLUMN "source_analysis" jsonb;