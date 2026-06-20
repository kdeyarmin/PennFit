-- 0035_shop_customer_notes — internal CSR-authored notes attached
-- to a shop customer. Mirrors `patient_notes` (migration 0004) for
-- the cash-pay shop side.
--
-- The intent is "leave context for the next CSR": phone-call
-- summaries, refund decisions, why-we-credited-this-account, etc.
-- These live OUTSIDE the customer-visible conversation thread, so
-- staff can capture context without leaking internal language to
-- the customer.
--
-- Append-only by design: there is no `updated_at`, no edit
-- endpoint, and the UI offers no edit affordance. A note is a
-- record of what an admin saw / did at a moment in time — letting
-- one admin rewrite another's note destroys the audit value of
-- the table. Hard delete is admin-gated per Rule 8 in
-- `scripts/check-resupply-architecture.sh`; v1 ships create+list
-- only.
--
-- ON DELETE CASCADE on customer_id: when a shop customer is
-- hard-deleted (auth.users tear-down → shop_customers cascade),
-- the notes go with the row. The audit log is the long-term
-- record of who touched the account.

CREATE TABLE IF NOT EXISTS "resupply"."shop_customer_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" text NOT NULL REFERENCES "resupply"."shop_customers"("customer_id") ON DELETE CASCADE,
  "body" text NOT NULL,
  "author_email" text NOT NULL,
  "author_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Dashboard always queries "all notes for this customer, newest
-- first". The composite (customer_id, created_at DESC) lets the
-- ORDER BY be served from the index.
CREATE INDEX IF NOT EXISTS "shop_customer_notes_customer_created_idx"
  ON "resupply"."shop_customer_notes" ("customer_id", "created_at" DESC);
