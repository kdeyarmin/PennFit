-- 0215_billing_auto_submit_flag — feature flag that gates UNATTENDED
-- auto-submission of submission-ready claims to Office Ally.
--
-- Background
-- ----------
-- Claims are submitted to Office Ally today only when an operator
-- explicitly clicks "batch submit" (routes/admin/billing-batch-submit.ts)
-- or resubmits a failed batch. The auto-workflow engine
-- (lib/billing/auto-workflow-engine.ts) already scores + AI-scrubs draft
-- claims and analyses denials, but it stops short of SENDING the clean,
-- ready ones — a human still has to push every batch.
--
-- The new auto-submit engine (lib/billing/auto-submit-engine.ts) closes
-- that loop: it selects draft claims that pass preflight with zero
-- blocking errors AND whose coverage shows ACTIVE eligibility on a recent
-- 270/271, batches them per payer, and submits them via the same
-- executeOfficeAllyBatchSubmit core. It runs in two modes:
--
--   1. Staged approval (always available) — the operator previews the
--      "ready to submit" worklist and one-click approves a batch. Gated
--      only by the admin.tools.manage permission.
--
--   2. Unattended cron (opt-in) — the billing.auto-submit-batch worker
--      job. SAFETY: like the eligibility re-verify batch, the recurring
--      schedule attaches only when CLAIMS_AUTOSUBMIT_CRON is set. On top
--      of that, this feature flag is the RUNTIME kill switch the cron
--      checks before sending: even with the cron scheduled, nothing is
--      transmitted until an operator flips this flag ON from the admin
--      Control Center. The staged-approval path ignores the flag (an
--      operator clicking submit is an explicit, attended action).
--
-- SEEDED DISABLED: sending claims means billing real money against real
-- payers, so a credentialed deploy must never start auto-transmitting
-- until the owner deliberately turns it on. Two deliberate steps are
-- required to enable full automation — set the env cron AND flip this
-- flag — matching the repo's "no auto clearinghouse traffic by default"
-- posture (see ELIGIBILITY_REVERIFY_CRON, migration 0185).
--
-- Per ADR 003 — versioned hand-authored migration.

INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('billing.auto_submit_claims',
   false,
   'Unattended auto-submission of submission-ready claims to Office Ally by the billing.auto-submit-batch worker. When ON (and CLAIMS_AUTOSUBMIT_CRON is set) the cron batches draft claims that pass preflight with no blocking errors AND have active eligibility on file, then transmits them per payer. When OFF, the cron is a no-op; the operator-driven staged-approval submit (Billing → Auto-submit) still works regardless. SEEDED DISABLED.',
   'Billing')
ON CONFLICT (key) DO NOTHING;
