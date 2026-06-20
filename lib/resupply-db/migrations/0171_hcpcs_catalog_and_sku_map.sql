-- 0171_hcpcs_catalog_and_sku_map — canonical HCPCS reference catalog
-- for CPAP/PAP resupply, plus a SKU-prefix → HCPCS bridge.
--
-- Why this exists
-- ---------------
-- Until now HCPCS codes lived ONLY inside human-readable
-- `frequency_rules.name` / `.notes` strings (see 0070_seed_medicare_
-- cadences.sql — e.g. "Medicare — nasal pillows (14 days, A7033)").
-- That made three things impossible to do cleanly:
--   1. Eligibility (a 271 benefit response is keyed on HCPCS) could
--      not be joined back to a supply family.
--   2. Claims (an 837P service line carries a HCPCS) had no shared
--      source of truth for the code set we bill.
--   3. Quantity / frequency *entitlement* ("Medicare allows two
--      A7032 cushions per 30 days, one A7035 headgear per 180")
--      could not be enforced, because the per-code maximums were
--      not stored anywhere structured.
--
-- This migration adds the structured layer the rest of the resupply
-- automation roadmap (real-time eligibility, claim scrubbing, the
-- "too-soon" reorder guard) reads from:
--
--   * resupply.hcpcs_codes   — one row per billable PAP HCPCS, with
--                              the Medicare LCD L33718 replacement
--                              frequency expressed structurally:
--                              the minimum days between payable
--                              dispenses and the max quantity per
--                              rolling period.
--   * resupply.sku_hcpcs_map — maps the uppercase-dashed SKU prefix
--                              the resupply catalog already uses
--                              (MASK, CUSHION, PILLOW, FILTER-DISP,
--                              ...) to a representative HCPCS. The
--                              prefix is the coarse supply family the
--                              reminder engine matches on; the map
--                              lets the entitlement/eligibility/claims
--                              layers resolve a prefix to a code.
--
-- Scope note
-- ----------
-- A SKU prefix can legitimately bill under more than one HCPCS
-- (e.g. MASK → A7030 full-face OR A7034 nasal interface). Both share
-- the same replacement frequency, so a representative code is correct
-- for the cadence/entitlement use; the *exact* claim-line HCPCS is
-- still finalized from the specific dispensed product at claim time.
-- The map intentionally models the family, not the per-SKU coding.
--
-- This is additive and non-breaking: nothing reads these tables yet
-- (the entitlement engine + eligibility wire land in follow-up
-- changes), the reminder engine continues to resolve cadence via
-- frequency_rules exactly as before, and both tables are seeded
-- idempotently.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ---------------------------------------------------------------
-- HCPCS reference catalog.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "resupply"."hcpcs_codes" (
  -- The HCPCS Level II code (e.g. 'A7032'). Natural primary key.
  "code" text PRIMARY KEY NOT NULL,
  "short_description" text NOT NULL,
  -- Coarse supply family. Drives icons / grouping in the admin UI and
  -- lets the entitlement engine reason about "is this a consumable?".
  "category" text NOT NULL,
  -- Minimum days between payable dispenses under the standard Medicare
  -- LCD L33718 schedule. This is the "earliest eligible" interval the
  -- too-soon reorder guard enforces — distinct from the *reminder*
  -- cadence in frequency_rules (which may nudge slightly before this).
  "min_interval_days" integer NOT NULL,
  -- Max quantity payable within `period_days`. e.g. A7032 nasal
  -- cushion = 2 per 30 days. Used by the quantity-entitlement guard.
  "max_quantity_per_period" integer NOT NULL,
  "period_days" integer NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "resupply"."hcpcs_codes"
  DROP CONSTRAINT IF EXISTS "hcpcs_codes_category_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."hcpcs_codes"
  ADD CONSTRAINT "hcpcs_codes_category_enum"
  CHECK ("category" IN (
    'mask',
    'cushion',
    'pillow',
    'filter',
    'tubing',
    'headgear',
    'chinstrap',
    'chamber',
    'device',
    'other'
  ));
--> statement-breakpoint

ALTER TABLE "resupply"."hcpcs_codes"
  DROP CONSTRAINT IF EXISTS "hcpcs_codes_positive_intervals";
--> statement-breakpoint
ALTER TABLE "resupply"."hcpcs_codes"
  ADD CONSTRAINT "hcpcs_codes_positive_intervals"
  CHECK (
    "min_interval_days" > 0
    AND "max_quantity_per_period" > 0
    AND "period_days" > 0
  );
--> statement-breakpoint

-- ---------------------------------------------------------------
-- SKU-prefix → HCPCS bridge.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "resupply"."sku_hcpcs_map" (
  -- The uppercase-dashed SKU-prefix the resupply catalog + frequency
  -- rules already use (MASK, CUSHION, FILTER-DISP, ...). Natural PK.
  "sku_prefix" text PRIMARY KEY NOT NULL,
  "hcpcs_code" text NOT NULL
    REFERENCES "resupply"."hcpcs_codes"("code") ON DELETE RESTRICT,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "sku_hcpcs_map_hcpcs_idx"
  ON "resupply"."sku_hcpcs_map" ("hcpcs_code");
--> statement-breakpoint

-- ---------------------------------------------------------------
-- Seed the canonical PAP HCPCS set (CMS LCD L33718).
-- Idempotent: ON CONFLICT DO NOTHING keyed on the natural PK so a
-- re-run is a no-op and an admin-renamed description is preserved.
-- ---------------------------------------------------------------
INSERT INTO "resupply"."hcpcs_codes"
  (code, short_description, category, min_interval_days, max_quantity_per_period, period_days, notes)
VALUES
  ('A7030', 'Full face mask interface',            'mask',      90,  1, 90,  'CMS LCD L33718. One every 3 months.'),
  ('A7031', 'Full face mask cushion (replacement)','cushion',   30,  1, 30,  'CMS LCD L33718. One per month.'),
  ('A7032', 'Nasal mask cushion (replacement)',    'cushion',   15,  2, 30,  'CMS LCD L33718. Two per month.'),
  ('A7033', 'Nasal pillows (replacement)',         'pillow',    15,  2, 30,  'CMS LCD L33718. Two per month.'),
  ('A7034', 'Nasal mask interface',                'mask',      90,  1, 90,  'CMS LCD L33718. One every 3 months.'),
  ('A7035', 'Headgear',                            'headgear',  180, 1, 180, 'CMS LCD L33718. One every 6 months.'),
  ('A7036', 'Chinstrap',                           'chinstrap', 180, 1, 180, 'CMS LCD L33718. One every 6 months.'),
  ('A7037', 'Tubing',                              'tubing',    90,  1, 90,  'CMS LCD L33718. One every 3 months.'),
  ('A7038', 'Disposable filter',                   'filter',    15,  2, 30,  'CMS LCD L33718. Two per month.'),
  ('A7039', 'Reusable (non-disposable) filter',    'filter',    180, 1, 180, 'CMS LCD L33718. One every 6 months.'),
  ('A7044', 'Oral interface',                      'mask',      90,  1, 90,  'CMS LCD L33718. One every 3 months.'),
  ('A7046', 'Humidifier water chamber',            'chamber',   180, 1, 180, 'CMS LCD L33718. One every 6 months.'),
  ('A4604', 'Heated tubing with sensor',           'tubing',    90,  1, 90,  'CMS LCD L33718. One every 3 months.'),
  ('E0601', 'CPAP device (E0601)',                 'device',    1825,1, 1825,'CMS pays a replacement device every 5 years.')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

-- Map the SKU prefixes the resupply engine already matches on
-- (see 0070) to a representative HCPCS. CUSHION → A7032 (nasal, the
-- common case); MASK → A7034 (nasal interface). Both share the
-- per-family cadence used for entitlement.
INSERT INTO "resupply"."sku_hcpcs_map" (sku_prefix, hcpcs_code)
VALUES
  ('MASK',         'A7034'),
  ('CUSHION',      'A7032'),
  ('PILLOW',       'A7033'),
  ('FILTER-DISP',  'A7038'),
  ('FILTER-REUSE', 'A7039'),
  ('TUBING',       'A7037'),
  ('HEADGEAR',     'A7035'),
  ('CHINSTRAP',    'A7036'),
  ('CHAMBER',      'A7046')
ON CONFLICT (sku_prefix) DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- RLS — match the deny-all posture established in 0169/0170.
-- service_role (the only runtime data path) bypasses RLS; enabling
-- it with no policy makes these tables deny-all to anon/authenticated,
-- which is the intended end-state for a service-role-only schema.
-- 0170's catalog loop already ran, so new tables must enable it here.
-- ---------------------------------------------------------------
ALTER TABLE "resupply"."hcpcs_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "resupply"."sku_hcpcs_map" ENABLE ROW LEVEL SECURITY;
