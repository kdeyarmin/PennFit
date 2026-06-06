-- Patient signature packets — electronic new-patient document packets.
--
-- A "packet" is a bundle of standard onboarding documents (welcome &
-- equipment instructions, assignment of benefits, notice of privacy
-- practices, patient rights, financial responsibility, Medicare DMEPOS
-- supplier standards, consent to care, proof of delivery) that a new
-- customer reviews and signs electronically from a single short-lived
-- signed link (RESUPPLY_LINK_HMAC_KEY). The signing ceremony captures
-- one ESIGN/UETA-grade signature applied to every included document,
-- plus per-document acknowledgement.
--
-- Three tables:
--   patient_packets            — the signing envelope sent to a patient
--   patient_packet_documents   — the individual documents in the packet
--                                (content version snapshot + ack state)
--   patient_packet_signatures  — the captured signature event(s) with
--                                the ESIGN consent + IP/UA audit trail
--
-- The signature image is stored inline as a PNG data URL on the
-- signature row (it IS the signed artifact, small, and never logged).
-- The rendered, signed PDF is generated on demand from this data.

CREATE TABLE IF NOT EXISTS "resupply"."patient_packets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  -- draft | sent | viewed | completed | voided | expired
  "status" text NOT NULL DEFAULT 'sent',
  -- Snapshot of the recipient identity at send time (the patient row
  -- can change later; the packet records who it was sent to).
  "recipient_name" text NOT NULL,
  "recipient_email" text,
  -- Bumped to invalidate any in-flight signing link (revocation).
  "link_version" integer NOT NULL DEFAULT 1,
  "expires_at" timestamptz,
  "sent_at" timestamptz,
  "first_viewed_at" timestamptz,
  "completed_at" timestamptz,
  "voided_at" timestamptz,
  "voided_reason" text,
  "created_by_email" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "patient_packets_patient_idx"
  ON "resupply"."patient_packets" ("patient_id");
CREATE INDEX IF NOT EXISTS "patient_packets_status_idx"
  ON "resupply"."patient_packets" ("status");
CREATE INDEX IF NOT EXISTS "patient_packets_created_at_idx"
  ON "resupply"."patient_packets" ("created_at" DESC);

CREATE TABLE IF NOT EXISTS "resupply"."patient_packet_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "packet_id" uuid NOT NULL
    REFERENCES "resupply"."patient_packets"("id") ON DELETE CASCADE,
  -- Stable template key, e.g. 'assignment_of_benefits'.
  "document_key" text NOT NULL,
  -- Snapshot of the document title + content version at send time, so a
  -- later template edit never rewrites what the patient actually signed.
  "title" text NOT NULL,
  "content_version" text NOT NULL,
  "sort_order" integer NOT NULL DEFAULT 0,
  "requires_signature" boolean NOT NULL DEFAULT true,
  "acknowledged" boolean NOT NULL DEFAULT false,
  "acknowledged_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("packet_id", "document_key")
);

CREATE INDEX IF NOT EXISTS "patient_packet_documents_packet_idx"
  ON "resupply"."patient_packet_documents" ("packet_id");

CREATE TABLE IF NOT EXISTS "resupply"."patient_packet_signatures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "packet_id" uuid NOT NULL
    REFERENCES "resupply"."patient_packets"("id") ON DELETE CASCADE,
  -- Typed legal name as entered by the signer.
  "signer_name" text NOT NULL,
  -- self | spouse | guardian | power_of_attorney | caregiver | other
  "signer_relationship" text NOT NULL DEFAULT 'self',
  -- Drawn signature, stored inline as an image data URL (PNG). Optional:
  -- a typed-name + ESIGN consent is a valid signature on its own.
  "signature_image" text,
  -- ESIGN/UETA affirmative consent to do business electronically.
  "consent_esign" boolean NOT NULL DEFAULT false,
  "acknowledged_document_keys" text[] NOT NULL DEFAULT '{}',
  "signed_at" timestamptz NOT NULL DEFAULT now(),
  "signer_ip" text,
  "signer_user_agent" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "patient_packet_signatures_packet_idx"
  ON "resupply"."patient_packet_signatures" ("packet_id");
