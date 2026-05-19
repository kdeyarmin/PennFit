-- 0136_phase_4_pas_endpoints — small schema deltas for Phase 4.
--
--   1. ALTER payer_profiles: add davinci_pas_endpoint_url so the
--      PAS client knows where to POST for each payer that has
--      stood up a Da Vinci PAS server. CMS-0057-F requires payers
--      to implement this; the URL is per-payer + sometimes
--      per-LOB (commercial vs Medicaid MCO).
--   2. ALTER davinci_pas_submissions: + a `request_bundle_json`
--      jsonb column so the admin UI can show "here's the FHIR
--      Bundle we sent the payer" without the bytes living
--      separately. Same posture as Office Ally submissions — we
--      don't persist the raw EDI; we DO persist the parsed
--      structure.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "davinci_pas_endpoint_url" text;
--> statement-breakpoint

ALTER TABLE "resupply"."davinci_pas_submissions"
  ADD COLUMN IF NOT EXISTS "request_bundle_json" jsonb;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "payer_profiles_pas_enabled_idx"
  ON "resupply"."payer_profiles" ("id")
  WHERE "davinci_pas_endpoint_url" IS NOT NULL;
