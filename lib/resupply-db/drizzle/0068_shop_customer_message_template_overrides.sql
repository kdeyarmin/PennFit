-- Phase 3 of the customer-message template library: per-customer
-- overrides. Sister table to 0067_message_templates.
--
-- See lib/resupply-db/src/schema/shop-customer-message-template-overrides.ts
-- for the TS declaration this SQL mirrors and
-- docs/proposals/customer-message-templates.md for the broader design.
--
-- IMPORTANT — same journal posture as 0067
-- ----------------------------------------
-- This SQL file is intentionally NOT added to
-- lib/resupply-db/drizzle/meta/_journal.json. The render-path
-- lookup (`@workspace/resupply-templates` + the API-side helper in
-- `artifacts/resupply-api/src/lib/message-templates/lookup.ts`)
-- gracefully degrades when this table is missing — the override
-- query is wrapped in a try/catch and falls back to the global
-- template, which itself falls back to the call-site baseline.
-- So Phase 3 is forward-deploy-safe under both states:
--
--   * Migration applied → admins can create per-customer overrides
--     via the new admin UI; the lookup picks them up; renderMessage
--     interpolates the override's content (or inherits per-field
--     null fields from the global).
--   * Migration NOT applied → override-table queries fail with
--     "relation does not exist", caught and degraded to the
--     global-template-only path. Behaviour is identical to Phase 2.
--
-- The journal entry should land alongside the broader P0.1+P0.2
-- reconciliation (see docs/migration-state-investigation-2026-05-08.md).

CREATE TABLE IF NOT EXISTS "resupply"."shop_customer_message_template_overrides" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
  "customer_id" text NOT NULL,
  "template_key" text NOT NULL,
  "channel" text NOT NULL,
  "subject" text,
  "body_html" text,
  "body_text" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" text,
  CONSTRAINT "shop_customer_msg_tmpl_overrides_body_text_max_length" CHECK ("body_text" IS NULL OR length("body_text") <= 50000),
  CONSTRAINT "shop_customer_msg_tmpl_overrides_body_html_max_length" CHECK ("body_html" IS NULL OR length("body_html") <= 200000),
  CONSTRAINT "shop_customer_msg_tmpl_overrides_subject_max_length" CHECK ("subject" IS NULL OR length("subject") <= 1000),
  CONSTRAINT "shop_customer_msg_tmpl_overrides_note_max_length" CHECK ("note" IS NULL OR length("note") <= 2000),
  CONSTRAINT "shop_customer_msg_tmpl_overrides_channel_enum" CHECK ("channel" IN ('email', 'sms', 'voice', 'push'))
);

-- Unique on (customer, template_key, channel) — at most one override
-- per customer per channel-flavour. Doubles as the lookup index the
-- render path hits on every send for an authenticated user.
CREATE UNIQUE INDEX IF NOT EXISTS "shop_customer_msg_tmpl_overrides_unique_idx"
  ON "resupply"."shop_customer_message_template_overrides" ("customer_id", "template_key", "channel");
