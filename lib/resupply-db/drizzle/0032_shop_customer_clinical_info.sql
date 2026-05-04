-- 0032_shop_customer_clinical_info — let signed-in shop customers
-- store their CPAP device and prescribing-physician information on
-- their account profile.
--
-- Why these columns exist:
--   * CPAP supplies (cushions, filters, tubing, headgear) are
--     model-specific. A shopper who has saved their device on file
--     no longer has to remember the part-number every time they
--     reorder; the cart can pre-filter compatible SKUs and the CSR
--     can answer "what does this customer's machine take" without
--     a phone call.
--   * A captured prescribing-physician record is the first step
--     toward in-house prescription verification (today the customer
--     re-keys it on every insurance order — error-prone and
--     unfriendly to elderly patients).
--   * Both objects are stored as JSONB so the field set can evolve
--     (add a "humidifier" toggle, add an "NPI" code) without a
--     migration. Same pattern the table already uses for
--     `shipping_address_json` and `communication_preferences`.
--
-- PHI handling:
--   The physician record is PHI when bound to a patient identity.
--   This is the first PHI on `shop_customers` — historically the
--   table held commerce data only (audit policy excluded it from
--   `resupply.audit_log` writes). Routes that mutate these new
--   columns DO write to `resupply.audit_log` with a non-PHI
--   metadata envelope (action verb + which fields changed +
--   length crumbs only) — see
--   `artifacts/resupply-api/src/routes/shop/clinical-info.ts`.
--
--   We deliberately do NOT add a `device_serial_number` column or
--   any other free-text identifier; serial number lives inside the
--   `cpap_device_json` blob alongside the model so it's all PHI
--   and is sanitized through the same single read path.

ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "cpap_device_json" jsonb;
--> statement-breakpoint
ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "physician_info_json" jsonb;
