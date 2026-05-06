-- physician_fax_outreach — record of CPAP-Rx fax requests sent to
-- the patient's prescribing physician (Phase G.6 — Phase B.2
-- follow-up / feature #7 deferred half).
--
-- The single biggest reorder-blocker is an expired prescription
-- with no patient action. The Rx-renewal dispatcher (Phase B.2)
-- nudges the PATIENT; this table tracks the parallel path of
-- contacting the PRESCRIBER directly. CSRs can fire one off when
-- a patient writes back "please just talk to my doctor" or when
-- the email/SMS dispatcher has gone unanswered for 7 days.
--
-- Lifecycle:
--   * pending   — row created, no provider call attempted yet
--   * sent      — fax provider accepted the dispatch
--   * delivered — fax provider confirmed delivery (callback)
--   * failed    — fax provider rejected or callback returned error
--
-- We deliberately keep the data shape provider-agnostic. The fax
-- vendor space is fragmented (Documo, Phaxio, eFax, SRFax, etc.)
-- and the production deploy may swap vendors over the lifetime
-- of this feature. `vendor_ref` is the opaque vendor-side message
-- id; the rest of the row carries our own bookkeeping.
--
-- PHI:
--   * physician_fax_e164 / physician_name are PHI when bound to
--     the patient. Stored at-rest with no special encryption (per
--     migration 0025 which removed pgcrypto column-level encryption);
--     access is gated by Row-Level Security at the API layer (only
--     the audit-logged admin/agent who touches the row sees it).
--   * cover_letter_text is the rendered fax body. Audit-logged at
--     length only (Rule 8 — never log message bodies plain).
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."physician_fax_outreach" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "prescription_id" uuid REFERENCES "resupply"."prescriptions"("id") ON DELETE SET NULL,
  "physician_name" text NOT NULL,
  -- E.164 format. Validated at the API layer.
  "physician_fax_e164" text NOT NULL,
  -- Rendered cover letter / Rx-request body. Stored verbatim so
  -- the CSR can re-render exactly what we faxed when the patient
  -- calls in to ask "what did you send my doctor?".
  "cover_letter_text" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  -- Vendor-side message id, populated when status moves to 'sent'.
  -- Opaque string — provider-specific format (Documo uses uuid,
  -- Phaxio uses int, etc.). No business logic depends on shape.
  "vendor_ref" text,
  -- Vendor we used for this dispatch. Helps if we swap providers:
  -- the new provider's status callbacks will only match rows
  -- stamped with their vendor name.
  "vendor_name" text,
  "sent_at" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "failure_reason" text,
  "created_by_email" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "physician_fax_outreach_status_enum"
    CHECK ("status" IN ('pending','sent','delivered','failed'))
);

-- Per-patient lookup index for the "what fax outreach has happened
-- on this patient?" CSR view in the patient-detail tab.
CREATE INDEX IF NOT EXISTS "physician_fax_outreach_patient_idx"
  ON "resupply"."physician_fax_outreach" ("patient_id", "created_at" DESC);

-- Vendor-callback lookup: when the fax provider POSTs a status
-- update, it cites our vendor_ref. This index keeps the lookup O(1)
-- against the table.
CREATE INDEX IF NOT EXISTS "physician_fax_outreach_vendor_ref_idx"
  ON "resupply"."physician_fax_outreach" ("vendor_ref")
  WHERE "vendor_ref" IS NOT NULL;
