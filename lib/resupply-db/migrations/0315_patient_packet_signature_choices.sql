-- 0315: per-document signer choices on patient packet signatures.
--
-- Some e-sign documents require the signer to personally select one
-- option at signing time — the Advance Beneficiary Notice (CMS-R-131)
-- is the canonical case: the beneficiary must pick Option 1, 2, or 3
-- themselves for the notice to be valid. The selection is part of the
-- signed artifact, so it lives on the signature row next to
-- date_received / signer_reason (the other Medicare signing fields).
--
-- Shape: a flat JSON object mapping document_key -> selected option
-- key, e.g. {"abn_medicare": "option_1"}. Only documents whose code
-- template defines a choice get an entry; validation happens in the
-- sign route against the template catalog.
ALTER TABLE "resupply"."patient_packet_signatures"
  ADD COLUMN IF NOT EXISTS "document_choices" jsonb;
