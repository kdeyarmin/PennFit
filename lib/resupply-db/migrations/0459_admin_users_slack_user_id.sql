-- 0459_admin_users_slack_user_id — link a Slack user to an admin account so a
-- Slack "Claim" button can assign a conversation to the rep who clicked it.
--
-- An admin sets each rep's Slack user id (Uxxxxxxxx) from the Team settings
-- page. When a rep clicks Claim on a Slack alert, the inbound handler resolves
-- payload.user.id → this column (within the request's tenant) → admin_users.id
-- and assigns the conversation. NULL = not linked (Claim falls back to a
-- prompt asking the rep to link their account).
--
-- Nullable, no backfill. Unique per tenant (a Slack user maps to at most one
-- admin within an org) via a partial index that ignores NULLs.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

ALTER TABLE "resupply"."admin_users"
  ADD COLUMN IF NOT EXISTS "slack_user_id" text;

CREATE UNIQUE INDEX IF NOT EXISTS "admin_users_org_slack_user_id_unique"
  ON "resupply"."admin_users" ("org_id", "slack_user_id")
  WHERE "slack_user_id" IS NOT NULL;
