-- 0118_insurance_claims — payer claims & EOB tracking for the DME
--> statement-breakpoint
-- billing workflow.
--
-- Why
-- ---
-- The schema today captures coverage (insurance_coverages) and
-- prior-authorization status (prior_authorizations), but nothing
-- about the actual claim lifecycle once we dispense product:
-- submission to the payer, accept/deny, EOB amounts, partial pays,
-- patient-responsibility carve-out, and appeals. That gap is the
-- single biggest revenue-leakage source for DME suppliers — denied
-- claims that never get worked, partial-pay claims where the
-- balance never moves to the patient, EOBs that get filed but never
-- reconciled.
--
-- Model
-- -----
-- Three tables:
--
--   * insurance_claims          — one row per claim submission for
--                                 a (patient, date_of_service,
--                                 payer) tuple. Carries the
--                                 status, the total amounts, and
--                                 the payer's claim_number once
--                                 they assign one.
--   * insurance_claim_line_items — one row per HCPCS line on the
--                                 claim. Individual lines can be
--                                 denied even when the claim
--                                 overall is accepted.
--   * insurance_claim_events    — append-only history. Every state
--                                 transition, EOB receipt, appeal
--                                 filing, and CSR note lands here
--                                 so the reconstruction is offline-
--                                 verifiable.
--
-- A separate `*_attachments` table is intentionally deferred — the
-- patient-document store (resupply.patient_documents + supabase
-- storage) already handles file persistence with retention policy,
-- and a `document_id` FK on insurance_claim_events is the cleanest
-- link. We add one in a follow-up if the volume warrants its own
-- table.
--
-- State machine
-- -------------
--   draft     -> submitted
--   submitted -> accepted | denied
--   accepted  -> paid | denied         (a partial pay still moves
--                                       to 'paid' with a non-zero
--                                       patient_responsibility)
--   denied    -> appealed | closed
--   appealed  -> accepted | denied
--   paid      -> closed                (manual close after balance
--                                       reconciliation)
--
-- Per ADR 003 — versioned hand-authored migration.

-- ────────────────────────────────────────────────────────────────────
-- 1. insurance_claims — top-level claim row.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."insurance_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "insurance_coverage_id" uuid
    REFERENCES "resupply"."insurance_coverages"("id") ON DELETE SET NULL,
  -- Denormalized for grep-ability when coverage is detached. Always
  -- mirrors insurance_coverages.payer_name at write time.
  "payer_name" varchar(120) NOT NULL,
  -- The payer's / clearinghouse's claim id. Null until 'submitted'.
  "claim_number" varchar(64),
  -- Date the service was rendered (the dispense / fulfillment date).
  -- Distinct from created_at so backdated claim entry is supported.
  "date_of_service" date NOT NULL,
  -- Optional link to the fulfillment that generated this claim. We
  -- SET NULL on fulfillment delete so the claim history survives a
  -- fulfillment cleanup; the line items keep the HCPCS records
  -- regardless.
  "fulfillment_id" uuid
    REFERENCES "resupply"."fulfillments"("id") ON DELETE SET NULL,
  "status" text NOT NULL DEFAULT 'draft',
  -- Money in integer cents. Total billed = sum(line_items.billed).
  -- We denormalize the totals to avoid a sub-aggregate on every
  -- list query; the API recomputes them on every write.
  "total_billed_cents" bigint NOT NULL DEFAULT 0,
  "total_allowed_cents" bigint NOT NULL DEFAULT 0,
  "total_paid_cents" bigint NOT NULL DEFAULT 0,
  "patient_responsibility_cents" bigint NOT NULL DEFAULT 0,
  "submitted_at" timestamp with time zone,
  "decision_at" timestamp with time zone,
  "paid_at" timestamp with time zone,
  -- Short payer-supplied reason on a denial. Long-form CSR notes
  -- live in insurance_claim_events.note.
  "denial_reason" text,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "insurance_claims_status_enum"
    CHECK ("status" IN (
      'draft', 'submitted', 'accepted', 'denied',
      'paid', 'appealed', 'closed'
    )),
  CONSTRAINT "insurance_claims_amounts_nonneg"
    CHECK (
      "total_billed_cents" >= 0
      AND "total_allowed_cents" >= 0
      AND "total_paid_cents" >= 0
      AND "patient_responsibility_cents" >= 0
    )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "insurance_claims_patient_idx"
  ON "resupply"."insurance_claims" ("patient_id", "date_of_service" DESC);
--> statement-breakpoint

-- The CSR queue defaults to "open claims" — anything not paid /
-- closed. Index on (status, updated_at desc) supports that scan.
CREATE INDEX IF NOT EXISTS "insurance_claims_open_idx"
  ON "resupply"."insurance_claims" ("status", "updated_at" DESC)
  WHERE "status" NOT IN ('paid', 'closed');
--> statement-breakpoint

-- Payer-side claim_number lookups (when an EOB lands and we need to
-- match it to our row).
CREATE INDEX IF NOT EXISTS "insurance_claims_claim_number_idx"
  ON "resupply"."insurance_claims" ("claim_number")
  WHERE "claim_number" IS NOT NULL;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 2. insurance_claim_line_items — per-HCPCS detail.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."insurance_claim_line_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "claim_id" uuid NOT NULL
    REFERENCES "resupply"."insurance_claims"("id") ON DELETE CASCADE,
  -- Same HCPCS shape used in prior_authorizations + prescriptions.
  "hcpcs_code" varchar(12) NOT NULL,
  -- Modifier codes are 2-char alphanumeric (e.g. RR, NU, KX). The
  -- payer may require multiple — comma-joined here, parsed by the
  -- claim builder.
  "modifier" varchar(32),
  "description" varchar(240),
  "quantity" integer NOT NULL DEFAULT 1,
  "billed_cents" bigint NOT NULL DEFAULT 0,
  "allowed_cents" bigint NOT NULL DEFAULT 0,
  "paid_cents" bigint NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'pending',
  "denial_reason" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "insurance_claim_line_items_status_enum"
    CHECK ("status" IN ('pending', 'accepted', 'denied', 'paid')),
  CONSTRAINT "insurance_claim_line_items_amounts_nonneg"
    CHECK (
      "quantity" > 0
      AND "billed_cents" >= 0
      AND "allowed_cents" >= 0
      AND "paid_cents" >= 0
    )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "insurance_claim_line_items_claim_idx"
  ON "resupply"."insurance_claim_line_items" ("claim_id");
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 3. insurance_claim_events — append-only history.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."insurance_claim_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "claim_id" uuid NOT NULL
    REFERENCES "resupply"."insurance_claims"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  -- Amount associated with the event (paid amount on a 'paid' event,
  -- denied amount on a 'denied' event, etc.). NULL when the event is
  -- a state-only transition or a free-form note.
  "amount_cents" bigint,
  -- Payer-supplied reference (check number, EOB id, etc.). Free-form
  -- so we don't lose data when a payer's format changes.
  "payer_ref" varchar(120),
  -- Optional link to a patient_documents row (EOB PDF, appeal letter).
  -- ON DELETE SET NULL so a document retention sweep doesn't break
  -- the event history.
  "document_id" uuid
    REFERENCES "resupply"."patient_documents"("id") ON DELETE SET NULL,
  "note" text,
  -- The actor — CSR email or 'system:cron:<job>' for automated events.
  -- Mirrors the audit_log convention; we don't FK to admin_users so
  -- automated actors and ex-employees retain a stable label.
  "actor_email" varchar(180) NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "insurance_claim_events_event_type_enum"
    CHECK ("event_type" IN (
      'submitted', 'accepted', 'denied',
      'partial_pay', 'paid', 'appealed',
      'closed', 'note'
    )),
  CONSTRAINT "insurance_claim_events_amount_nonneg"
    CHECK ("amount_cents" IS NULL OR "amount_cents" >= 0)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "insurance_claim_events_claim_idx"
  ON "resupply"."insurance_claim_events" ("claim_id", "occurred_at" DESC);
