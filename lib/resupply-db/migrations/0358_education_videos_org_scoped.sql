-- 0358_education_videos_org_scoped — multi-tenant: scope education_videos per tenant.
--
-- WHY
--   resupply.education_videos (mig 0269) is the storefront /learn library
--   (mask fitting, cleaning, troubleshooting clips). It was left global by
--   the 0331-0342 org_id backfill, which classified it with the reference
--   catalogs (hcpcs_codes, denial_codes, …). But it is NOT reference data:
--   it is operator-managed CONTENT — each DME's staff add / edit / reorder
--   their own clips from /admin (the POST/PATCH routes stamp
--   created_by_email). A shared table means one tenant's admin edits another
--   tenant's learn library, and every tenant's storefront shows the same
--   videos. Mirrors the product_costs reclassification (0357).
--
-- WHAT
--   * Add org_id (NULLABLE first), backfill existing rows to the seed tenant
--     (penn-home-medical), then SET NOT NULL — the standard additive shape.
--     The PK is a surrogate uuid, so NO re-key is needed.
--   * Add an org-leading index for the storefront list
--     (org_id, active, sort_order).
--   * ENABLE RLS (education_videos was created AFTER 0170's catalog loop, so
--     unlike most resupply tables it had no RLS enabled) + add the
--     org_isolation policy (mirrors 0348). Runtime-inert today
--     (service_role bypasses RLS); the backstop for a non-bypassing role.
--
-- The runtime cutover (admin CRUD + the public storefront read move from the
-- unscoped `.raw()` path to the org-scoped facade — storefront resolves the
-- tenant by request host) ships in the same PR. Single-tenant behavior is
-- unchanged: the seed tenant's videos are exactly the rows served today.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

ALTER TABLE "resupply"."education_videos"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."education_videos"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "resupply"."education_videos"
  ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
-- Org-leading index for the storefront list (active videos in display order
-- WITHIN a tenant). The legacy (active, sort_order) index from 0269 stays.
CREATE INDEX IF NOT EXISTS "education_videos_org_active_sort_idx"
  ON "resupply"."education_videos" ("org_id", "active", "sort_order");
--> statement-breakpoint
-- education_videos was created after 0170's RLS catalog loop, so RLS was
-- never enabled on it. Enable it (idempotent) so the policy below is a real
-- backstop, then add the per-tenant policy (mirrors 0348). service_role
-- (the runtime path) bypasses RLS, so this is runtime-inert today.
ALTER TABLE "resupply"."education_videos" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "resupply"."education_videos";
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "resupply"."education_videos"
  USING ("org_id" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org_id', true)::uuid);
