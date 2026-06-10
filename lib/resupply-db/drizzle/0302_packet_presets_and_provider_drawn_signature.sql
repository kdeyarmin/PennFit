-- Packet bundle presets + provider portal drawn signature.
--
-- 1. patient_packet_presets — named, operator-managed bundles of e-sign
--    packet documents (e.g. "Medicare new patient" vs "Commercial new
--    patient"). A preset is a convenience for the send panel: choosing
--    one selects its document set (and optionally a packet title). The
--    send path still folds in every compliance-required document and
--    validates keys, so a stale preset can never produce an incomplete
--    or invalid packet.
--
-- 2. provider_signature_requests.signature_image — optional drawn
--    signature (PNG data URL) captured in the provider portal alongside
--    the typed name + ESIGN consent. Typed name + consent remains the
--    legally sufficient capture; the drawn image is supplementary for
--    payers that prefer a wet-look signature. Stored inline like
--    patient_packet_signatures.signature_image and NEVER logged.

CREATE TABLE IF NOT EXISTS "resupply"."patient_packet_presets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text,
  -- Stable template keys, in catalog order (re-validated at use time).
  "document_keys" text[] NOT NULL,
  -- Optional packet title the preset applies (e.g. "Medicare New
  -- Patient Packet"); NULL keeps the default.
  "packet_title" text,
  "created_by_email" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness so "Medicare" and "medicare" can't coexist.
CREATE UNIQUE INDEX IF NOT EXISTS "patient_packet_presets_name_idx"
  ON "resupply"."patient_packet_presets" (lower("name"));

ALTER TABLE "resupply"."provider_signature_requests"
  ADD COLUMN IF NOT EXISTS "signature_image" text;
