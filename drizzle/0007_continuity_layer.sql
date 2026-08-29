CREATE TABLE "story_bibles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"level" varchar(16) DEFAULT 'off' NOT NULL,
	"document" jsonb NOT NULL,
	"generated_by" varchar(48),
	"edited_by_user" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "story_bibles" ADD CONSTRAINT "story_bibles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_bibles" ADD CONSTRAINT "story_bibles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "story_bibles_project_key" ON "story_bibles" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "story_bibles_user_id_idx" ON "story_bibles" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "scenes" ADD COLUMN "continuity_state" jsonb;--> statement-breakpoint
ALTER TABLE "scenes" ADD COLUMN "continuity_prompt" text;--> statement-breakpoint
ALTER TABLE "scenes" ADD COLUMN "continuity_regenerations" integer DEFAULT 0 NOT NULL;
