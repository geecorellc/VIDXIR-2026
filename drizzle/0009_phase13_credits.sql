CREATE TYPE "public"."credit_reason" AS ENUM('monthly_grant', 'purchase', 'spend', 'refund', 'adjustment');--> statement-breakpoint
CREATE TABLE "credit_balances" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"granted" integer DEFAULT 0 NOT NULL,
	"purchased" integer DEFAULT 0 NOT NULL,
	"spent" integer DEFAULT 0 NOT NULL,
	"period" varchar(7) NOT NULL,
	"granted_for_tier" "plan_tier" DEFAULT 'starter' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" "credit_reason" NOT NULL,
	"amount" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"operation" varchar(32),
	"model_id" varchar(64),
	"quality" varchar(16),
	"project_id" uuid,
	"idempotency_key" varchar(200),
	"period" varchar(7) NOT NULL,
	"description" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"pack" varchar(32) NOT NULL,
	"credits" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'usd' NOT NULL,
	"provider_session_id" varchar(200) NOT NULL,
	"provider_payment_intent_id" varchar(200),
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"ledger_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "monthly_credits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "research_runs" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_balances" ADD CONSTRAINT "credit_balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_purchases" ADD CONSTRAINT "credit_purchases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_purchases" ADD CONSTRAINT "credit_purchases_ledger_id_credit_ledger_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."credit_ledger"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_balances_period_idx" ON "credit_balances" USING btree ("period");--> statement-breakpoint
CREATE INDEX "credit_ledger_user_created_idx" ON "credit_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_ledger_user_period_idx" ON "credit_ledger" USING btree ("user_id","period");--> statement-breakpoint
CREATE INDEX "credit_ledger_project_idx" ON "credit_ledger" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_purchases_session_key" ON "credit_purchases" USING btree ("provider_session_id");--> statement-breakpoint
CREATE INDEX "credit_purchases_user_created_idx" ON "credit_purchases" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_runs_project_idx" ON "research_runs" USING btree ("project_id");--> statement-breakpoint
--
-- Everything below is hand-authored: drizzle-kit does not emit CHECK constraints
-- or partial indexes, and these three are what make the ledger and the balance
-- self-defending rather than merely conventional. They are absent from
-- 0009_snapshot.json for the same reason, which is harmless — the snapshot diff
-- only ever emits DDL for objects it knows about, so an untracked constraint is
-- never dropped by a later `db:generate`. It does mean a future migration that
-- alters these must alter them explicitly.
--

--
-- 1. Signs follow the reason (§8).
--
-- `spend` is the only negative movement, and it is never zero. Without this the
-- statement "the balance is the sum of the ledger" would depend on every caller
-- remembering to negate, and a positive `spend` row would silently mint credits.
--
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_sign_matches_reason" CHECK (
  ("reason" = 'spend' AND "amount" < 0)
  OR ("reason" <> 'spend' AND "amount" > 0)
);--> statement-breakpoint

--
-- 2. Idempotency (§13).
--
-- Partial, because an operator adjustment has no natural key and several such rows
-- must be able to carry NULL without colliding. A retried charge presenting the
-- same key loses its insert, which is how `chargeCredits` detects that it has
-- already run without a read that could race the write.
--
CREATE UNIQUE INDEX "credit_ledger_idempotency_key" ON "credit_ledger" ("idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint

--
-- 3. The balance can never go negative, and its counters never go backwards.
--
-- The charge path already refuses an overspend through a conditional UPDATE; this
-- is the guard for everything that is not that path. A bug in a refund, a grant or
-- a future admin tool that drove the balance below zero would be giving away
-- provider spend, and the constraint turns that into a failed transaction instead
-- of an invisible loss.
--
ALTER TABLE "credit_balances" ADD CONSTRAINT "credit_balances_non_negative" CHECK (
  "granted" >= 0 AND "purchased" >= 0 AND "spent" >= 0
  AND "granted" + "purchased" - "spent" >= 0
);
