-- 0534_invite_acceptance_reminder_stamps — per-invite nudge stamps for the
-- "you were invited but never signed in" sweep.
--
-- Background
-- ----------
-- Migration 0143 added expiry_reminder_sent_at / expired_notice_sent_at to
-- resupply_auth.password_credentials, which covers the invite path where an
-- operator TYPES a temporary password ("Set their password for them" in
-- lib/resupply-auth/src/team-invite.ts). The OTHER — and far more common —
-- invite path mints a 7-day `password_reset` email_token and mails a
-- set-password link. That path had no follow-up at all: one email goes out,
-- and if the recipient never clicks it the invite expires in silence.
--
-- These two columns are the idempotency ledger for that follow-up sweep
-- (artifacts/resupply-api/src/worker/jobs/invite-acceptance-reminder.ts):
-- a mid-window nudge and a final one shortly before the link dies.
--
-- Why on resupply_auth.users and not on email_tokens
-- --------------------------------------------------
-- email_tokens is the natural anchor (one row per invite), but its primary
-- key is a `bytea` token_hash. The sweep's duplicate-send guard is a
-- conditional UPDATE issued through PostgREST, and round-tripping a bytea PK
-- through a filter is exactly the kind of encoding ambiguity that turns a
-- "claim" into a silent no-op (or, worse, a match on the wrong row). The
-- users row has a text PK, is already read by the sweep, and one row per
-- invitee is the right cardinality for "have we nudged this person yet".
--
-- Staleness instead of clearing
-- -----------------------------
-- Nothing resets these columns. A re-invite / resend expires the old token
-- and mints a NEW one (team-invite.ts), so the sweep treats any stamp that
-- PREDATES the live token's created_at as stale and lets the fresh invite
-- earn its own nudge pair. Same trick 0143 plays with set_by_admin_at, and
-- it keeps the writer (the sweep) the only thing that has to know about it.
--
-- Per ADR 003 — versioned hand-authored migration, idempotent.

ALTER TABLE "resupply_auth"."users"
  ADD COLUMN IF NOT EXISTS "invite_reminder_sent_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "invite_final_reminder_sent_at" timestamp with time zone;
--> statement-breakpoint

-- The sweep's candidate scan is "status = 'invited' AND never verified".
-- Partial on status so the index stays proportional to the outstanding
-- invite backlog rather than to the whole identity table (which carries
-- every storefront customer and portal login too).
CREATE INDEX IF NOT EXISTS "auth_users_pending_invite_idx"
  ON "resupply_auth"."users" ("created_at")
  WHERE "status" = 'invited' AND "email_verified_at" IS NULL;
--> statement-breakpoint

-- The sweep starts from the live-token side: unconsumed password_reset
-- tokens that have not expired yet. Without this, every tick sequential-scans
-- email_tokens, which grows forever (consumed rows are kept as audit trail).
CREATE INDEX IF NOT EXISTS "auth_email_tokens_live_reset_idx"
  ON "resupply_auth"."email_tokens" ("expires_at", "user_id")
  WHERE "purpose" = 'password_reset' AND "consumed_at" IS NULL;
