-- 0362_platform_billing_packages — CareMetric Breathe package catalog,
-- tenant billing assignments, and tenant usage tracking.
--
-- ADDITIVE / idempotent. These tables are global platform-operator data:
-- plan and add-on catalog rows apply across tenants, while tenant_* rows
-- reference organizations explicitly. No PHI is stored here; usage events
-- are aggregate counters only.

CREATE TABLE IF NOT EXISTS "resupply"."billing_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" varchar(40) NOT NULL,
  "name" varchar(120) NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "monthly_price_cents" integer,
  "onboarding_fee_cents" integer,
  "is_public" boolean NOT NULL DEFAULT true,
  "is_custom" boolean NOT NULL DEFAULT false,
  "sort_order" integer NOT NULL DEFAULT 0,
  "allowances" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "features" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "billing_plans_code_chk" CHECK ("code" ~ '^[a-z0-9_]+$'),
  CONSTRAINT "billing_plans_price_chk" CHECK ("monthly_price_cents" IS NULL OR "monthly_price_cents" >= 0),
  CONSTRAINT "billing_plans_onboarding_chk" CHECK ("onboarding_fee_cents" IS NULL OR "onboarding_fee_cents" >= 0)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "billing_plans_code_uq"
  ON "resupply"."billing_plans" ("code");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "resupply"."billing_addons" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" varchar(60) NOT NULL,
  "name" varchar(160) NOT NULL,
  "category" varchar(80) NOT NULL DEFAULT 'general',
  "description" text NOT NULL DEFAULT '',
  "recurring_price_cents" integer,
  "one_time_min_cents" integer,
  "one_time_max_cents" integer,
  "unit_label" varchar(80),
  "usage_metric" varchar(80),
  "pass_through_note" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "billing_addons_code_chk" CHECK ("code" ~ '^[a-z0-9_]+$')
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "billing_addons_code_uq"
  ON "resupply"."billing_addons" ("code");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "resupply"."tenant_billing_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id") ON DELETE CASCADE,
  "plan_id" uuid NOT NULL REFERENCES "resupply"."billing_plans"("id"),
  "status" text NOT NULL DEFAULT 'active',
  "effective_at" timestamptz NOT NULL DEFAULT now(),
  "custom_monthly_price_cents" integer,
  "custom_onboarding_fee_cents" integer,
  "custom_allowances" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "notes" text NOT NULL DEFAULT '',
  "updated_by_email" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_billing_subscriptions_status_chk" CHECK ("status" IN ('active','trialing','past_due','canceled'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_billing_one_current_plan_uq"
  ON "resupply"."tenant_billing_subscriptions" ("org_id")
  WHERE "status" IN ('active','trialing','past_due');
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tenant_billing_subscriptions_org_idx"
  ON "resupply"."tenant_billing_subscriptions" ("org_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "resupply"."tenant_billing_addons" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id") ON DELETE CASCADE,
  "addon_id" uuid NOT NULL REFERENCES "resupply"."billing_addons"("id"),
  "quantity" integer NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'active',
  "custom_recurring_price_cents" integer,
  "notes" text NOT NULL DEFAULT '',
  "updated_by_email" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_billing_addons_qty_chk" CHECK ("quantity" >= 0),
  CONSTRAINT "tenant_billing_addons_status_chk" CHECK ("status" IN ('active','inactive','canceled'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_billing_one_active_addon_uq"
  ON "resupply"."tenant_billing_addons" ("org_id", "addon_id")
  WHERE "status" = 'active';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "resupply"."tenant_usage_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id") ON DELETE CASCADE,
  "metric_key" varchar(80) NOT NULL,
  "quantity" integer NOT NULL DEFAULT 1,
  "source" varchar(120) NOT NULL DEFAULT 'system',
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_usage_events_metric_chk" CHECK ("metric_key" ~ '^[a-z0-9_.]+$'),
  CONSTRAINT "tenant_usage_events_quantity_chk" CHECK ("quantity" >= 0)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tenant_usage_events_org_metric_time_idx"
  ON "resupply"."tenant_usage_events" ("org_id", "metric_key", "occurred_at" DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "resupply"."tenant_usage_monthly_rollups" (
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id") ON DELETE CASCADE,
  "month" date NOT NULL,
  "metric_key" varchar(80) NOT NULL,
  "quantity" integer NOT NULL DEFAULT 0,
  "computed_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("org_id", "month", "metric_key")
);
--> statement-breakpoint

INSERT INTO "resupply"."billing_plans" ("code", "name", "description", "monthly_price_cents", "onboarding_fee_cents", "is_public", "is_custom", "sort_order", "allowances", "features") VALUES
('launch','Launch','Branded CPAP storefront and basic resupply automation for a small DME.',79900,250000,true,false,10,'{"seats":5,"activePatients":500,"locations":1,"ordersPerMonth":150,"activeSubscriptions":250,"outboundMessagesPerMonth":1000,"aiTextInteractionsPerMonth":1000,"billingTransactionsPerMonth":0}'::jsonb,'["Branded CPAP storefront + mask fitter","Online shop, cart, checkout, and order tracking","Customer accounts and basic messaging","Resupply reminders and subscription tracking","Orders, returns, inventory, and customer leads"]'::jsonb),
('growth','Growth','Full resupply operations, outreach, documents, therapy monitoring, and billing worklists.',189900,500000,true,false,20,'{"seats":15,"activePatients":3000,"locations":3,"ordersPerMonth":750,"activeSubscriptions":1500,"outboundMessagesPerMonth":5000,"aiTextInteractionsPerMonth":5000,"billingTransactionsPerMonth":1000}'::jsonb,'["Everything in Launch","Bulk campaigns, playbooks, and templates","Patient packets, e-signature tracking, inbound fax triage","Eligibility, prior auth, CMN/DIF, bill-hold, and A/R worklists","Therapy monitoring and resupply opportunities"]'::jsonb),
('scale','Scale','Multi-location automation, analytics, AI controls, and higher-volume operations.',399900,1000000,true,false,30,'{"seats":40,"activePatients":10000,"locations":10,"ordersPerMonth":2500,"activeSubscriptions":5000,"outboundMessagesPerMonth":20000,"aiTextInteractionsPerMonth":20000,"billingTransactionsPerMonth":5000}'::jsonb,'["Everything in Growth","Multi-location workflows","Advanced financial, funnel, LTV/CAC, and inventory analytics","Team throughput, live staffing, goals, and KPI alerts","Automation rules, Control Center, and bot playground"]'::jsonb),
('enterprise','Enterprise','Custom package for high-volume DME operations, migration, integrations, and contracted support.',750000,NULL,false,true,40,'{}'::jsonb,'["Everything in Scale","Custom integration and migration plan","Contracted transaction volume","Advanced security and account controls","Dedicated success manager and priority support SLA"]'::jsonb)
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "monthly_price_cents" = EXCLUDED."monthly_price_cents",
  "onboarding_fee_cents" = EXCLUDED."onboarding_fee_cents",
  "is_public" = EXCLUDED."is_public",
  "is_custom" = EXCLUDED."is_custom",
  "sort_order" = EXCLUDED."sort_order",
  "allowances" = EXCLUDED."allowances",
  "features" = EXCLUDED."features",
  "updated_at" = now();
--> statement-breakpoint

INSERT INTO "resupply"."billing_addons" ("code", "name", "category", "description", "recurring_price_cents", "one_time_min_cents", "one_time_max_cents", "unit_label", "usage_metric", "pass_through_note", "sort_order") VALUES
('additional_seat','Additional staff seat','capacity','Extra admin/staff user beyond the plan allowance.',4900,NULL,NULL,'user/month','seats',NULL,10),
('active_patient_block','Additional active patient block','capacity','Adds 500 active patients/customers to the plan allowance.',9900,NULL,NULL,'500 patients/month','activePatients',NULL,20),
('additional_location','Additional location','capacity','Adds one serviced business branch/location.',19900,NULL,NULL,'location/month','locations',NULL,30),
('message_bundle','Extra SMS/email message bundle','usage','Adds 1,000 outbound SMS/email messages.',5000,NULL,NULL,'1,000 messages','outboundMessagesPerMonth','Carrier fees and unusually high MMS/voice costs may pass through.',40),
('ai_text_bundle','Extra AI text interaction bundle','usage','Adds 1,000 AI text interactions.',4000,NULL,NULL,'1,000 interactions','aiTextInteractionsPerMonth',NULL,50),
('billing_transaction_bundle','Extra claims/eligibility transaction bundle','usage','Adds 1,000 claims, eligibility, or billing transactions.',7500,NULL,NULL,'1,000 transactions','billingTransactionsPerMonth','Clearinghouse pass-through fees are billed separately.',60),
('storage_100gb','Extra storage','usage','Adds 100 GB of document/storage capacity.',2500,NULL,NULL,'100 GB/month','storageGb',NULL,70),
('ai_voice_agent','AI voice agent / IVR','premium','AI voice agent and IVR automation.',49900,NULL,NULL,'month','aiVoiceEvents','Usage billed separately.',80),
('advanced_billing_automation','Advanced billing automation','premium','Auto-submit, AI queue, denial analyzer, and payer rules.',69900,NULL,NULL,'month',NULL,NULL,90),
('fax_automation','Fax automation','premium','Outbound fax and inbound fax workflow automation.',19900,NULL,NULL,'month','faxEvents','Fax carrier costs pass through.',100),
('additional_therapy_vendor','Additional therapy-cloud vendor','integration','Adds one therapy-cloud vendor connection beyond the included allowance.',29900,NULL,NULL,'vendor/month',NULL,NULL,110),
('advanced_analytics','Advanced analytics suite','premium','Financial, attribution, LTV/CAC, channel, and inventory analytics.',39900,NULL,NULL,'month',NULL,NULL,120),
('multi_location_management','Multi-location management','premium','Enables multi-branch workflows when not included in the plan.',49900,NULL,NULL,'month','locations',NULL,130),
('data_migration','Data migration package','one_time','One-time migration package. Price depends on source system and data quality.',NULL,250000,1500000,'project',NULL,NULL,140),
('custom_domain_branding_setup','Custom domain + branding setup','one_time','One-time custom domain and branding setup.',NULL,50000,50000,'setup',NULL,NULL,150),
('dedicated_success_manager','Dedicated success manager','premium','Dedicated customer-success ownership and recurring workflow review.',100000,NULL,NULL,'month',NULL,NULL,160),
('custom_integration','Custom integration','one_time','Scoped custom integration work.',NULL,500000,2500000,'project',NULL,NULL,170)
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "category" = EXCLUDED."category",
  "description" = EXCLUDED."description",
  "recurring_price_cents" = EXCLUDED."recurring_price_cents",
  "one_time_min_cents" = EXCLUDED."one_time_min_cents",
  "one_time_max_cents" = EXCLUDED."one_time_max_cents",
  "unit_label" = EXCLUDED."unit_label",
  "usage_metric" = EXCLUDED."usage_metric",
  "pass_through_note" = EXCLUDED."pass_through_note",
  "sort_order" = EXCLUDED."sort_order",
  "updated_at" = now();
--> statement-breakpoint

INSERT INTO "resupply"."tenant_billing_subscriptions" ("org_id", "plan_id", "status", "notes", "updated_by_email")
SELECT o."id", p."id", 'active', 'Seeded default package assignment', 'migration:0362'
FROM "resupply"."organizations" o
JOIN "resupply"."billing_plans" p ON p."code" = 'launch'
WHERE NOT EXISTS (
  SELECT 1 FROM "resupply"."tenant_billing_subscriptions" s
  WHERE s."org_id" = o."id" AND s."status" IN ('active','trialing','past_due')
);
