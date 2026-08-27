-- 0528: Force-disable retired patient cash-pay feature flags.
--
-- Migration 0527 rewrote descriptions to "RETIRED — leave OFF" but left
-- `enabled = true` from the original seeds. Control Center then showed
-- ON + retired copy. Flip the switches off so operators cannot leave a
-- retired patient-charge path armed.
--
-- Idempotent: UPDATE … WHERE key IN (…).

UPDATE "resupply"."feature_flags"
SET
  "enabled" = false,
  "updated_at" = NOW()
WHERE "key" IN (
  'storefront.checkout',
  'billing.patient_autopay',
  'cart_abandonment.dispatcher'
);
