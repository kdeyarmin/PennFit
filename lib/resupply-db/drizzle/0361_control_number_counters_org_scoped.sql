-- 0361_control_number_counters_org_scoped — multi-tenant: scope the EDI
-- ISA13 control-number counter per tenant.
--
-- WHY (EDI correctness — this is a real collision bug for tenant #2)
--   resupply.control_number_counters (mig 0308) holds the atomically-
--   reserved ISA13 interchange control number for Office Ally 837P/270
--   submissions, keyed by a single global `pool` ('office_ally_isa13').
--   Each tenant is a DISTINCT EDI submitter (its own NPI/PTAN/ETIN —
--   clearinghouse_credentials went org-scoped in #950). Interchange/group
--   control numbers must be unique PER SUBMITTER; a shared counter means
--   two tenants draw from the same sequence and one tenant's submission
--   can collide with another's already-on-the-wire control number, which
--   Office Ally rejects at the 999 and forces a manual replay. So the
--   counter must be per tenant. (0342 deferred this as a "grain redesign";
--   it is — the PK gains org_id.)
--
-- WHAT
--   * Add org_id (NULLABLE first), backfill the existing row to the seed
--     tenant (penn-home-medical), then SET NOT NULL.
--   * Re-key PRIMARY KEY (pool) -> (org_id, pool): one counter per tenant
--     per pool. The composite PK's leading org_id serves the per-tenant
--     CAS read/update (`.eq(org_id).eq(pool)`), so no extra index.
--   * ENABLE RLS (control_number_counters was created after 0170's catalog
--     loop, so it had none) + the org_isolation policy (mirrors 0348).
--     service_role (the runtime path) bypasses RLS — runtime-inert today.
--
-- The runtime cutover (reserveIsa13Value takes the caller's org-scoped
-- client; the office-ally batch drops its `.raw()`) ships in the same PR.
-- Single-tenant behavior is unchanged: the seed tenant's counter row is the
-- one reserved against today. A newly-onboarded tenant has no counter row
-- yet, so reserveIsa13Value returns null and the submission engine falls
-- back to its existing org-scoped MAX(isa_control_number) read — correct
-- per-tenant monotonicity from that tenant's own office_ally_submissions.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

ALTER TABLE "resupply"."control_number_counters"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."control_number_counters"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "resupply"."control_number_counters"
  ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
-- Re-key: one counter per tenant per pool. Reuse the conventional pkey name.
ALTER TABLE "resupply"."control_number_counters"
  DROP CONSTRAINT IF EXISTS "control_number_counters_pkey";
--> statement-breakpoint
ALTER TABLE "resupply"."control_number_counters"
  ADD CONSTRAINT "control_number_counters_pkey" PRIMARY KEY ("org_id", "pool");
--> statement-breakpoint
-- control_number_counters was created after 0170's RLS catalog loop, so RLS
-- was never enabled on it. Enable it (idempotent) so the policy is a real
-- backstop, then add the per-tenant policy (mirrors 0348). service_role
-- (the runtime path) bypasses RLS, so this is runtime-inert today.
ALTER TABLE "resupply"."control_number_counters" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "resupply"."control_number_counters";
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "resupply"."control_number_counters"
  USING ("org_id" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org_id', true)::uuid);
