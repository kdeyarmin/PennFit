-- 0200_statement_delivery_tracking — Biller #30: batch-send of patient-
-- responsibility statements.
--
-- `patient_billing_statements` already renders + persists a statement
-- (PDF object key, total, line items) with an optional `delivery_method`
-- and a `delivered_at` timestamp, but nothing records the OUTCOME of an
-- actual send. To batch-send statements (email/SMS, consent/DND-gated)
-- and show the biller what's outstanding vs sent vs failed, we add a
-- small delivery-state machine:
--
--   * delivery_status  — pending (default) | sent | failed | skipped.
--                        'skipped' = gated out (opted-out / DND / no
--                        channel) so the operator can see why it didn't
--                        go rather than it silently staying pending.
--   * delivery_channel — email | sms — the channel that actually sent.
--   * delivery_error   — short failure reason (no PHI).
--
-- `delivered_at` (existing) is set to the send time when status → sent.
-- All additive + nullable / defaulted; existing rows become 'pending'.
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."patient_billing_statements"
  ADD COLUMN IF NOT EXISTS "delivery_status" text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
ALTER TABLE "resupply"."patient_billing_statements"
  ADD COLUMN IF NOT EXISTS "delivery_channel" text;
--> statement-breakpoint
ALTER TABLE "resupply"."patient_billing_statements"
  ADD COLUMN IF NOT EXISTS "delivery_error" text;
--> statement-breakpoint

ALTER TABLE "resupply"."patient_billing_statements"
  DROP CONSTRAINT IF EXISTS "patient_billing_statements_delivery_status_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."patient_billing_statements"
  ADD CONSTRAINT "patient_billing_statements_delivery_status_enum"
  CHECK ("delivery_status" IN ('pending', 'sent', 'failed', 'skipped'));
--> statement-breakpoint

ALTER TABLE "resupply"."patient_billing_statements"
  DROP CONSTRAINT IF EXISTS "patient_billing_statements_delivery_channel_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."patient_billing_statements"
  ADD CONSTRAINT "patient_billing_statements_delivery_channel_enum"
  CHECK ("delivery_channel" IS NULL OR "delivery_channel" IN ('email', 'sms'));
--> statement-breakpoint

-- The batch-send worklist scans for pending statements.
CREATE INDEX IF NOT EXISTS "patient_billing_statements_delivery_status_idx"
  ON "resupply"."patient_billing_statements" ("delivery_status");
