-- 0240_billing_eligibility_precheck_flag — feature flag for the
-- claim-submit eligibility precheck.
--
-- Sibling to 0185 (`resupply.eligibility_enforcement`, the order-confirm
-- coverage guard). That guard runs when a patient confirms a resupply;
-- this one runs at the OTHER insurance decision point — when a CSR
-- batch-submits 837P claims to Office Ally
-- (executeOfficeAllyBatchSubmit). When ON, each claim's coverage is
-- checked against the most recent parsed 270/271; a claim whose coverage
-- is explicitly inactive or flags prior-auth-required is held back and
-- the batch returns `eligibility_blocked` with the offending claim ids,
-- so the CSR can re-run eligibility / fix coverage instead of submitting
-- a claim that will deny.
--
-- SEEDED DISABLED, same rationale as 0185: the precheck is only useful
-- once 270s are being run for the population, and the shared decision is
-- FAIL-OPEN by construction (a missing/stale result, or any lookup
-- error, allows the claim through). Production starts OFF and ops flips
-- it on from the Control Center once eligibility data is flowing.

INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('billing.eligibility_precheck',
   false,
   'Before batch-submitting 837P claims to Office Ally, consult each claim''s most recent parsed 270/271. A claim whose coverage is explicitly inactive or requires prior auth is held back and the batch returns eligibility_blocked with the offending claim ids. Fail-open: no/stale eligibility result allows the claim through. Pairs with resupply.eligibility_enforcement (the order-confirm coverage guard).',
   'Billing')
ON CONFLICT (key) DO NOTHING;
