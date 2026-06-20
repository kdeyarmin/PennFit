-- shop_customers.facial_measurements_json — the customer's most-recent
-- on-device facial measurements (alar/nostril span, nose-to-chin,
-- mouth width, face width at cheekbones, calibration method).
--
-- Why on shop_customers and not just on the order payload:
--   * The /account page wants to show the patient "your saved
--     measurements" without making them dig through old orders.
--   * The admin Customer 360 (CSR) wants to see the latest sizing
--     on the profile, not just on each individual order detail.
--   * Re-running the fitter overwrites the saved values; the
--     historical snapshot is still on each order row's payload jsonb.
--
-- Stored as JSONB so we can evolve the field set (per-nostril
-- diameter, etc.) without another migration. Application boundary
-- enforces the FacialMeasurements zod shape.
--
-- PHI posture: numeric face dimensions in mm. Not directly
-- identifying on their own but bound to the customer; same handling
-- as cpap_device_json / physician_info_json (no log emission, no
-- response logging). The writer audits with a non-PHI envelope
-- (which top-level fields, calibration method).

ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "facial_measurements_json" jsonb;
