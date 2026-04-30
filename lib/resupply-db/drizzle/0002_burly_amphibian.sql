CREATE TABLE "resupply"."frequency_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"match_item_sku_prefix" text,
	"match_insurance_payer" text,
	"min_tenure_days" integer,
	"max_tenure_days" integer,
	"cadence_days" integer NOT NULL,
	"default_channel" text,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resupply"."patients" ADD COLUMN "insurance_payer" text;--> statement-breakpoint
ALTER TABLE "resupply"."patients" ADD COLUMN "cadence_override_days" integer;--> statement-breakpoint
ALTER TABLE "resupply"."patients" ADD COLUMN "channel_preference" text;--> statement-breakpoint
CREATE INDEX "frequency_rules_active_priority_idx" ON "resupply"."frequency_rules" USING btree ("active","priority","created_at");