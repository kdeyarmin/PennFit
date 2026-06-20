-- 0248_paperwork_signoff_gate — verification stop: required paperwork
-- must be signed before an order ships (or is picked up).
--
-- Why
-- ---
-- Operators need a hard stop that blocks an order from being marked
-- shipped until the patient has signed the required intake paperwork
-- (HIPAA Notice of Privacy Practices, Assignment of Benefits, Supplier
-- Standards). The same forms the dispense-readiness reviewer already
-- treats as required-before-dispense
-- (lib/billing/dispense-readiness-reviewer.ts) — but enforced as a
-- deterministic gate at the ship transition rather than an advisory
-- review.
--
-- The requirement can be turned on two ways:
--
--   1. GLOBAL — the admin-flippable feature flag
--      `orders.require_signed_paperwork` (seeded OFF below). When ON,
--      every patient-linked order requires signed paperwork before
--      shipment.
--   2. PER-PAYER — `payer_profiles.requires_signed_paperwork` (added
--      below, default false). When a patient's primary coverage maps
--      to a payer profile with this flag set, paperwork is required for
--      that patient's orders even when the global flag is OFF.
--
-- Non-clinical / guest storefront orders (no linked patient record)
-- carry no paperwork requirement — there is nothing to sign — so the
-- gate is a no-op for them regardless of the flags above.
--
-- Per ADR 003 — versioned hand-authored migration.

-- 1. Per-payer requirement toggle.
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "requires_signed_paperwork" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- 2. Global requirement feature flag. Seeded DISABLED — turning this on
--    blocks shipments, so it is an explicit opt-in (unlike the
--    table-wide "default enabled" posture of feature_flags). ON CONFLICT
--    DO NOTHING so a re-run never clobbers an operator's intentional
--    enable. Keep in sync with FEATURE_FLAG_KEYS in
--    artifacts/resupply-api/src/lib/feature-flags.ts.
INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('orders.require_signed_paperwork',
   false,
   'Require required intake paperwork (HIPAA NPP, Assignment of Benefits, Supplier Standards) to be signed before a patient-linked order can be marked shipped. Off by default — turning it on blocks shipment until paperwork is on file. A per-payer requirement (payer_profiles.requires_signed_paperwork) can also impose this for specific payers while this stays off.',
   'Orders')
ON CONFLICT (key) DO NOTHING;
