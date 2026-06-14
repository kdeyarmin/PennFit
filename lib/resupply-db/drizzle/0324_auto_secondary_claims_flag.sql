-- 0324_auto_secondary_claims_flag — feature flag for auto-drafting
-- secondary / COB claims.
--
-- The auto-workflow engine (lib/billing/auto-workflow-engine.ts) already
-- runs every 5 minutes to scrub risky drafts, analyze fresh denials, and
-- generate patient statements. This flag adds a fourth pass: when a PAID
-- primary claim carries a secondary coverage AND left a patient-
-- responsibility balance AND hasn't yet spawned a secondary, draft the
-- secondary / COB claim automatically (same path as the manual biller
-- action POST /admin/claims/:id/generate-secondary). The drafted claim
-- lands in 'draft' status — a biller reviews + submits through the normal
-- batch path; nothing is auto-SUBMITTED.
--
-- Seeded OFF: auto-creating claims is a billing action, so it is opt-in.
-- When disabled, the biller continues to work the manual COB worklist at
-- /admin/billing/secondary-eligible. Fail-soft: the pass no-ops when the
-- flag is unset or disabled.
--
-- Keep in sync with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts.
--
-- Per ADR 003 — versioned hand-authored migration.

INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES (
  'billing.auto_secondary_claims',
  false,
  'Auto-draft a secondary / coordination-of-benefits claim when a primary payer pays a claim that carries a secondary coverage and leaves a patient-responsibility balance. The secondary lands in draft for a biller to review and submit — never auto-submitted. Off by default; when off, use the manual COB worklist at /admin/billing/secondary-eligible.',
  'Billing'
)
ON CONFLICT (key) DO NOTHING;
