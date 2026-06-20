-- 0189_cases — Phase 0 / F4: lightweight case (ticket) object.
--
-- Why this exists
-- ---------------
-- A multi-channel CSR issue ("lost order #12345" spanning an SMS, a fax,
-- and a refund) has no persistent home today — it scatters across
-- conversations, order notes, and followups. The case object gives such
-- an issue ONE record, and case_links ties the related artifacts (a
-- conversation, an order, a followup, …) to it. Paired with the unified
-- work-item read model (follow-up slice), this is the F4 foundation the
-- CSR-cluster features build on.
--
-- Soft references (no hard FK to patients/orders/etc.) so a case + its
-- links survive independent of those rows and we don't couple to their
-- key types. Additive. Per ADR 003 — versioned hand-authored migration.

-- ---------------------------------------------------------------
-- cases — one record per cross-channel issue.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "resupply"."cases" (
  "id" text PRIMARY KEY DEFAULT (gen_random_uuid()::text) NOT NULL,
  "title" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "priority" text NOT NULL DEFAULT 'normal',
  -- Soft refs: a case may be patient- and/or customer-scoped, or neither.
  "patient_id" text,
  "customer_id" text,
  "assigned_to_user_id" text,
  "opened_by_user_id" text,
  "opened_by_email" text NOT NULL,
  "summary" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone
);
--> statement-breakpoint

ALTER TABLE "resupply"."cases"
  DROP CONSTRAINT IF EXISTS "cases_status_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."cases"
  ADD CONSTRAINT "cases_status_enum"
  CHECK ("status" IN ('open', 'in_progress', 'resolved', 'closed'));
--> statement-breakpoint
ALTER TABLE "resupply"."cases"
  DROP CONSTRAINT IF EXISTS "cases_priority_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."cases"
  ADD CONSTRAINT "cases_priority_enum"
  CHECK ("priority" IN ('low', 'normal', 'high', 'urgent'));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "cases_status_created_idx"
  ON "resupply"."cases" ("status", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cases_patient_idx"
  ON "resupply"."cases" ("patient_id")
  WHERE "patient_id" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "resupply"."cases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- case_links — a case ↔ many artifacts (conversation/order/…).
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "resupply"."case_links" (
  "id" text PRIMARY KEY DEFAULT (gen_random_uuid()::text) NOT NULL,
  "case_id" text NOT NULL
    REFERENCES "resupply"."cases"("id") ON DELETE CASCADE,
  "link_kind" text NOT NULL,
  -- The linked artifact's id (soft ref).
  "ref_id" text NOT NULL,
  "note" text,
  "created_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Idempotent linking: one (kind, ref) per case.
  CONSTRAINT "case_links_unique" UNIQUE ("case_id", "link_kind", "ref_id")
);
--> statement-breakpoint

ALTER TABLE "resupply"."case_links"
  DROP CONSTRAINT IF EXISTS "case_links_kind_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."case_links"
  ADD CONSTRAINT "case_links_kind_enum"
  CHECK ("link_kind" IN (
    'conversation',
    'order',
    'followup',
    'fax',
    'review',
    'product_question',
    'referral',
    'work_item',
    'other'
  ));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "case_links_case_idx"
  ON "resupply"."case_links" ("case_id");
--> statement-breakpoint

ALTER TABLE "resupply"."case_links" ENABLE ROW LEVEL SECURITY;
