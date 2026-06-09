-- bulk_campaign_recipients: bounded transient-failure retry.
--
-- Before this, a recipient whose send threw was flipped straight to
-- 'failed' and never re-picked, so a transient SendGrid blip that
-- outlasted the email client's in-call retry budget permanently dropped
-- that recipient (recovery meant a CSR cloning the campaign with the
-- failed ids). This adds a bounded re-pick:
--   * `send_attempts` counts the delivery attempts so far.
--   * a new 'retry_pending' status marks a recipient to be re-picked by
--     a later tick (treated identically to 'pending' for selection).
-- The tick re-queues a *retryable* failure as 'retry_pending' until
-- `send_attempts` reaches the cap, then marks it 'failed' for good — so
-- a sustained outage self-heals on recovery without an unbounded spin.

ALTER TABLE "resupply"."bulk_campaign_recipients"
  ADD COLUMN IF NOT EXISTS "send_attempts" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Extend the status enum check to admit 'retry_pending'. Drop + re-add
-- (the constraint name is stable since migration 0083).
ALTER TABLE "resupply"."bulk_campaign_recipients"
  DROP CONSTRAINT IF EXISTS "bulk_campaign_recipients_status_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."bulk_campaign_recipients"
  ADD CONSTRAINT "bulk_campaign_recipients_status_enum"
    CHECK ("status" IN ('pending', 'retry_pending', 'suppressed', 'sending', 'sent', 'failed'));
