-- 0467_billing_notes — a free-form notes log for the billing team.
--
-- Why
-- ---
-- The schema already pins notes to specific artifacts: per-claim history
-- lives in insurance_claim_events (event_type = 'note'), per-order in
-- shop_order_notes, per-customer in shop_customer_notes, and the dunning
-- ladder keeps its own touch log. What's missing is a place for a biller
-- to jot a free-form, cross-cutting note that isn't about ONE claim or ONE
-- order — "Aetna is sitting on the August batch", "called the BCBS rep re
-- the timely-filing appeals", "collections agency wants the next export by
-- Friday". Today those go on a sticky note or a side spreadsheet and the
-- next biller never sees them.
--
-- Model
-- -----
-- One append-only table. Each note carries a coarse category (claims /
-- collections / payer / patient / general) so the log can be filtered, and
-- an OPTIONAL patient link (ON DELETE SET NULL) for when a note happens to
-- be about a specific patient's account without belonging on one claim.
-- Append-only, internal-only, never rendered on any patient-facing page.
--
-- PHI / log posture: the body is plain text and may contain anything the
-- biller types. The audit log records the write structurally (category +
-- body_length) but NEVER the body content itself.
--
-- Per ADR 003 — versioned hand-authored migration. Tenant-scoped via org_id
-- (auto-tagged by the org-scoped Supabase client on every insert).

CREATE TABLE IF NOT EXISTS "resupply"."billing_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),
  -- Coarse bucket so the log filters cleanly. Free-text is in `body`.
  "category" text NOT NULL DEFAULT 'general',
  -- Optional link to a patient when the note is about a specific account.
  -- SET NULL so a patient delete doesn't take the billing history with it.
  "patient_id" uuid
    REFERENCES "resupply"."patients"("id") ON DELETE SET NULL,
  "body" text NOT NULL,
  "author_email" text NOT NULL,
  "author_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "billing_notes_category_chk"
    CHECK ("category" IN (
      'claims', 'collections', 'payer', 'patient', 'general'
    ))
);
--> statement-breakpoint

-- The default feed: a tenant's notes, newest first.
CREATE INDEX IF NOT EXISTS "billing_notes_org_created_idx"
  ON "resupply"."billing_notes" ("org_id", "created_at" DESC);
--> statement-breakpoint

-- Category-filtered feed.
CREATE INDEX IF NOT EXISTS "billing_notes_category_idx"
  ON "resupply"."billing_notes" ("org_id", "category", "created_at" DESC);
--> statement-breakpoint

-- Notes pulled up on a specific patient's account.
CREATE INDEX IF NOT EXISTS "billing_notes_patient_idx"
  ON "resupply"."billing_notes" ("patient_id", "created_at" DESC)
  WHERE "patient_id" IS NOT NULL;
