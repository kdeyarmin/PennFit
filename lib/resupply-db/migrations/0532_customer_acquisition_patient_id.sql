-- 0532 — link customer_acquisition → patients for insurance LTV.
--
-- Channel LTV:CAC historically summed shop_orders only. ERA remittance
-- dollars live on insurance_claims.patient_id with no path into
-- customer_acquisition. Adding nullable patient_id lets attributed
-- customers include claim remittance in lifetime revenue (via the
-- ltv_cac_customer_economics RPC rewrite below) without inventing a
-- soft email join at query time.
--
-- Soft backfill: unambiguous email match and portal-auth match only
-- (exactly one patient per org+email; auth_user_id = portal_auth_user_id).
-- Ambiguous / missing emails stay NULL — staff can set patient_id via
-- PUT /admin/customers/:id/acquisition.
--
-- Idempotent. Per ADR 003.

ALTER TABLE "resupply"."customer_acquisition"
  ADD COLUMN IF NOT EXISTS "patient_id" uuid
  REFERENCES "resupply"."patients"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

-- One acquisition row per linked patient within an org (when set).
CREATE UNIQUE INDEX IF NOT EXISTS "customer_acquisition_org_patient_uidx"
  ON "resupply"."customer_acquisition" ("org_id", "patient_id")
  WHERE "patient_id" IS NOT NULL AND "org_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "customer_acquisition_patient_idx"
  ON "resupply"."customer_acquisition" ("patient_id")
  WHERE "patient_id" IS NOT NULL;
--> statement-breakpoint

-- Soft backfill: portal auth (stronger).
UPDATE "resupply"."customer_acquisition" a
SET "patient_id" = p."id"
FROM "resupply"."shop_customers" c
INNER JOIN "resupply"."patients" p
  ON p."portal_auth_user_id" IS NOT NULL
 AND p."portal_auth_user_id" = c."auth_user_id"
 AND p."org_id" IS NOT DISTINCT FROM c."org_id"
WHERE a."patient_id" IS NULL
  AND a."customer_id" = c."customer_id"
  AND a."org_id" IS NOT DISTINCT FROM c."org_id"
  AND c."auth_user_id" IS NOT NULL;
--> statement-breakpoint

-- Soft backfill: unambiguous email (exactly one patient per org+email).
UPDATE "resupply"."customer_acquisition" a
SET "patient_id" = p."id"
FROM "resupply"."shop_customers" c
INNER JOIN "resupply"."patients" p
  ON p."email" IS NOT NULL
 AND lower(trim(p."email")) = c."email_lower"
 AND p."org_id" IS NOT DISTINCT FROM c."org_id"
WHERE a."patient_id" IS NULL
  AND a."customer_id" = c."customer_id"
  AND a."org_id" IS NOT DISTINCT FROM c."org_id"
  AND c."email_lower" IS NOT NULL
  AND c."email_lower" <> ''
  AND (
    SELECT count(*)::int
    FROM "resupply"."patients" p2
    WHERE p2."email" IS NOT NULL
      AND lower(trim(p2."email")) = c."email_lower"
      AND p2."org_id" IS NOT DISTINCT FROM c."org_id"
  ) = 1
  -- Skip if another acquisition row in this org already claims this patient.
  AND NOT EXISTS (
    SELECT 1
    FROM "resupply"."customer_acquisition" a2
    WHERE a2."patient_id" = p."id"
      AND a2."org_id" IS NOT DISTINCT FROM a."org_id"
      AND a2."customer_id" <> a."customer_id"
  );
--> statement-breakpoint

-- Rewrite economics RPC: lifetime revenue = shop paid + linked ERA paid.
-- Also returns shop/insurance splits so the API can label coverage.
-- DROP first: return-row shape changed (CREATE OR REPLACE cannot alter
-- OUT columns of a RETURNS TABLE function).
DROP FUNCTION IF EXISTS resupply.ltv_cac_customer_economics(uuid);
--> statement-breakpoint

CREATE FUNCTION resupply.ltv_cac_customer_economics(
  p_org_id uuid
)
RETURNS TABLE(
  customer_id text,
  lifetime_revenue_cents bigint,
  shop_revenue_cents bigint,
  insurance_revenue_cents bigint,
  channel text,
  acquisition_cost_cents integer,
  patient_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  WITH revenue AS (
    SELECT
      o.customer_id AS customer_id,
      COALESCE(SUM(o.amount_total_cents), 0)::bigint AS shop_revenue_cents
    FROM resupply.shop_orders o
    WHERE o.org_id = p_org_id
      AND o.paid_at IS NOT NULL
      AND o.status <> 'refunded'
      AND o.customer_id IS NOT NULL
      AND o.customer_id <> ''
    GROUP BY o.customer_id
  ),
  attribution AS (
    SELECT
      a.customer_id AS customer_id,
      a.channel AS channel,
      a.acquisition_cost_cents AS acquisition_cost_cents,
      a.patient_id AS patient_id
    FROM resupply.customer_acquisition a
    WHERE a.org_id = p_org_id
      AND a.customer_id IS NOT NULL
      AND a.customer_id <> ''
  ),
  claim_paid AS (
    SELECT
      a.customer_id AS customer_id,
      COALESCE(SUM(c.total_paid_cents), 0)::bigint AS insurance_revenue_cents
    FROM resupply.customer_acquisition a
    INNER JOIN resupply.insurance_claims c
      ON c.patient_id = a.patient_id
     AND c.org_id IS NOT DISTINCT FROM a.org_id
     AND c.paid_at IS NOT NULL
    WHERE a.org_id = p_org_id
      AND a.patient_id IS NOT NULL
    GROUP BY a.customer_id
  )
  SELECT
    COALESCE(r.customer_id, a.customer_id) AS customer_id,
    (
      COALESCE(r.shop_revenue_cents, 0)
      + COALESCE(cp.insurance_revenue_cents, 0)
    )::bigint AS lifetime_revenue_cents,
    COALESCE(r.shop_revenue_cents, 0)::bigint AS shop_revenue_cents,
    COALESCE(cp.insurance_revenue_cents, 0)::bigint AS insurance_revenue_cents,
    a.channel,
    a.acquisition_cost_cents,
    a.patient_id
  FROM revenue r
  FULL OUTER JOIN attribution a ON a.customer_id = r.customer_id
  LEFT JOIN claim_paid cp
    ON cp.customer_id = COALESCE(r.customer_id, a.customer_id)
$$;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION resupply.ltv_cac_customer_economics(uuid)
  FROM PUBLIC, anon, authenticated;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION resupply.ltv_cac_customer_economics(uuid)
  TO service_role;
