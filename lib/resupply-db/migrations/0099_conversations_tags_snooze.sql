-- Conversation triage adds (Wave 1):
--   * conversations.tags         — free-form CSR triage tags
--   * conversations.snoozed_until — UI-only "hide until later"
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+.

ALTER TABLE "resupply"."conversations"
  ADD COLUMN IF NOT EXISTS "tags" jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "resupply"."conversations"
  ADD COLUMN IF NOT EXISTS "snoozed_until" timestamp with time zone;
