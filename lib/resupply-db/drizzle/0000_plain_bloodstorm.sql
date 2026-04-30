-- This is the cutover migration from `drizzle-kit push` to versioned
-- migrations (ADR 003). Because dev / staging environments may already
-- have the schema applied via the prior `push` flow, every statement is
-- written to be idempotent: CREATE EXTENSION / SCHEMA / TABLE / INDEX
-- use IF NOT EXISTS, and ALTER TABLE ... ADD CONSTRAINT is wrapped in
-- a DO block that swallows the duplicate_object error. Future
-- migrations should NOT do this — they should be sequential and
-- assume the prior state.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "resupply";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resupply"."patients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pacware_id" text NOT NULL,
	"legal_first_name" "bytea" NOT NULL,
	"legal_last_name" "bytea" NOT NULL,
	"date_of_birth" "bytea" NOT NULL,
	"phone_e164" "bytea",
	"email" "bytea",
	"address" "bytea",
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resupply"."prescriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"item_sku" text NOT NULL,
	"cadence_days" integer NOT NULL,
	"valid_from" date NOT NULL,
	"valid_until" date,
	"details" "bytea",
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resupply"."episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"prescription_id" uuid NOT NULL,
	"status" text DEFAULT 'outreach_pending' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resupply"."conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"episode_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"external_ref" text,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resupply"."messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"sender_role" text NOT NULL,
	"body" "bytea" NOT NULL,
	"delivery_status" text,
	"delivery_error" text,
	"vendor_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resupply"."fulfillments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"episode_id" uuid NOT NULL,
	"item_sku" text NOT NULL,
	"quantity" text DEFAULT '1' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"pacware_order_ref" text,
	"shipment_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"submitted_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resupply"."audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_email" text,
	"operator_clerk_id" text,
	"action" text NOT NULL,
	"target_table" text,
	"target_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"user_agent" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resupply"."prescriptions" ADD CONSTRAINT "prescriptions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "resupply"."patients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resupply"."episodes" ADD CONSTRAINT "episodes_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "resupply"."patients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resupply"."episodes" ADD CONSTRAINT "episodes_prescription_id_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "resupply"."prescriptions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resupply"."conversations" ADD CONSTRAINT "conversations_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "resupply"."patients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resupply"."conversations" ADD CONSTRAINT "conversations_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "resupply"."episodes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resupply"."messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "resupply"."conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resupply"."fulfillments" ADD CONSTRAINT "fulfillments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "resupply"."patients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resupply"."fulfillments" ADD CONSTRAINT "fulfillments_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "resupply"."episodes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "patients_pacware_id_unique" ON "resupply"."patients" USING btree ("pacware_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patients_status_idx" ON "resupply"."patients" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prescriptions_patient_idx" ON "resupply"."prescriptions" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prescriptions_patient_sku_idx" ON "resupply"."prescriptions" USING btree ("patient_id","item_sku");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prescriptions_status_idx" ON "resupply"."prescriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "episodes_patient_idx" ON "resupply"."episodes" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "episodes_prescription_idx" ON "resupply"."episodes" USING btree ("prescription_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "episodes_status_idx" ON "resupply"."episodes" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "episodes_due_at_idx" ON "resupply"."episodes" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_patient_idx" ON "resupply"."conversations" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_episode_idx" ON "resupply"."conversations" USING btree ("episode_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_channel_status_idx" ON "resupply"."conversations" USING btree ("channel","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_last_message_at_idx" ON "resupply"."conversations" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_conversation_idx" ON "resupply"."messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_conversation_created_idx" ON "resupply"."messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_delivery_status_idx" ON "resupply"."messages" USING btree ("delivery_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fulfillments_patient_idx" ON "resupply"."fulfillments" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fulfillments_episode_idx" ON "resupply"."fulfillments" USING btree ("episode_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fulfillments_status_idx" ON "resupply"."fulfillments" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fulfillments_pacware_order_ref_idx" ON "resupply"."fulfillments" USING btree ("pacware_order_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_occurred_at_idx" ON "resupply"."audit_log" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_operator_idx" ON "resupply"."audit_log" USING btree ("operator_email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_action_idx" ON "resupply"."audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_target_idx" ON "resupply"."audit_log" USING btree ("target_table","target_id");
