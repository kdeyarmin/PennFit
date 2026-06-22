-- 0433_billing_auto_submit_prior_auths_flag — Control Center toggle for the
-- UNATTENDED automatic Da Vinci PAS submission of draft prior authorizations.
--
-- Background
-- ----------
-- Da Vinci PAS prior-auth submission today happens only when an operator
-- clicks "Submit" on a PA (routes/admin/davinci-pas-submit.ts). PA-required
-- items therefore wait on a human, and a forgotten PA becomes a denial. The
-- submit core was extracted to lib/billing/submit-prior-auth.ts so a worker
-- can reuse the exact same build/SSRF-pin/identifier-binding path.
--
-- The new prior-auth-auto-submit worker job (worker/jobs/prior-auth-auto-submit.ts)
-- closes that loop: it selects DRAFT prior_authorizations that already carry an
-- insurance_coverage_id and front-loads them through submitPriorAuth(). Every
-- other precondition (diagnosis on file, payer PAS endpoint, credentials,
-- address) is validated inside the helper, which returns a no-op result —
-- inserting nothing and calling no payer — when a PA isn't ready, so a draft
-- that can't yet be submitted is simply skipped and retried next tick.
--
-- SAFETY — two independent off switches, both required to transmit, mirroring
-- billing.auto_submit_claims (migration 0215):
--
--   1. OPT-IN CRON. The queue + worker always register, but the recurring
--      schedule attaches only when PRIOR_AUTH_AUTOSUBMIT_CRON is set. Dev /
--      preview / a fresh prod never auto-submit PAs.
--
--   2. RUNTIME FEATURE FLAG. Even with the cron scheduled, the job checks this
--      flag on every tick and no-ops when it's off — a one-click kill switch in
--      the admin Control Center that takes effect without a deploy. The
--      operator-driven manual submit ignores the flag (an attended action).
--
-- SEEDED DISABLED: a PAS submission transmits PHI to a real payer endpoint
-- under a per-payer Bearer token, so a credentialed deploy must never start
-- auto-submitting until the owner deliberately turns it on.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent. Keep in sync
-- with FEATURE_FLAG_KEYS in artifacts/resupply-api/src/lib/feature-flags.ts.
--
-- feature_flags is PER-TENANT since migration 0350 (PK re-keyed from (key) to
-- (org_id, key)), so seed one row per organization and conflict on
-- (org_id, key) — a bare ON CONFLICT (key) no longer matches a constraint.

INSERT INTO resupply.feature_flags ("org_id", "key", "enabled", "description", "category")
SELECT o."id", v."key", v."enabled", v."description", v."category"
FROM "resupply"."organizations" o
CROSS JOIN (VALUES
  ('billing.auto_submit_prior_auths', false, 'Unattended automatic Da Vinci PAS submission of draft prior authorizations by the billing.prior-auth-auto-submit worker. When ON (and PRIOR_AUTH_AUTOSUBMIT_CRON is set) the cron front-loads draft PAs that carry a coverage through the same submit core as the manual button; PAs missing a diagnosis, payer PAS endpoint, credentials, or address are skipped and retried. When OFF, the cron is a no-op; the operator-driven manual submit still works regardless. SEEDED DISABLED.', 'Billing')
) AS v("key", "enabled", "description", "category")
ON CONFLICT ("org_id", "key") DO NOTHING;
