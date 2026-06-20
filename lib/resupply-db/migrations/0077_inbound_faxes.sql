-- inbound_faxes — durable record of every fax our Twilio number
-- receives, plus a CSR triage state machine. See
-- lib/resupply-db/src/schema/inbound-faxes.ts for the full
-- rationale, PHI posture, and status state machine.
--
-- Replaces the bare audit-only /fax/inbound webhook with a proper
-- triage workflow. The webhook now persists a row + downloads the
-- fax bytes to GCS so the CSR can pull up the PDF after Twilio's
-- ~365-day media retention has lapsed.
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+. Forward-
-- deploy-safe via IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "resupply"."inbound_faxes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "twilio_fax_sid" varchar(64) NOT NULL,
  "from_e164" varchar(16),
  "to_e164" varchar(16),
  "received_at" timestamp with time zone NOT NULL DEFAULT now(),
  "num_pages" integer,
  "media_object_key" text,
  "media_content_type" varchar(120),
  "media_size_bytes" integer,
  "status" text NOT NULL DEFAULT 'new',
  "attached_patient_id" uuid REFERENCES "resupply"."patients"("id") ON DELETE SET NULL,
  "attached_provider_id" uuid REFERENCES "resupply"."providers"("id") ON DELETE SET NULL,
  "attached_prescription_id" uuid REFERENCES "resupply"."prescriptions"("id") ON DELETE SET NULL,
  "attached_document_type" varchar(64),
  "assigned_admin_user_id" uuid,
  "triaged_at" timestamp with time zone,
  "triaged_by_user_id" uuid,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "inbound_faxes_status_enum"
    CHECK ("status" IN ('new', 'triaged', 'attached', 'archived')),
  CONSTRAINT "inbound_faxes_pages_non_negative"
    CHECK ("num_pages" IS NULL OR "num_pages" >= 0),
  CONSTRAINT "inbound_faxes_size_non_negative"
    CHECK ("media_size_bytes" IS NULL OR "media_size_bytes" >= 0)
);

-- Idempotency / dedupe key: Twilio retries on non-2xx, and we want
-- every retry of the same FaxSid to be a no-op upsert.
CREATE UNIQUE INDEX IF NOT EXISTS "inbound_faxes_twilio_fax_sid_unique"
  ON "resupply"."inbound_faxes" ("twilio_fax_sid");

-- Triage queue lookup: status='new' ORDER BY received_at ASC, plus
-- the patient-detail surface that filters status='attached' by
-- attached_patient_id.
CREATE INDEX IF NOT EXISTS "inbound_faxes_status_received_at_idx"
  ON "resupply"."inbound_faxes" ("status", "received_at");

CREATE INDEX IF NOT EXISTS "inbound_faxes_attached_patient_idx"
  ON "resupply"."inbound_faxes" ("attached_patient_id");
