-- 0241_billing_eligibility_precheck_refresh_flag — opt-in: let the
-- claim-submit eligibility precheck run a FRESH real-time 270 when a
-- coverage has no recent parsed 271.
--
-- Companion to 0240 (`billing.eligibility_precheck`, the consult-only
-- gate). With that flag ON, the precheck consults the cached 270/271 and
-- holds the batch on an explicit negative. With THIS flag ALSO on — and
-- only when real-time eligibility is configured — the precheck additionally
-- runs a fresh real-time 270 for any coverage in the batch that has no
-- recent result, so an unverified coverage is actually checked instead of
-- silently failing open.
--
-- SEEDED DISABLED and bounded: each batch runs at most a small, fixed
-- number of fresh real-time checks (deduped per coverage) so a large batch
-- can't fan out into a slow synchronous request. Auto-firing 270s has a
-- per-transaction cost, which is why this is a SEPARATE opt-in from the
-- cheap consult-only precheck. No real-time config → this flag no-ops.

INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('billing.eligibility_precheck_refresh',
   false,
   'When billing.eligibility_precheck is on AND real-time eligibility is configured, the claim-submit precheck additionally runs a fresh real-time 270 for any coverage in the batch with no recent parsed 271 (deduped per coverage, capped per batch). Off → the precheck only consults cached results. Auto-firing 270s has a per-transaction cost, so this is opt-in separately.',
   'Billing')
ON CONFLICT (key) DO NOTHING;
