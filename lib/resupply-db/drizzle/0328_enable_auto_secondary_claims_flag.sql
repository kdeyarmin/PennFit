-- 0328_enable_auto_secondary_claims_flag — turn ON automatic secondary /
-- COB claim drafting.
--
-- Migration 0324 added `billing.auto_secondary_claims` seeded OFF. The
-- auto-pass (lib/billing/auto-workflow-engine.ts:runSecondaryClaimPass)
-- is fully implemented: when a PAID primary carries a secondary coverage
-- and left a patient-responsibility balance and hasn't yet spawned a
-- secondary, it DRAFTS the secondary / COB claim (status 'draft') on the
-- 5-minute auto-workflow cycle — identical to the manual biller action.
-- Nothing is ever auto-SUBMITTED; a biller still reviews + submits the
-- draft through the normal batch path.
--
-- Enabling per business-owner sign-off (billing recommendation #4). Uses
-- ON CONFLICT DO UPDATE so it flips correctly on both a populated prod DB
-- and a fresh replay; runs once, so a later Control Center toggle is not
-- re-clobbered.
--
-- Keep in sync with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts.
--
-- Per ADR 003 — versioned hand-authored migration.

INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES (
  'billing.auto_secondary_claims',
  true,
  'Auto-draft a secondary / coordination-of-benefits claim when a primary payer pays a claim that carries a secondary coverage and leaves a patient-responsibility balance. The secondary lands in draft for a biller to review and submit — never auto-submitted. Off by default; when off, use the manual COB worklist at /admin/billing/secondary-eligible.',
  'Billing'
)
ON CONFLICT (key) DO UPDATE SET enabled = true, updated_at = now();
