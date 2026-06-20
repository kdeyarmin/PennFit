-- 0253_claim_signature_tracking_bill_hold — signature/paperwork tracking
-- and the claim-level BILL HOLD that gates submission until every required
-- document is back, signed.
--
-- Why
-- ---
-- The order-ship gate (migration 0248 + lib/paperwork/require-signed-paperwork)
-- already blocks a *shipment* until the patient's intake forms (HIPAA NPP,
-- AOB, Supplier Standards) are on file. But nothing held the *claim*: a CSR
-- could submit an 837P to the payer while the signed prescription / CMN /
-- proof-of-delivery was still outstanding, which is exactly the paperwork an
-- auditor asks for on a post-pay review. A claim that goes out without the
-- chart support behind it is a recoupment waiting to happen.
--
-- This migration adds a per-claim paperwork ledger and a hold flag so a
-- claim is NOT released for billing until every required signature is back.
-- When the last outstanding requirement is satisfied — including
-- automatically, when a signed document is faxed back to our Telnyx number
-- (lib/fax/ingest-inbound auto-match) — the hold lifts and the claim becomes
-- submittable again.
--
-- Model
-- -----
--   * claim_paperwork_requirements — one row per piece of paperwork a claim
--     (or, before a claim exists, a patient) needs back signed. Carries the
--     requirement type, a human label, the lifecycle status, how/when it was
--     sent out for signature, and how/when it came back satisfied (manual
--     mark, portal e-sign, upload, or an inbound fax it was auto-matched to).
--   * insurance_claims gains bill_hold + release bookkeeping columns. The
--     authoritative "should this be held?" answer is always
--     `EXISTS (outstanding required requirement)`; the boolean is a
--     denormalised cache the application keeps in step via
--     recomputeBillHold() so list/worklist queries don't sub-aggregate.
--
-- Per ADR 003 — versioned hand-authored migration. Plain tables, no RLS;
-- service-role client only. PHI: the linked document content lives in object
-- storage / patient_documents under their own ACL — this ledger stores only
-- types, labels, status, and soft pointers.

-- ────────────────────────────────────────────────────────────────────
-- 1. claim_paperwork_requirements — the per-claim signature ledger.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."claim_paperwork_requirements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- The claim this paperwork gates. Nullable so a requirement can be
  -- tracked against a patient before the claim row exists (e.g. paperwork
  -- chased at intake); the seeding pass links it to the claim later.
  -- ON DELETE CASCADE: drop a claim → drop its requirement rows.
  "claim_id" uuid
    REFERENCES "resupply"."insurance_claims"("id") ON DELETE CASCADE,
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  -- What document is required. Drives the default label + which on-file
  -- source can auto-satisfy it.
  "requirement_type" text NOT NULL,
  "label" text NOT NULL,
  -- outstanding — still waiting on a signed return (HOLDS the claim).
  -- satisfied   — returned signed (or found on file). Releases its slot.
  -- waived      — a CSR judged it not needed for this claim (released,
  --               with a reason). Does NOT hold.
  -- voided      — created in error. Does NOT hold.
  "status" text NOT NULL DEFAULT 'outstanding',
  -- A non-required requirement is informational only — it never holds the
  -- claim even while outstanding (e.g. a "nice to have" chart note).
  "required" boolean NOT NULL DEFAULT true,

  -- Outbound: when/how we last sent this out for signature, and the fax
  -- number we expect the signed copy to come BACK from. The inbound-fax
  -- auto-match keys on expected_return_fax_e164.
  "sent_at" timestamp with time zone,
  "sent_via" text,
  "expected_return_fax_e164" text,
  -- Reminder bookkeeping (mirrors patient_packets.reminder_count /
  -- last_reminded_at). The reminder sweep + the per-requirement "remind"
  -- action bump these.
  "reminder_count" integer NOT NULL DEFAULT 0,
  "last_reminded_at" timestamp with time zone,

  -- Inbound: how/when it came back satisfied.
  "satisfied_at" timestamp with time zone,
  "satisfied_via" text,
  "satisfied_by_email" text,
  -- The inbound fax this requirement was matched to (auto or manual). SET
  -- NULL if that fax row is ever reaped.
  "satisfied_inbound_fax_id" uuid
    REFERENCES "resupply"."inbound_faxes"("id") ON DELETE SET NULL,
  -- Soft pointer to a chart document (patient_documents) that satisfies it.
  -- No FK — patient_documents rows are reaped by the retention sweep.
  "satisfied_document_id" uuid,

  -- Soft pointers to where this requirement was sent FROM, for traceability
  -- (no FK; these tables have their own retention).
  "source_manual_document_id" uuid,
  "source_packet_id" uuid,

  "waived_reason" text,
  "notes" text,
  "created_by_email" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "claim_paperwork_requirements_type_chk"
    CHECK ("requirement_type" IN (
      'prescription', 'swo', 'cmn', 'dwo', 'aob', 'abn',
      'proof_of_delivery', 'medical_records', 'face_to_face',
      'sleep_study', 'agreement', 'other'
    )),
  CONSTRAINT "claim_paperwork_requirements_status_chk"
    CHECK ("status" IN ('outstanding', 'satisfied', 'waived', 'voided')),
  CONSTRAINT "claim_paperwork_requirements_sent_via_chk"
    CHECK ("sent_via" IS NULL OR "sent_via" IN (
      'fax', 'email', 'esign', 'portal', 'mail', 'manual'
    )),
  CONSTRAINT "claim_paperwork_requirements_satisfied_via_chk"
    CHECK ("satisfied_via" IS NULL OR "satisfied_via" IN (
      'inbound_fax', 'upload', 'esign', 'portal', 'mail', 'manual'
    ))
);
--> statement-breakpoint

-- The hot path: "what is still outstanding on this claim?" The partial
-- index keeps the bill-hold recompute + the batch-submit gate cheap.
CREATE INDEX IF NOT EXISTS "claim_paperwork_requirements_open_claim_idx"
  ON "resupply"."claim_paperwork_requirements" ("claim_id")
  WHERE "status" = 'outstanding' AND "required" = true;
--> statement-breakpoint

-- A patient → all of their paperwork (the patient-card "what's missing" view).
CREATE INDEX IF NOT EXISTS "claim_paperwork_requirements_patient_idx"
  ON "resupply"."claim_paperwork_requirements" ("patient_id", "created_at" DESC);
--> statement-breakpoint

-- Inbound-fax auto-match keys on the expected return number. Partial so the
-- index only carries rows actually waiting on a fax.
CREATE INDEX IF NOT EXISTS "claim_paperwork_requirements_expected_fax_idx"
  ON "resupply"."claim_paperwork_requirements" ("expected_return_fax_e164")
  WHERE "status" = 'outstanding' AND "expected_return_fax_e164" IS NOT NULL;
--> statement-breakpoint

-- The worklist / task surface: outstanding required rows oldest-first.
CREATE INDEX IF NOT EXISTS "claim_paperwork_requirements_worklist_idx"
  ON "resupply"."claim_paperwork_requirements" ("created_at")
  WHERE "status" = 'outstanding' AND "required" = true;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 2. insurance_claims — the bill-hold flag + release bookkeeping.
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "bill_hold" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "bill_hold_reason" text;
--> statement-breakpoint
ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "bill_hold_updated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "bill_hold_released_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "bill_hold_released_by" text;
--> statement-breakpoint

-- The held-claims worklist scans for bill_hold = true. Partial index keeps
-- it to the (usually small) set of currently-held claims.
CREATE INDEX IF NOT EXISTS "insurance_claims_bill_hold_idx"
  ON "resupply"."insurance_claims" ("updated_at" DESC)
  WHERE "bill_hold" = true;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 3. Feature flags. Keep in sync with FEATURE_FLAG_KEYS in
--    artifacts/resupply-api/src/lib/feature-flags.ts.
-- ────────────────────────────────────────────────────────────────────
-- Seeded ENABLED: the hold is the whole point, and it is inert until a
-- claim actually has an outstanding REQUIRED requirement — a claim with
-- no requirement rows is never held. So turning it on cannot retroactively
-- freeze claims that have nothing tracked against them.
INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('billing.bill_hold',
   true,
   'Bill hold. When ON, a claim cannot be submitted to the clearinghouse while it has any outstanding REQUIRED signed-paperwork requirement; the hold lifts automatically when the last one comes back (manual mark, portal e-sign, upload, or an inbound fax auto-matched to it). A claim with no tracked requirements is never held. When OFF, the gate is skipped entirely.',
   'Billing'),
  ('billing.bill_hold_auto_remind',
   false,
   'Bill-hold auto-reminders. When ON (and the opt-in BILL_HOLD_SWEEP_CRON is scheduled), the sweep job sends a reminder for paperwork that has been outstanding past the reminder threshold. When OFF, the sweep still recomputes holds and seeds requirements but sends nothing — reminders are sent only from the per-requirement "remind" action.',
   'Billing')
ON CONFLICT (key) DO NOTHING;
