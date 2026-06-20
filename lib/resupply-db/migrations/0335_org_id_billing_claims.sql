-- 0329_org_id_billing_claims — multi-tenant org_id backfill, batch 4 of
-- N (billing / claims / prior-auth). Phase 0, plan workstream A2.
--
-- See 0326 (batch 1) for the full rationale. Identical safe additive
-- shape: NULLABLE org_id + backfill to the seed tenant
-- (slug 'penn-home-medical') + FK + per-table index. No existing INSERT
-- breaks (nullable), nothing reads/filters org_id yet (no behavior
-- change). NOT NULL tightening + scoped-wrapper cutover land in this
-- domain's cutover PR.
--
-- NOTE: these tables feed the 837P/835 billing pipeline and the
-- clearinghouse routing. Per-tenant billing identity (own NPI/PTAN,
-- own clearinghouse creds) is a Phase 2 concern; this slice only tags
-- the rows with their owning tenant.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

-- ── insurance_claims ────────────────────────────────────────────────
ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."insurance_claims"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "insurance_claims_org_idx"
  ON "resupply"."insurance_claims" ("org_id");
--> statement-breakpoint

-- ── insurance_claim_line_items ──────────────────────────────────────
ALTER TABLE "resupply"."insurance_claim_line_items"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."insurance_claim_line_items"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "insurance_claim_line_items_org_idx"
  ON "resupply"."insurance_claim_line_items" ("org_id");
--> statement-breakpoint

-- ── claim_templates ─────────────────────────────────────────────────
ALTER TABLE "resupply"."claim_templates"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."claim_templates"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_templates_org_idx"
  ON "resupply"."claim_templates" ("org_id");
--> statement-breakpoint

-- ── era_files ───────────────────────────────────────────────────────
ALTER TABLE "resupply"."era_files"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."era_files"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "era_files_org_idx"
  ON "resupply"."era_files" ("org_id");
--> statement-breakpoint

-- ── office_ally_submissions ─────────────────────────────────────────
ALTER TABLE "resupply"."office_ally_submissions"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."office_ally_submissions"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "office_ally_submissions_org_idx"
  ON "resupply"."office_ally_submissions" ("org_id");
--> statement-breakpoint

-- ── prior_authorizations ────────────────────────────────────────────
ALTER TABLE "resupply"."prior_authorizations"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."prior_authorizations"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prior_authorizations_org_idx"
  ON "resupply"."prior_authorizations" ("org_id");
--> statement-breakpoint

-- ── eligibility_checks ──────────────────────────────────────────────
ALTER TABLE "resupply"."eligibility_checks"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."eligibility_checks"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eligibility_checks_org_idx"
  ON "resupply"."eligibility_checks" ("org_id");
--> statement-breakpoint

-- ── davinci_pas_submissions ─────────────────────────────────────────
ALTER TABLE "resupply"."davinci_pas_submissions"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."davinci_pas_submissions"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "davinci_pas_submissions_org_idx"
  ON "resupply"."davinci_pas_submissions" ("org_id");
