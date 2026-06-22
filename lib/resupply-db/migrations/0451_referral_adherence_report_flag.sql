-- 0451_referral_adherence_report_flag — Control Center toggle for the
-- automated 90-day adherence-report disclosure to a patient's REFERRING
-- PROVIDER (Referral CRM Phase 3 / Provider RTM Phase 3).
--
-- WHAT THIS GATES
-- ---------------
-- When ENABLED for a tenant, a recurring worker (referrals.adherence-report,
-- itself additionally gated by the REFERRAL_ADHERENCE_REPORT_CRON env var)
-- finds patients at their ~90-day therapy mark whose referring provider has
-- a fax (preferred) or email on file, renders the SAME Medicare LCD L33718
-- adherence attestation a CSR can download by hand, and sends it to that
-- referring provider via the tenant's own fax/email sender — recording the
-- send so each patient's 90-day report is delivered at most once.
--
-- WHY OFF BY DEFAULT (read carefully — this is a PHI disclosure)
-- -------------------------------------------------------------
-- The attestation is PROTECTED HEALTH INFORMATION (a therapy-adherence
-- summary). Sending it to the referring provider is a *permitted*
-- treatment / care-coordination disclosure under HIPAA — but WHETHER to
-- make that disclosure, and to whom, is a posture the practice owner must
-- choose deliberately. So this flag is seeded DISABLED per-tenant, exactly
-- like the other intrusive, regulated, owner-opt-in automations
-- (reminder_escalation.voice / 0395, email.auto_reply / 0250). A tenant
-- owner turns it on from Control Center once they have decided the
-- disclosure is appropriate for their relationships and their providers'
-- fax/email are authenticated for delivery. When OFF, the worker is a
-- complete no-op for that tenant — nothing is ever sent.
--
-- feature_flags is PER-TENANT since migration 0350 (PK re-keyed from (key)
-- to (org_id, key)), so seed one row per organization and conflict on
-- (org_id, key). ON CONFLICT DO NOTHING keeps re-runs idempotent and never
-- clobbers an admin's intentional toggle.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.
-- Keep in sync with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts.

INSERT INTO resupply.feature_flags ("org_id", "key", "enabled", "description", "category")
SELECT o."id", v."key", v."enabled", v."description", v."category"
FROM "resupply"."organizations" o
CROSS JOIN (VALUES
  ('referrals.adherence_report',
   false,
   'Automatically send a patient''s 90-day CPAP adherence attestation (Medicare LCD L33718) to their REFERRING PROVIDER, by fax (preferred) or email, once the patient reaches the 90-day therapy mark. This is a PHI disclosure to the treating/referring provider — a permitted treatment/care-coordination disclosure that you opt into deliberately. Seeded OFF: turn it on only once you have decided the disclosure is appropriate and your providers'' fax/email is set up to receive it. Each patient''s 90-day report is sent at most once. When OFF, nothing is sent.',
   'Referrals')
) AS v("key", "enabled", "description", "category")
ON CONFLICT ("org_id", "key") DO NOTHING;
