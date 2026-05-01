-- This is the cutover migration from `drizzle-kit push` to versioned
-- migrations (ADR 003). Because dev / staging / production environments
-- already have the storefront schema applied via the prior `push` flow,
-- every statement is written to be idempotent: CREATE TABLE / INDEX use
-- IF NOT EXISTS, and the unique CONSTRAINT is added in a separate ALTER
-- TABLE wrapped in a DO block so a re-run against an already-migrated
-- DB is a no-op. Future migrations should NOT do this — they should be
-- sequential and assume the prior state.
CREATE TABLE IF NOT EXISTS "orders" (
"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
"order_reference" text NOT NULL,
"patient_first_name" text NOT NULL,
"patient_last_name" text NOT NULL,
"patient_email" text NOT NULL,
"patient_phone" text NOT NULL,
"patient_date_of_birth" text NOT NULL,
"mask_id" text NOT NULL,
"mask_name" text NOT NULL,
"mask_manufacturer" text NOT NULL,
"mask_model_number" text NOT NULL,
"shipping_city" text NOT NULL,
"shipping_state" text NOT NULL,
"shipping_zip" text NOT NULL,
"payload" jsonb NOT NULL,
"email_status" text DEFAULT 'pending' NOT NULL,
"email_error" text,
"email_delivered_at" timestamp with time zone,
"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_order_reference_unique" UNIQUE("order_reference");
EXCEPTION
 WHEN duplicate_object THEN null;
 WHEN duplicate_table THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_events" (
"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
"session_id" text NOT NULL,
"step" text NOT NULL,
"metadata" text,
"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admin_audit_log" (
"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
"admin_email" text NOT NULL,
"admin_clerk_id" text NOT NULL,
"action" text NOT NULL,
"target_order_id" uuid,
"ip" text,
"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reminder_subscriptions" (
"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
"email" text NOT NULL,
"manage_token" text NOT NULL,
"status" text DEFAULT 'active' NOT NULL,
"items" jsonb NOT NULL,
"last_sent_at" timestamp with time zone,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_created_at_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_patient_email_idx" ON "orders" USING btree ("patient_email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_patient_last_name_idx" ON "orders" USING btree ("patient_last_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_email_status_idx" ON "orders" USING btree ("email_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_events_occurred_at_idx" ON "usage_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_events_step_idx" ON "usage_events" USING btree ("step");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_events_session_id_idx" ON "usage_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_log_occurred_at_idx" ON "admin_audit_log" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_log_admin_email_idx" ON "admin_audit_log" USING btree ("admin_email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_log_target_order_idx" ON "admin_audit_log" USING btree ("target_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reminder_subscriptions_email_unique_idx" ON "reminder_subscriptions" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reminder_subscriptions_manage_token_unique_idx" ON "reminder_subscriptions" USING btree ("manage_token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reminder_subscriptions_status_idx" ON "reminder_subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reminder_subscriptions_created_at_idx" ON "reminder_subscriptions" USING btree ("created_at");
