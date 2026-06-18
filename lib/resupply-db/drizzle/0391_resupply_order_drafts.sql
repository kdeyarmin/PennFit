-- 0391_resupply_order_drafts — staged resupply order proposals.
--
-- The therapy-resupply surface (routes/admin/therapy-resupply.ts) already
-- computes "who is due" from device snapshots. This table turns that
-- read-only worklist into actionable PROPOSALS: a draft is a suggestion
-- that patient X is due for a <category> (e.g. a mask cushion), staged
-- either by a CSR (origin='manual', from the opportunities UI) or by the
-- daily `resupply-auto-draft` worker (origin='auto', gated by the
-- `resupply.auto_order_drafts` flag, seeded OFF below).
--
-- A draft is NOT an order. Nothing is created in Stripe or charged
-- automatically: a CSR reviews a proposal, picks the exact SKU, and
-- approves it into the existing sign-&-pay order flow. This keeps the
-- "PennFit is the resupply engine; billing is downstream" posture and
-- guarantees no surprise charges. `suggested_product_id` is a convenience
-- hint (resolved against the Stripe catalog), nullable when ambiguous.
--
-- ORG-SCOPED: every row carries org_id; the org-scoped Supabase facade
-- enforces the tenant filter on the admin routes. RLS deny-all (service
-- role bypasses), same posture as the rest of the resupply schema
-- (migration 0170).
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

CREATE TABLE IF NOT EXISTS "resupply"."resupply_order_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  -- Unified supply category from the vendor snapshot (mask / cushion /
  -- tubing / filter / …) — same enum the opportunities RPC emits.
  "category" text NOT NULL,
  -- Vendor source name + the device-reported item description
  -- ("AirFit N30i"). Both are display hints for the CSR; the exact SKU is
  -- chosen at approve time.
  "source" text,
  "source_description" text,
  -- The plan's next-eligible date this proposal was raised against; part
  -- of the dedup key so the same supply+window isn't proposed twice.
  "next_eligible_date" date,
  -- Convenience hint resolved against the Stripe catalog; NULL when the
  -- match was ambiguous (the CSR picks at review time).
  "suggested_product_id" text,
  "suggested_quantity" integer NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'proposed'
    CHECK ("status" IN ('proposed', 'approved', 'dismissed', 'ordered')),
  -- Who staged it: the daily worker ('auto') or a CSR ('manual').
  "origin" text NOT NULL DEFAULT 'auto'
    CHECK ("origin" IN ('auto', 'manual')),
  -- Actor trail (free-form, no cross-schema FK — matches admin_users
  -- convention). System drafts carry 'system:resupply-auto-draft'.
  "created_by_email" text,
  "created_by_user_id" text,
  "dismissed_reason" text,
  -- Set when an approved draft becomes a real order (the sign-&-pay
  -- shop_orders row); nullable until then.
  "shop_order_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Dedup: at most one OPEN (proposed/approved) draft per
-- (org, patient, category, eligible-date). A dismissed/ordered row does
-- not block a fresh proposal when the supply comes due again. Partial
-- unique index so the daily worker's upsert is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS "resupply_order_drafts_open_dedup_idx"
  ON "resupply"."resupply_order_drafts"
    ("org_id", "patient_id", "category", "next_eligible_date")
  WHERE "status" IN ('proposed', 'approved');
--> statement-breakpoint

-- Drives the review-queue list (newest proposals first, filtered by
-- status) without a sequential scan.
CREATE INDEX IF NOT EXISTS "resupply_order_drafts_org_status_idx"
  ON "resupply"."resupply_order_drafts"
    ("org_id", "status", "created_at" DESC);
--> statement-breakpoint

-- Deny-all by default (service-role bypasses; resupply-schema posture,
-- migration 0170).
ALTER TABLE "resupply"."resupply_order_drafts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Feature flag: gate the daily auto-draft worker. Seeded DISABLED for
-- every existing tenant — auto-staging proposals is opt-in (a CSR can
-- always stage drafts manually from the opportunities UI regardless of
-- this flag). New tenants inherit it via tenant:onboard's seed-org copy.
-- Composite (org_id, key) conflict per migration 0350. The CROSS JOIN
-- fans the one tuple across every org while keeping the seeded-key shape
-- the feature-flags catalog drift guard scans for. Keep in sync with
-- FEATURE_FLAG_KEYS in artifacts/resupply-api/src/lib/feature-flags.ts.
INSERT INTO resupply.feature_flags ("org_id", "key", "enabled", "description", "category")
SELECT o."id", v."key", v."enabled", v."description", v."category"
FROM "resupply"."organizations" o
CROSS JOIN (VALUES
  ('resupply.auto_order_drafts', false, 'Auto-stage resupply order drafts from device-eligible supplies (daily worker). Drafts are proposals a CSR reviews and approves into an order — nothing is created or charged automatically. Seeded OFF; CSRs can still stage drafts manually from the resupply opportunities page. Enable per tenant in the Control Center.', 'Resupply')
) AS v("key", "enabled", "description", "category")
ON CONFLICT ("org_id", "key") DO NOTHING;
