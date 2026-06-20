-- Phase 1 of the customer-message template library.
-- See docs/proposals/customer-message-templates.md for the full design,
-- and lib/resupply-db/src/schema/message-templates.ts for the
-- TypeScript declaration this SQL mirrors.
--
-- IMPORTANT — journal posture
-- ---------------------------
-- This file is NOT yet listed in lib/resupply-db/drizzle/meta/_journal.json.
-- The repo currently has 21 SQL files past idx 51 that are similarly
-- not journaled (see docs/migration-state-investigation-2026-05-08.md);
-- adding this entry to the journal in isolation would compound that
-- drift and risks colliding with whatever production has actually
-- applied. The render path (`@workspace/resupply-templates`'s
-- `renderMessage`) falls back to each call site's hard-coded baseline
-- when the table is missing or the lookup fails, so this Phase-1 work
-- is forward-safe under both states:
--
--   * Migration applied → renderMessage queries the table, finds the
--     seeded row (which equals the fallback initially), substitutes
--     variables, returns. Admins can edit via the API to deviate.
--   * Migration NOT applied → renderMessage queries fail with a
--     "relation does not exist" error, which is caught and degraded
--     to the fallback path. Behaviour is byte-identical to today.
--
-- The journal entry should be added in the same coordinated change
-- that resolves P0.1 + P0.2 (production state inspection + journal
-- reconciliation). Until then, this SQL is forward-deploy-safe but
-- inert in environments running migrate.mjs.

CREATE TABLE IF NOT EXISTS "resupply"."message_templates" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
  "template_key" text NOT NULL,
  "channel" text NOT NULL,
  "subject" text,
  "body_html" text,
  "body_text" text NOT NULL,
  "allowed_variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" text,
  CONSTRAINT "message_templates_body_text_max_length" CHECK (length("body_text") <= 50000),
  CONSTRAINT "message_templates_body_html_max_length" CHECK ("body_html" IS NULL OR length("body_html") <= 200000),
  CONSTRAINT "message_templates_subject_max_length" CHECK ("subject" IS NULL OR length("subject") <= 1000),
  CONSTRAINT "message_templates_channel_enum" CHECK ("channel" IN ('email', 'sms', 'voice', 'push'))
);

-- One row per (key, channel) tuple. The unique index doubles as the
-- index the lookup hits on every send, so no separate non-unique
-- index is needed for that path.
CREATE UNIQUE INDEX IF NOT EXISTS "message_templates_key_channel_idx"
  ON "resupply"."message_templates" ("template_key", "channel");

-- For the admin-list page that filters to active templates only,
-- grouped by templateKey. Cheap and small.
CREATE INDEX IF NOT EXISTS "message_templates_active_key_idx"
  ON "resupply"."message_templates" ("is_active", "template_key");
