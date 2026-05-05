-- shop_customer_followups — internal CSR-scheduled callback /
-- check-back reminders attached to a shop customer.
--
-- Distinct from shop_customer_notes (migration 0035): notes are
-- a passive paper trail; followups are an active commitment by a
-- specific CSR to do something by a specific time. The split keeps
-- "what happened" separate from "what I owe" so the customer-360
-- panel can render each cleanly.
--
-- Lifecycle:
--   * Created with `due_at` set, `completed_at` null. Surfaces in
--     the open queue.
--   * Marked complete: `completed_at` set to now() + the
--     `completed_by_email` is recorded. No edit/delete to keep an
--     append-only audit trail (a CSR who needs to revise just creates
--     a new followup).
--
-- Note: only ONE mutation lifecycle (open → completed). We don't
-- need a "snoozed" state; a CSR who needs to push the date out can
-- complete the current row and create a new one.
--
-- Audit verbs:
--   shop_customer.followup.create   — new followup; records
--     customer_id + due_at + body_length — never the body.
--   shop_customer.followup.complete — mark complete; records
--     customer_id + body_length — never the body.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."shop_customer_followups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" text NOT NULL REFERENCES "resupply"."shop_customers"("customer_id") ON DELETE CASCADE,
  "body" text NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  "completed_by_email" text,
  "completed_by_user_id" text,
  "created_by_email" text NOT NULL,
  "created_by_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Open followups, ordered by due_at — drives the "what's overdue"
-- and "what's due soon" panel queries.
CREATE INDEX IF NOT EXISTS "shop_customer_followups_open_due_idx"
  ON "resupply"."shop_customer_followups" ("due_at")
  WHERE "completed_at" IS NULL;

-- Per-customer history (open + completed), newest-due first. Drives
-- the customer-360 panel.
CREATE INDEX IF NOT EXISTS "shop_customer_followups_customer_due_idx"
  ON "resupply"."shop_customer_followups" ("customer_id", "due_at" DESC);
