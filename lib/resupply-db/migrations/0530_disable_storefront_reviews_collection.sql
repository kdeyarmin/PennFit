-- 0530: Disable storefront.reviews_collection (insurance-only cleanup).
--
-- The review-request dispatcher still emails historical shop_orders and
-- the CTA lands on /contact ("Leave a review" with no review form). With
-- cash-pay checkout retired there is no patient review surface; leave the
-- flag OFF so Launch+ presets and Control Center "apply recommended"
-- cannot re-arm it (see DELIBERATELY_OFF_FLAGS).
--
-- Idempotent: UPDATE … WHERE key = ….

UPDATE "resupply"."feature_flags"
SET
  "enabled" = false,
  "updated_at" = NOW()
WHERE "key" = 'storefront.reviews_collection';
