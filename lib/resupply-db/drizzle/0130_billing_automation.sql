-- 0130_billing_automation — three small catalogs that turn the
-- claim-creation flow from "look up everything by hand" into
-- "click one button".
--
-- Why
-- ---
-- Today a CSR who wants to bill for a dispensed resupply has to:
--   1. Manually create a draft claim (date_of_service, payer, etc).
--   2. For each shipped product, look up the right HCPCS code from a
--      spreadsheet on the billing team's shared drive.
--   3. For each line, pick the right modifiers (KX for compliance,
--      RR for rental month, NU for purchased, etc) — which depend on
--      the payer + the rental cycle stage.
--   4. Look up the expected billed amount from the payer's published
--      fee schedule (now centralised in 0129's payer_fee_schedules,
--      but the CSR still has to know to query it).
--   5. Submit, and only THEN find out (from the 999 / 277CA / claim
--      denial) what they forgot.
--
-- This migration adds the three catalogs the claim-builder service
-- needs to do all that work for the CSR, and structurally encodes
-- the payer-specific modifier rules so the right modifiers attach
-- automatically:
--
--   1. product_hcpcs_map        — shop SKU → HCPCS code + default
--                                 modifier set + units per dispense.
--   2. payer_modifier_rules     — payer + HCPCS → required / suggested
--                                 modifier list, with a condition expr
--                                 (e.g. "always", "if_rental_month >= 4",
--                                 "if_compliant"). The rule engine
--                                 in lib/billing/claim-builder.ts
--                                 evaluates these.
--   3. claim_templates          — frequently-used line-item shapes
--                                 (e.g. "monthly cushion + tubing +
--                                 filter resupply"). One click stamps
--                                 a template's lines onto a draft.
--
-- All three are admin-editable so the catalog stays current without
-- a deploy when CMS or a payer publishes a rule change.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ────────────────────────────────────────────────────────────────────
-- 1. product_hcpcs_map — shop SKU → HCPCS code.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."product_hcpcs_map" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- The shop_order_items.product_id Stripe product id, OR the
  -- fulfillments.item_sku — we match on whichever the caller passes.
  -- Encoded as a single text column with a `lookup_kind` discriminator.
  "lookup_kind" text NOT NULL,
  "lookup_value" varchar(120) NOT NULL,
  "hcpcs_code" varchar(12) NOT NULL,
  -- Default modifiers as a sorted CSV (e.g. "NU" or "RR,KX"). Payer
  -- modifier rules can override; this is the "in absence of payer
  -- rules" default.
  "default_modifiers" varchar(32),
  -- Units billed per single dispensed item. For a CPAP mask cushion
  -- this is 1; for filters bought in a 3-pack it's 3.
  "units_per_dispense" integer NOT NULL DEFAULT 1,
  -- Optional default billed amount (cents) — overridden by the
  -- payer_fee_schedules lookup on the claim builder, but provides a
  -- sane starting value for cash-pay / out-of-network flows.
  "default_billed_cents" bigint,
  "description" varchar(240),
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "product_hcpcs_map_lookup_kind_enum"
    CHECK ("lookup_kind" IN ('stripe_product_id', 'item_sku')),
  CONSTRAINT "product_hcpcs_map_units_pos"
    CHECK ("units_per_dispense" > 0),
  CONSTRAINT "product_hcpcs_map_billed_nonneg"
    CHECK ("default_billed_cents" IS NULL OR "default_billed_cents" >= 0)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "product_hcpcs_map_lookup_uq"
  ON "resupply"."product_hcpcs_map" ("lookup_kind", "lookup_value");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "product_hcpcs_map_hcpcs_idx"
  ON "resupply"."product_hcpcs_map" ("hcpcs_code");
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 2. payer_modifier_rules — payer + HCPCS → required modifiers.
-- ────────────────────────────────────────────────────────────────────
--
-- The rule engine (lib/billing/claim-builder.ts) evaluates each row's
-- `condition` against the in-flight claim context and, when satisfied,
-- attaches the modifiers from `modifiers_csv`.
--
-- Supported conditions (string enum):
--   * always                      — unconditional
--   * if_rental_month_le_3        — rental month 1-3 (initial capped period)
--   * if_rental_month_ge_4        — rental month 4-13 (continuing rental)
--   * if_purchased                — patient owns the device outright
--   * if_compliant_90day          — 21 of 30 nights >= 4h documented
--   * if_initial_dispense         — first time this HCPCS dispensed for the patient
--   * if_abn_on_file              — Advance Beneficiary Notice signed
--   * if_pa_approved              — prior auth approved for this HCPCS
CREATE TABLE IF NOT EXISTS "resupply"."payer_modifier_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "payer_profile_id" uuid NOT NULL
    REFERENCES "resupply"."payer_profiles"("id") ON DELETE CASCADE,
  "hcpcs_code" varchar(12) NOT NULL,
  "condition" text NOT NULL DEFAULT 'always',
  "modifiers_csv" varchar(32) NOT NULL,
  "priority" smallint NOT NULL DEFAULT 100,
  "rationale" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "payer_modifier_rules_condition_enum"
    CHECK ("condition" IN (
      'always',
      'if_rental_month_le_3',
      'if_rental_month_ge_4',
      'if_purchased',
      'if_compliant_90day',
      'if_initial_dispense',
      'if_abn_on_file',
      'if_pa_approved'
    )),
  CONSTRAINT "payer_modifier_rules_modifiers_not_blank"
    CHECK (length(trim("modifiers_csv")) > 0)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "payer_modifier_rules_payer_hcpcs_idx"
  ON "resupply"."payer_modifier_rules"
  ("payer_profile_id", "hcpcs_code", "priority")
  WHERE "is_active" = true;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 3. claim_templates — pre-built line-item shapes.
-- ────────────────────────────────────────────────────────────────────
--
-- Lines are stored as JSON because the structure mirrors what the
-- claim-builder emits when stamping a template. A normalised child
-- table is feasible later if templates become heavily queried.
CREATE TABLE IF NOT EXISTS "resupply"."claim_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" varchar(80) NOT NULL UNIQUE,
  "display_name" varchar(160) NOT NULL,
  "description" text,
  -- {"lines": [{"hcpcs": "A7032", "modifiers": "NU", "units": 1, "billed_cents": 1499, "description": "Nasal pillow cushion"}, ...]}
  "lines_json" jsonb NOT NULL,
  -- Optional default diagnosis codes (ICD-10 array). The CSR can override.
  "default_diagnosis_codes" text[] NOT NULL DEFAULT '{}',
  -- Optional preferred payer scope — when set, the template only
  -- surfaces in the picker for matching payer profiles. NULL = global.
  "scoped_payer_profile_id" uuid
    REFERENCES "resupply"."payer_profiles"("id") ON DELETE SET NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "claim_templates_slug_format"
    CHECK ("slug" ~ '^[a-z0-9_]+$'),
  CONSTRAINT "claim_templates_lines_json_object"
    CHECK (jsonb_typeof("lines_json") = 'object')
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "claim_templates_active_idx"
  ON "resupply"."claim_templates" ("is_active")
  WHERE "is_active" = true;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 4. SEED product_hcpcs_map — the common DME resupply SKUs.
-- ────────────────────────────────────────────────────────────────────
--
-- HCPCS for CPAP / RAD / oxygen DME from the CMS DMEPOS fee schedule.
-- We seed `item_sku` rows that match the fulfillments.item_sku
-- convention used in 0010+; the same map can grow Stripe product_id
-- rows as the storefront catalog evolves.
INSERT INTO "resupply"."product_hcpcs_map"
  ("lookup_kind", "lookup_value", "hcpcs_code", "default_modifiers",
   "units_per_dispense", "default_billed_cents", "description")
VALUES
  -- ── Devices (rental codes use RR; new-purchase uses NU) ──
  ('item_sku', 'cpap-machine', 'E0601', 'RR', 1, 89500,
   'CPAP device — continuous positive airway pressure (rental cadence)'),
  ('item_sku', 'auto-cpap-machine', 'E0601', 'RR', 1, 89500,
   'Auto-titrating CPAP — billed identically to E0601 on rental cycle'),
  ('item_sku', 'bipap-machine', 'E0470', 'RR', 1, 124500,
   'Bilevel PAP without backup rate'),
  ('item_sku', 'bipap-st-machine', 'E0471', 'RR', 1, 198500,
   'Bilevel PAP with backup rate (ST)'),
  ('item_sku', 'humidifier', 'E0562', 'RR', 1, 31900,
   'Heated humidifier — separate billing code on rental cycle'),
  ('item_sku', 'oxygen-concentrator', 'E1390', 'RR', 1, 18000,
   'Stationary oxygen concentrator — monthly rental'),

  -- ── Masks (purchase codes use NU) ──
  ('item_sku', 'nasal-mask', 'A7034', 'NU', 1, 9499,
   'Nasal CPAP mask interface'),
  ('item_sku', 'nasal-pillow-mask', 'A7034', 'NU', 1, 9499,
   'Nasal pillow CPAP mask interface'),
  ('item_sku', 'full-face-mask', 'A7030', 'NU', 1, 11899,
   'Full-face CPAP mask interface'),
  ('item_sku', 'mask-cushion-nasal', 'A7032', 'NU', 1, 2899,
   'Replacement nasal mask cushion'),
  ('item_sku', 'mask-cushion-full-face', 'A7031', 'NU', 1, 3199,
   'Replacement full-face mask cushion'),
  ('item_sku', 'mask-cushion-pillows', 'A7033', 'NU', 1, 2899,
   'Replacement nasal-pillow cushions (pair)'),
  ('item_sku', 'mask-headgear', 'A7035', 'NU', 1, 3199,
   'CPAP headgear'),
  ('item_sku', 'mask-chinstrap', 'A7036', 'NU', 1, 2199,
   'CPAP chinstrap'),

  -- ── Tubing + filters ──
  ('item_sku', 'tubing-standard', 'A7037', 'NU', 1, 2499,
   'CPAP tubing — standard (non-heated)'),
  ('item_sku', 'tubing-heated', 'A4604', 'NU', 1, 4899,
   'CPAP tubing — heated'),
  ('item_sku', 'filter-disposable', 'A7038', 'NU', 2, 1599,
   'Disposable filter (typically dispensed in pairs)'),
  ('item_sku', 'filter-reusable', 'A7039', 'NU', 1, 1899,
   'Reusable / pollen filter'),
  ('item_sku', 'humidifier-chamber', 'A7046', 'NU', 1, 4499,
   'Water chamber for heated humidifier'),

  -- ── Oxygen supplies ──
  ('item_sku', 'oxygen-cannula', 'A4615', 'NU', 1, 599,
   'Nasal cannula'),
  ('item_sku', 'oxygen-tubing', 'A4616', 'NU', 1, 999,
   'Oxygen tubing — per foot (sold in standard 7ft lengths)')
ON CONFLICT ("lookup_kind", "lookup_value") DO NOTHING;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 5. SEED payer_modifier_rules — Medicare DME baseline.
-- ────────────────────────────────────────────────────────────────────
--
-- These are the rules Medicare's Noridian DME MAC + the CMS DMEPOS
-- LCDs apply to PA-resident beneficiaries. Commercial payers
-- generally honour the same patterns but ops can override per row.
--
-- We seed against the Medicare DME MAC payer profile (`medicare_dme_noridian`)
-- — that's where claims actually route for PA. The rules are intended
-- to be COPIED to commercial payers when ops needs payer-specific
-- variation; the seed is starter content, not a final ruleset.
INSERT INTO "resupply"."payer_modifier_rules"
  ("payer_profile_id", "hcpcs_code", "condition", "modifiers_csv",
   "priority", "rationale")
SELECT
  p.id, x.hcpcs, x.condition, x.modifiers, x.priority, x.rationale
FROM (VALUES
  -- E0601 capped rental: months 1-3 use KH, months 4-13 use KX (if
  -- compliant). RR (rental) is on every monthly bill regardless;
  -- it's added through the default_modifiers column on the SKU map.
  ('E0601', 'if_rental_month_le_3', 'KH',  10,
   'Medicare capped-rental months 1-3 use the KH modifier (initial)'),
  ('E0601', 'if_rental_month_ge_4', 'KI,KX', 10,
   'Medicare capped-rental months 4-13 use KI (continuing) + KX (compliance proven)'),
  ('E0601', 'if_purchased',         'NU',     20,
   'Outright purchase (rare for DME)'),
  ('E0470', 'if_rental_month_le_3', 'KH',  10,
   'BPAP capped-rental months 1-3'),
  ('E0470', 'if_rental_month_ge_4', 'KI,KX', 10,
   'BPAP capped-rental months 4-13 with compliance proven'),
  ('E0471', 'if_rental_month_le_3', 'KH',  10,
   'BPAP-ST capped-rental months 1-3'),
  ('E0471', 'if_rental_month_ge_4', 'KI,KX', 10,
   'BPAP-ST capped-rental months 4-13 with compliance proven'),
  -- Mask supplies always carry KX once the patient is on month >= 4
  -- of CPAP rental (proves continued medical necessity per LCD L33718).
  ('A7034', 'if_compliant_90day',   'KX',     30,
   'Compliant mask resupply per LCD L33718'),
  ('A7032', 'if_compliant_90day',   'KX',     30,
   'Compliant cushion resupply per LCD L33718'),
  ('A7033', 'if_compliant_90day',   'KX',     30,
   'Compliant nasal-pillow cushion resupply per LCD L33718'),
  ('A7035', 'if_compliant_90day',   'KX',     30,
   'Compliant headgear resupply per LCD L33718'),
  ('A7037', 'if_compliant_90day',   'KX',     30,
   'Compliant tubing resupply per LCD L33718'),
  ('A7038', 'if_compliant_90day',   'KX',     30,
   'Compliant disposable filter resupply per LCD L33718'),
  ('A7046', 'if_compliant_90day',   'KX',     30,
   'Compliant humidifier chamber resupply per LCD L33718')
) AS x("hcpcs", "condition", "modifiers", "priority", "rationale")
CROSS JOIN (
  SELECT id FROM "resupply"."payer_profiles"
   WHERE slug = 'medicare_dme_noridian'
   LIMIT 1
) p
WHERE NOT EXISTS (
  SELECT 1 FROM "resupply"."payer_modifier_rules" r
   WHERE r.payer_profile_id = p.id
     AND r.hcpcs_code = x.hcpcs
     AND r.condition = x.condition
);
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 6. SEED claim_templates — common resupply shapes.
-- ────────────────────────────────────────────────────────────────────
INSERT INTO "resupply"."claim_templates"
  ("slug", "display_name", "description", "lines_json", "default_diagnosis_codes")
VALUES
  ('monthly_resupply_basic',
   'Monthly Resupply — Basic',
   'Standard monthly resupply: cushion + tubing + 2 filters.',
   '{"lines":[
      {"hcpcs":"A7032","modifiers":"NU","units":1,"billed_cents":2899,"description":"Nasal cushion"},
      {"hcpcs":"A7037","modifiers":"NU","units":1,"billed_cents":2499,"description":"Standard tubing"},
      {"hcpcs":"A7038","modifiers":"NU","units":2,"billed_cents":1599,"description":"Disposable filters"}
    ]}'::jsonb,
   ARRAY['G47.33']),
  ('monthly_resupply_full',
   'Monthly Resupply — Full',
   'Resupply including new mask + headgear.',
   '{"lines":[
      {"hcpcs":"A7034","modifiers":"NU","units":1,"billed_cents":9499,"description":"Nasal mask"},
      {"hcpcs":"A7035","modifiers":"NU","units":1,"billed_cents":3199,"description":"Headgear"},
      {"hcpcs":"A7037","modifiers":"NU","units":1,"billed_cents":2499,"description":"Standard tubing"},
      {"hcpcs":"A7038","modifiers":"NU","units":2,"billed_cents":1599,"description":"Disposable filters"},
      {"hcpcs":"A7046","modifiers":"NU","units":1,"billed_cents":4499,"description":"Humidifier chamber"}
    ]}'::jsonb,
   ARRAY['G47.33']),
  ('rental_month_1',
   'CPAP Rental — Month 1',
   'Initial capped-rental month of E0601 + humidifier.',
   '{"lines":[
      {"hcpcs":"E0601","modifiers":"RR,KH","units":1,"billed_cents":89500,"description":"CPAP device, month 1"},
      {"hcpcs":"E0562","modifiers":"RR","units":1,"billed_cents":31900,"description":"Humidifier"}
    ]}'::jsonb,
   ARRAY['G47.33']),
  ('rental_month_4_plus',
   'CPAP Rental — Month 4+',
   'Continuing capped-rental month of E0601 (KI+KX) + humidifier.',
   '{"lines":[
      {"hcpcs":"E0601","modifiers":"RR,KI,KX","units":1,"billed_cents":89500,"description":"CPAP device, month 4+"},
      {"hcpcs":"E0562","modifiers":"RR","units":1,"billed_cents":31900,"description":"Humidifier"}
    ]}'::jsonb,
   ARRAY['G47.33'])
ON CONFLICT ("slug") DO NOTHING;
