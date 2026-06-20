-- 0386_tenant_billing_events — append-only feed of tenant billing changes
-- for the super-admin portal's activity view.
--
-- Why a dedicated table: tenant/platform billing mutations call logAudit(),
-- but @workspace/resupply-audit is a no-op stub (migration 0156 retired the
-- audit_log machinery and the hard rule forbids new audit_log readers). So
-- nothing today persists a READABLE record of who changed a tenant's plan or
-- add-ons. This table mirrors the app_config_events pattern (migration 0211):
-- a narrow, append-only log the platform "Recent billing activity" panel reads
-- via the cross-tenant .raw() escape hatch, exactly like the rest of the
-- /platform/billing surface.
--
-- Posture: platform billing metadata only — plan/add-on codes, quantities,
-- the acting operator's email, and the org it applies to. No PHI, no patient
-- data, no Stripe secrets. Safe to render in the admin UI as-is.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

CREATE TABLE IF NOT EXISTS "resupply"."tenant_billing_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),
  -- Dotted action name mirroring the logAudit action namespace, e.g.
  -- 'subscription.selected', 'subscription.updated', 'addon.updated'.
  "action" text NOT NULL,
  -- Which surface drove the change: a tenant owner self-serving, or a
  -- platform super-admin assigning on the tenant's behalf.
  "actor" text NOT NULL DEFAULT 'platform'
    CHECK ("actor" IN ('tenant', 'platform')),
  -- Free-form email of the acting operator (survives a deleted admin row,
  -- matching admin_users.updated_by_email convention). NULL when unknown.
  "operator_email" text,
  -- Render-ready summary, e.g. "Switched to Growth plan" or
  -- "Set Extra fax line ×2". Lets the panel render without re-deriving.
  "summary" text,
  -- Structured detail for filtering/expansion: { planCode, addonCode,
  -- quantity }. Billing metadata only — never patient data.
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "occurred_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Deny-all by default (service-role bypasses; same posture as the rest of
-- the resupply schema — migration 0170).
ALTER TABLE "resupply"."tenant_billing_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Newest-first lookup powers the activity panel's default view.
CREATE INDEX IF NOT EXISTS "tenant_billing_events_occurred_at_idx"
  ON "resupply"."tenant_billing_events" ("occurred_at" DESC);
--> statement-breakpoint

-- Per-tenant history (filtering the feed to one tenant).
CREATE INDEX IF NOT EXISTS "tenant_billing_events_org_occurred_at_idx"
  ON "resupply"."tenant_billing_events" ("org_id", "occurred_at" DESC);
