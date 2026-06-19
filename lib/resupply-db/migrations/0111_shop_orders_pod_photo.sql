-- Proof-of-Delivery photo for a shop_orders row. CSR or carrier
-- uploads a photo of the parcel at the doorstep; the image bytes
-- live in App Storage (GCS) and we keep only the object key here.
-- Required for accreditation surveyors who ask for POD evidence on
-- audit, and for resolving "I never got it" claims.

ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "pod_object_key" text;

ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "pod_uploaded_at" timestamp with time zone;

ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "pod_signed_name" varchar(160);
