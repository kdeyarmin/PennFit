-- 0527: Retire patient cash-pay wording on feature-flag descriptions.
--
-- Control Center surfaces `feature_flags.description` from the DB. Several
-- seeds still describe patient Stripe Checkout, saved-card autopay, and
-- cash-pay-only module modes after those surfaces were removed. Rewrite
-- in place so operators are not offered a retired patient-charge path.
--
-- Idempotent: UPDATE … WHERE key = ….

UPDATE "resupply"."feature_flags"
SET
  "description" =
    'RETIRED — patient cash-pay checkout was removed. Leave OFF. Patients receive equipment through insurance only; flipping this on does not restore a storefront charge path.',
  "updated_at" = NOW()
WHERE "key" = 'storefront.checkout';

UPDATE "resupply"."feature_flags"
SET
  "description" =
    'RETIRED — patient card-on-file autopay was removed. Leave OFF. Insurance billing does not charge a patient card from the portal.',
  "updated_at" = NOW()
WHERE "key" = 'billing.patient_autopay';

UPDATE "resupply"."feature_flags"
SET
  "description" =
    'RETIRED — abandoned cash-pay cart nudges. Leave OFF. Fit requests and insurance resupply do not use the shop cart funnel.',
  "updated_at" = NOW()
WHERE "key" = 'cart_abandonment.dispatcher';

UPDATE "resupply"."feature_flags"
SET
  "description" =
    'Billing and claims — insurance revenue-cycle dashboards, worklists, A/R, and clearinghouse/ERA tools. OFF hides the Billing group. Patients are insurance-only (not a cash-pay toggle). Your own plan and usage stay under Settings > Plan & billing either way.',
  "updated_at" = NOW()
WHERE "key" = 'module.billing';
