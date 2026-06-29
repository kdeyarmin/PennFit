-- Org-scope the remaining global UNIQUE indexes/constraints on tenant tables.
--
-- A round-2 sweep found several more UNIQUE keys on org-owned tables whose key
-- omits org_id — the same class 0476 / 0478 / 0479 already fixed for other
-- tables. The data layer auto-scopes every read/write by org_id
-- (getOrgScopedClient), so a second tenant whose natural key (slug / serial /
-- external id / metric) collides with another tenant's row trips a 23505 raised
-- by the OTHER tenant's row; the org-scoped 23505-recovery then can't see it →
-- a false 409 lockout, a silent drop, or a 500. The worst case is
-- business_targets, whose route upserts ON CONFLICT against the global key — so
-- a second tenant's upsert lands on (and stamps its org_id onto) the FIRST
-- tenant's row: a silent cross-tenant data overwrite.
--
-- Re-key each as (org_id, <natural key…>) so uniqueness is per-tenant.
--
-- Safe to apply: every OLD index is STRICTLY stronger (global-unique) than its
-- new per-tenant replacement, so all current rows already satisfy the new
-- uniqueness — there are no cross-tenant duplicates today and the CREATEs
-- cannot fail. org_id is fully populated (0331–0342 backfill; verified 0 NULLs).
-- Idempotent: DROP … IF EXISTS + CREATE … IF NOT EXISTS. Plain
-- (non-CONCURRENTLY) so it runs inside the migrator's transaction. The seven
-- inline / named UNIQUE *constraints* are dropped with ALTER … DROP CONSTRAINT;
-- the four CREATE-UNIQUE-INDEX ones with DROP INDEX (verified against the live
-- schema via pg_constraint). Each is replaced by a plain UNIQUE INDEX (matching
-- the 0476/0478/0479 pattern); PostgREST upserts conflict on COLUMN lists, not
-- constraint names, so dropping the constraint backing is behavior-preserving.

-- ── business_targets: (metric_key, period) → (org_id, metric_key, period) ──
-- The PUT /admin/business-targets route's onConflict is corrected to
-- "org_id,metric_key,period" in the same change.
ALTER TABLE "resupply"."business_targets"
  DROP CONSTRAINT IF EXISTS "business_targets_metric_period_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "business_targets_org_metric_period_unique"
  ON "resupply"."business_targets" ("org_id", "metric_key", "period");
--> statement-breakpoint

-- ── csr_macros: (key) → (org_id, key) ──
ALTER TABLE "resupply"."csr_macros"
  DROP CONSTRAINT IF EXISTS "csr_macros_key_key";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "csr_macros_org_key_unique"
  ON "resupply"."csr_macros" ("org_id", "key");
--> statement-breakpoint

-- ── payer_profiles: (slug) → (org_id, slug) ──
ALTER TABLE "resupply"."payer_profiles"
  DROP CONSTRAINT IF EXISTS "payer_profiles_slug_key";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payer_profiles_org_slug_unique"
  ON "resupply"."payer_profiles" ("org_id", "slug");
--> statement-breakpoint

-- ── claim_templates: (slug) → (org_id, slug) ──
ALTER TABLE "resupply"."claim_templates"
  DROP CONSTRAINT IF EXISTS "claim_templates_slug_key";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "claim_templates_org_slug_unique"
  ON "resupply"."claim_templates" ("org_id", "slug");
--> statement-breakpoint

-- ── era_files: (file_sha256) → (org_id, file_sha256) ──
ALTER TABLE "resupply"."era_files"
  DROP CONSTRAINT IF EXISTS "era_files_file_sha256_key";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "era_files_org_file_sha256_unique"
  ON "resupply"."era_files" ("org_id", "file_sha256");
--> statement-breakpoint

-- ── office_ally_submissions: (file_name) → (org_id, file_name) ──
-- file_name is PF-BATCH-<ISA13>.txt and ISA13 is a PER-TENANT counter (0361),
-- so two tenants both start low and produce the same file_name — a structural
-- cross-tenant collision until this is org-scoped.
ALTER TABLE "resupply"."office_ally_submissions"
  DROP CONSTRAINT IF EXISTS "office_ally_submissions_file_name_key";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "office_ally_submissions_org_file_name_unique"
  ON "resupply"."office_ally_submissions" ("org_id", "file_name");
--> statement-breakpoint

-- ── patient_therapy_links: (source, partner_patient_id) →
--      (org_id, source, partner_patient_id) ──
-- The sibling (patient_id, source) WHERE status='active' index is already
-- tenant-partitioned (patient_id is org-owned), so it is left as-is.
ALTER TABLE "resupply"."patient_therapy_links"
  DROP CONSTRAINT IF EXISTS "patient_therapy_links_partner_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "patient_therapy_links_org_partner_unique"
  ON "resupply"."patient_therapy_links" ("org_id", "source", "partner_patient_id");
--> statement-breakpoint

-- ── equipment_recalls: (recall_reference) → (org_id, recall_reference) ──
DROP INDEX IF EXISTS "resupply"."equipment_recalls_reference_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "equipment_recalls_org_reference_unique"
  ON "resupply"."equipment_recalls" ("org_id", "recall_reference");
--> statement-breakpoint

-- ── patient_packet_presets: (lower(name)) → (org_id, lower(name)) ──
DROP INDEX IF EXISTS "resupply"."patient_packet_presets_name_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "patient_packet_presets_org_name_idx"
  ON "resupply"."patient_packet_presets" ("org_id", lower("name"));
--> statement-breakpoint

-- ── shop_product_compatibility: two partial uniques on (product_id, …) →
--      (org_id, product_id, …) ──
DROP INDEX IF EXISTS "resupply"."shop_product_compatibility_unique_model_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_product_compatibility_org_unique_model_idx"
  ON "resupply"."shop_product_compatibility" (
    "org_id",
    "product_id",
    lower("machine_manufacturer"),
    lower("machine_model")
  )
  WHERE "machine_model" IS NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "resupply"."shop_product_compatibility_unique_null_model_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_product_compatibility_org_unique_null_model_idx"
  ON "resupply"."shop_product_compatibility" (
    "org_id",
    "product_id",
    lower("machine_manufacturer")
  )
  WHERE "machine_model" IS NULL;
