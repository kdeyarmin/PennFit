-- 0027_storefront_tables — fold the four PennPaps storefront tables
-- (formerly owned by the deleted `@workspace/db` package) into the
-- resupply migration timeline. Part of the Task #37 "one DB, one API"
-- consolidation.
--
-- Tables created (in the default `public` schema, exactly where they
-- already lived under @workspace/db):
--   * orders
--   * usage_events
--   * admin_audit_log         (already-renamed admin_user_id column)
--   * reminder_subscriptions
--
-- Idempotency rationale:
--   * Every CREATE TABLE / CREATE INDEX uses IF NOT EXISTS.
--   * The unique CONSTRAINT on `orders.order_reference` is added inside
--     a DO block that swallows duplicate_object so a re-run against a
--     DB that already has the constraint is a no-op.
--   * The `admin_user_id` column is created with the post-rename name
--     directly (the old `admin_clerk_id` rename ran in the deleted
--     `lib/db/drizzle/0001_normalize_admin_audit_id_column.sql` and is
--     already applied in dev / prod).
--
-- Production safety:
--   * No data is dropped, altered, or moved between schemas. The tables
--     stay in `public.*` exactly where @workspace/db put them. Any DB
--     that already ran the @workspace/db baseline + rename treats this
--     migration as a no-op. A fresh DB gets all four tables created
--     here in their final shape.
--   * Per ADR 003, this is a hand-authored sequential migration; no
--     `db:push --force`.

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
"admin_user_id" text NOT NULL,
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
