-- shop_returns: refund-failure tracking columns.
--
-- Why
-- ---
-- The /admin/shop/returns/:id/refund handler catches Stripe errors,
-- logs a warn, and returns 502. The row stays at `status='received'`
-- so the admin can retry. Until this migration there was no record
-- ANYWHERE of how many times Stripe had rejected a given refund —
-- admins clicked retry blindly, and an actually-broken state (wrong
-- payment intent id, deleted account, locked dispute) burned admin
-- time before anyone realised the loop wasn't going to terminate.
--
-- This migration adds three columns:
--
--   refund_failure_count       — increments on each Stripe error.
--                                Stays at 0 on the happy path. Lets
--                                the admin UI surface "Refund failed
--                                N times" and the handler emit a
--                                structured warn log at a threshold.
--   refund_last_failure_at     — timestamp of the most recent
--                                failure so an operator can see how
--                                stale the last error is (a single
--                                failure 30 days ago is very
--                                different from one 30 seconds ago).
--   refund_last_failure_reason — short, sanitized error tag from the
--                                Stripe SDK exception. CAPPED so a
--                                long error body can't bloat the
--                                row. NEVER carries PHI — the
--                                handler writes the Stripe error
--                                code/message only.
--
-- A successful refund does NOT clear these columns — the failure
-- history stays attached to the row for retrospective forensics
-- (helpful when a customer says "you tried to refund me three
-- times before it worked, please confirm only once landed").
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."shop_returns"
  ADD COLUMN IF NOT EXISTS "refund_failure_count" integer NOT NULL DEFAULT 0;

ALTER TABLE "resupply"."shop_returns"
  ADD COLUMN IF NOT EXISTS "refund_last_failure_at" timestamp with time zone;

ALTER TABLE "resupply"."shop_returns"
  ADD COLUMN IF NOT EXISTS "refund_last_failure_reason" text;

-- Defensive CHECK on the failure-reason column. The handler caps
-- the value to 240 chars before writing; the DB-side guard catches
-- a future call site that forgets to truncate.
ALTER TABLE "resupply"."shop_returns"
  DROP CONSTRAINT IF EXISTS "shop_returns_refund_last_failure_reason_len";
ALTER TABLE "resupply"."shop_returns"
  ADD CONSTRAINT "shop_returns_refund_last_failure_reason_len"
    CHECK (
      "refund_last_failure_reason" IS NULL
      OR char_length("refund_last_failure_reason") <= 500
    );
