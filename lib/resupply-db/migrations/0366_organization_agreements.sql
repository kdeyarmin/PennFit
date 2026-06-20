-- 0366_organization_agreements — tenant legal acceptances (BAA + platform
-- terms) captured at onboarding (G16, BAA portion).
--
-- Hosting other companies' PHI makes CareMetric Breathe a HIPAA BUSINESS
-- ASSOCIATE of each tenant (the Covered Entity / their own BA chain). Each
-- tenant must therefore execute a Business Associate Agreement, plus the
-- platform's Master Services / Terms agreement, BEFORE using the product.
-- This table records each signed acceptance: which agreement TYPE, which
-- VERSION, who signed, when, and from where — the auditable record a
-- reviewer (or a tenant's own compliance team) expects.
--
-- One row per (org, agreement_type, version): a tenant accepts a given
-- version once. When an agreement's text is revised the version string
-- bumps (in code, lib/agreements), the prior acceptance no longer
-- satisfies the requirement, and the tenant is re-prompted to sign the new
-- version — so the gate is version-aware, not a one-time checkbox.
--
-- Tenant-scoped: org_id NOT NULL + the org_isolation RLS backstop (0348),
-- read/written through the org-scoped facade (`db.from(...)`), never
-- `.raw()`. No PHI — signatory name/email/title are business-contact data.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

CREATE TABLE IF NOT EXISTS "resupply"."organization_agreements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations" ("id") ON DELETE CASCADE,
  "agreement_type" text NOT NULL,
  "version" text NOT NULL,
  "accepted_at" timestamptz NOT NULL DEFAULT now(),
  -- uuid to match the repo-wide `*_by_user_id uuid` convention (the
  -- accepting admin's auth.users id).
  "accepted_by_user_id" uuid,
  "accepted_by_email" text,
  "signatory_name" text,
  "accepted_ip" text,
  CONSTRAINT "organization_agreements_type_chk"
    CHECK ("agreement_type" IN ('baa', 'platform_terms'))
);
--> statement-breakpoint

-- One acceptance per (tenant, agreement, version). A repeat POST of the
-- same version is a no-op (ON CONFLICT DO NOTHING in the route).
CREATE UNIQUE INDEX IF NOT EXISTS "organization_agreements_org_type_version_key"
  ON "resupply"."organization_agreements"
  ("org_id", "agreement_type", "version");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "organization_agreements_org_idx"
  ON "resupply"."organization_agreements" ("org_id");
--> statement-breakpoint

-- RLS backstop, matching the 0348 org_isolation convention (the
-- service-role runtime client bypasses RLS; this is defense-in-depth).
ALTER TABLE "resupply"."organization_agreements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS org_isolation ON "resupply"."organization_agreements";
--> statement-breakpoint

CREATE POLICY org_isolation ON "resupply"."organization_agreements"
  USING ("org_id" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org_id', true)::uuid);
