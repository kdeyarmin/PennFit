-- Remove the inbound DME-order referral subsystem (Parachute + EHR-FHIR).
--
-- The Parachute and EHR-FHIR inbound integrations and the shared
-- inbound-referral pipeline that served them have been removed end to
-- end: the vendor packages, the /integrations/inbound webhook route and
-- the /fhir/r4/ServiceRequest intake, the per-source dispatchers, the
-- inbound-referral worker jobs (webhook-dispatch, preflight,
-- status-outbound), the admin triage UI, and the clinician share-token
-- portal. This migration drops the tables they owned.
--
-- The only foreign keys into these tables come from OTHER tables in the
-- same subsystem (e.g. inbound_referral_documents -> inbound_referral_orders,
-- fhir_jwt_jti_replay_store -> ehr_fhir_tenants); no retained table
-- references any of them (verified against the migration history). The
-- drops are therefore ordered dependents-first and use CASCADE so the
-- intra-subsystem foreign keys are torn down with their tables regardless
-- of ordering. CASCADE here cannot reach a retained object.
--
-- Intentionally left in place (NOT part of this subsystem):
--   * the read-only FHIR R4 patient surface (GET /fhir/r4/*, Cures Act);
--   * the inbound_faxes table (a separate inbound channel).

DROP TABLE IF EXISTS "resupply"."inbound_referral_status_outbox" CASCADE;
DROP TABLE IF EXISTS "resupply"."inbound_referral_preflight_checks" CASCADE;
DROP TABLE IF EXISTS "resupply"."inbound_referral_documents" CASCADE;
DROP TABLE IF EXISTS "resupply"."clinician_share_tokens" CASCADE;
DROP TABLE IF EXISTS "resupply"."inbound_referral_orders" CASCADE;
DROP TABLE IF EXISTS "resupply"."fhir_jwt_jti_replay_store" CASCADE;
DROP TABLE IF EXISTS "resupply"."ehr_fhir_tenants" CASCADE;
DROP TABLE IF EXISTS "resupply"."inbound_webhooks" CASCADE;
