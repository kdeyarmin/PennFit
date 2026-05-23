-- 0156_prescription_request_packets — physician-faxable
-- pre-populated prescriptions.
--
-- Why this exists
-- ---------------
-- The single biggest reorder-blocker is an expired or absent
-- prescription. The existing physician_fax_outreach (0048) sends a
-- free-text cover letter asking the physician to "please send a
-- new Rx." That's friction: the physician has to log into their
-- EHR, locate the patient, type a fresh order, print it, sign it,
-- fax it back.
--
-- This table records a fully-rendered, pre-populated, fillable
-- prescription PDF that the physician can sign as-is and fax
-- back. We pre-fill from the patient's existing therapy data
-- (most recent compliance settings + the supplier's preferred
-- HCPCS line set) so the physician's job is reduced to "verify +
-- sign + fax."
--
-- Lifecycle:
--   draft       — built, not dispatched
--   sent_fax    — Twilio accepted the fax
--   delivered   — Twilio status-callback confirmed delivery
--   signed      — CSR stamped manually when the signed PDF returns
--   expired     — past valid_through with no signed return
--   void        — CSR cancelled before signature
--   failed      — Twilio rejected dispatch
--
-- PHI posture: patient name + DOB + dx + equipment lines are PHI.
-- Stored at-rest; access gated by `requirePermission("patients.update")`.
-- The rendered PDF is generated on-demand by the public document
-- endpoint (signed HMAC token) — bytes are NOT persisted in this
-- table, matching the cover-letter pattern.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."prescription_request_packets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "provider_id" uuid
    REFERENCES "resupply"."providers"("id") ON DELETE SET NULL,
  -- If this packet was generated FROM an expiring prescription,
  -- link back so we can update the Rx in place on signed return.
  "source_prescription_id" uuid
    REFERENCES "resupply"."prescriptions"("id") ON DELETE SET NULL,

  -- Equipment lines the physician is being asked to authorise.
  -- Array of:
  --   { hcpcs: "E0601", description: "...", quantity: 1,
  --     modifiers: ["NU"], cadence_days: 365 }
  -- The renderer iterates this list to produce the printed table.
  "hcpcs_items_json" jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- ICD-10 codes printed in the Dx block.
  "icd10_codes_json" jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- CPAP / BiPAP settings printed in the Settings block.
  --   { device_class: "cpap"|"auto_cpap"|"bipap"|"bipap_st"|"asv",
  --     pressure_cmh2o: 8,             -- fixed CPAP
  --     pressure_min_cmh2o: 6,         -- auto / bipap min
  --     pressure_max_cmh2o: 16,        -- auto / bipap max
  --     ipap_cmh2o: 14,
  --     epap_cmh2o: 8,
  --     ramp_minutes: 30,
  --     ramp_start_cmh2o: 4,
  --     humidifier_setting: 3,
  --     heated_tube: true,
  --     backup_rate_bpm: 10 }
  -- Null when the patient isn't on PAP therapy (mask-only refill).
  "device_settings_json" jsonb,

  -- Length-of-need + signature instructions. Default to standard
  -- CPAP wording; CSR can tailor before send.
  "length_of_need_months" smallint NOT NULL DEFAULT 99,

  -- Where the physician faxes back. Pre-filled from providers.fax_e164;
  -- CSR can override if the patient's clinical fax differs.
  "return_fax_e164" varchar(20),

  -- Optional return email (some practices prefer encrypted email).
  "return_email" varchar(240),

  -- Optional free-text addendum printed above the signature block
  -- ("Patient reports increased congestion — consider humidifier
  -- step up").
  "clinical_notes" text,

  -- Lifecycle.
  "status" text NOT NULL DEFAULT 'draft',
  "valid_through" timestamp with time zone,

  -- Where it was sent + Twilio bookkeeping.
  "sent_to_fax_e164" varchar(20),
  "vendor_ref" text,
  "vendor_name" text,
  "sent_at" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "failure_reason" text,

  -- When the CSR stamps the signed return.
  "signed_at" timestamp with time zone,
  -- Object-storage key for the scanned signed PDF the CSR uploads
  -- on receipt. Null until upload.
  "signed_object_key" text,

  "created_by_email" varchar(180) NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "prescription_request_packets_status_enum"
    CHECK ("status" IN (
      'draft', 'sent_fax', 'delivered', 'signed',
      'expired', 'void', 'failed'
    )),
  CONSTRAINT "prescription_request_packets_lon_range"
    CHECK ("length_of_need_months" >= 1 AND "length_of_need_months" <= 99)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "prescription_request_packets_patient_idx"
  ON "resupply"."prescription_request_packets"
  ("patient_id", "created_at" DESC);
--> statement-breakpoint

-- Open queue: drafts + sent-but-unsigned packets the CSR needs to
-- chase. Partial index keeps it small.
CREATE INDEX IF NOT EXISTS "prescription_request_packets_open_idx"
  ON "resupply"."prescription_request_packets" ("status", "created_at")
  WHERE "status" IN ('draft', 'sent_fax', 'delivered');
--> statement-breakpoint

-- Dedupe: re-firing a draft for the same patient + dispatch isn't
-- prohibited (CSR may legitimately need a fresh packet), but the
-- vendor_ref is UNIQUE when present so a Twilio webhook can find
-- the right row.
CREATE UNIQUE INDEX IF NOT EXISTS "prescription_request_packets_vendor_ref_uq"
  ON "resupply"."prescription_request_packets" ("vendor_ref")
  WHERE "vendor_ref" IS NOT NULL;
