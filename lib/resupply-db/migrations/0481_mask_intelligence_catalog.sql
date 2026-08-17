-- 0481_mask_intelligence_catalog — a real, queryable mask knowledge base.
--
-- Why
-- ---
-- The mask "catalog" today is a hardcoded 1,559-line TypeScript array
-- (artifacts/resupply-api/src/data/maskCatalog.ts) whose own header says
-- "Replace with actual inventory and manufacturer-provided fit ranges before
-- production use." It carries 39 models, `sizesAvailable` as a bare
-- string[] with ZERO per-size dimensions, contraindications as free-text
-- English matched by substring, and nothing at all about vented vs
-- non-vented, magnetic components, PAP vs NIV, pediatric vs adult, HCPCS
-- codes, replacement components, discontinued status, or manufacturer
-- fitting-instruction versions. A DME cannot configure it, a clinician
-- cannot audit it, and the recommendation engine cannot reason over it.
--
-- This migration is the data foundation for that: a dedicated Mask
-- Intelligence Catalog, deliberately SEPARATE from the products sold in the
-- Breathe storefront (those live in Stripe + shop_* tables). A mask can be
-- recommendable without being sellable here — an outside DME's fitter must
-- be able to recommend whatever that DME actually carries.
--
-- Model
-- -----
-- Five tables:
--   mask_models                  — one row per mask model (the "intelligence")
--   mask_size_variants           — per-size millimetre bands. THE missing
--                                  piece. Cushion and frame are separate
--                                  rows so "recommended frame size" and
--                                  "recommended cushion size" resolve
--                                  independently.
--   mask_components              — replacement parts + payer replacement
--                                  categories + HCPCS
--   mask_component_compatibility — cross-model frame/cushion compatibility
--   mask_contraindications       — STRUCTURED clinical exclusions, replacing
--                                  substring matching on free text. severity
--                                  'exclude' is a hard filter the engine can
--                                  never score away; 'caution' is a penalty
--                                  plus a displayed caveat.
--
-- Tenancy: these are PLATFORM REFERENCE DATA, following the same pattern as
-- resupply.hcpcs_codes (migration 0171) — manufacturer facts are the same
-- for every tenant. `org_id` is NULLABLE: NULL = platform-published row,
-- non-NULL = a private model a single tenant added for its own formulary.
-- Readers filter `org_id IS NULL OR org_id = <tenant>`. Uniqueness is two
-- partial indexes so a tenant can shadow a platform slug without colliding
-- with another tenant. The formulary (0482) is what is genuinely
-- tenant-scoped; this is the shared vocabulary it points at.
--
-- Clinical-safety posture: every seeded row lands with
-- fit_data_source='estimated' and needs_clinical_review=true. Precise
-- manufacturer fit ranges are proprietary and not reliably public, so the
-- seed uses the existing values plus clinically-reasoned defaults, and the
-- recommendation engine caps an unreviewed variant below high confidence
-- until an RT clears it in the catalog admin page.
--
-- PHI: none. This table holds product facts only — no patient data ever.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ---------------------------------------------------------------
-- Backfill the three combination (hybrid) mask HCPCS codes.
-- ---------------------------------------------------------------
-- 0171 seeded the full-face / nasal / pillow families but not the
-- combination oral-nasal codes, and this catalog classifies hybrid masks
-- as a first-class interface type. Same shape + intervals convention as
-- 0171 (CMS LCD L33718). Idempotent — never overwrites an existing row.
INSERT INTO "resupply"."hcpcs_codes"
  (code, short_description, category,
   min_interval_days, max_quantity_per_period, period_days, notes)
VALUES
  ('A7027', 'Combination oral/nasal mask interface', 'mask',    90, 1, 90,
   'CMS LCD L33718. One every 3 months.'),
  ('A7028', 'Oral cushion for combination mask',     'cushion', 15, 2, 30,
   'CMS LCD L33718. Two per month.'),
  ('A7029', 'Nasal pillows for combination mask',    'pillow',  15, 2, 30,
   'CMS LCD L33718. Two per month (pairs).')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- mask_models — one row per mask model.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "resupply"."mask_models" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- NULL = platform-published catalog row (the common case). Non-NULL =
  -- a private model this tenant added. Nullable by design; see header.
  "org_id" uuid REFERENCES "resupply"."organizations"("id"),
  -- Stable key. Deliberately the SAME id space the current engine already
  -- emits (e.g. 'resmed-airfit-f20'), so mask_fit_outcomes.mask_id and
  -- fitter_invites.recommended_mask_id keep resolving after the cutover.
  "slug" text NOT NULL,
  "manufacturer" text NOT NULL,
  "model_name" text NOT NULL,
  -- Family the model belongs to ('AirFit', 'DreamWear', 'Evora').
  "product_line" text,
  -- Interface classification. Wider than the engine's 4-way MaskType:
  -- adds nasal_cradle, total_face, and oral so the catalog can describe
  -- the whole market rather than just what we score today.
  "interface_type" text NOT NULL,
  -- Adult vs pediatric service line. 'both' for models with genuinely
  -- overlapping indications.
  "service_line" text NOT NULL DEFAULT 'adult',
  -- PAP vs NIV compatibility. An array because many models are both.
  "therapy_modes" text[] NOT NULL DEFAULT ARRAY['pap']::text[],
  -- Vented (single-limb PAP, CO2 washout through the mask) vs non-vented
  -- (NIV with an active exhalation valve / dual limb). Getting this wrong
  -- is a rebreathing hazard, which is why the engine treats a mismatch as
  -- a hard exclusion rather than a score penalty.
  "vented" text NOT NULL DEFAULT 'vented',
  -- Magnetic headgear clips. Drives the safety screen: a patient or
  -- household member with an implanted device excludes every model where
  -- this is true.
  "has_magnetic_components" boolean NOT NULL DEFAULT false,
  "magnetic_component_notes" text,
  -- Slug of the same model's magnet-free variant, when the manufacturer
  -- ships one. Lets the engine offer a same-model non-magnetic swap
  -- instead of pushing the patient to a different mask entirely.
  "magnet_free_variant_slug" text,
  "pressure_min_cm_h2o" numeric(4, 1),
  "pressure_max_cm_h2o" numeric(4, 1),
  "supports_supplemental_oxygen" boolean,
  -- "Minimal contact" (under-nose cradle, pillows, tube-up frames) vs
  -- traditional. A first-class patient preference in the fit profile.
  "minimal_contact" boolean NOT NULL DEFAULT false,
  -- True when the seal sits UNDER the nose rather than across the bridge
  -- (nasal pillows, cradles, and under-nose full face masks). Clinically
  -- load-bearing: the nasal bridge is where CPAP pressure sores start, so
  -- a patient reporting bridge skin breakdown needs exactly this class of
  -- mask. Kept separate from minimal_contact because the two do not
  -- coincide — an under-nose FULL FACE mask avoids the bridge while still
  -- covering the mouth.
  "avoids_nasal_bridge" boolean NOT NULL DEFAULT false,
  "hose_position" text,
  -- Structured tolerance ratings, replacing substring matching on
  -- free-text contraindication strings for the SOFT factors. Hard
  -- exclusions live in mask_contraindications.
  "facial_hair_tolerance" text,
  "side_sleeping_tolerance" text,
  "claustrophobia_tolerance" text,
  "glasses_compatible" boolean,
  "cushion_material" text,
  "headgear_style" text,
  "weight_grams" integer,
  "description" text,
  "image_url" text,
  -- Lifecycle. A discontinued model stays in the catalog so historical
  -- fittings still resolve and so the successor can be suggested.
  "status" text NOT NULL DEFAULT 'current',
  "discontinued_on" date,
  "successor_slug" text,
  -- Manufacturer fitting instructions + the version we captured, so a
  -- fit report can cite exactly which revision was in force.
  "fitting_instructions_url" text,
  "fitting_instructions_version" text,
  "fitting_instructions_version_date" date,
  -- Provenance of the geometry in mask_size_variants. 'manufacturer' =
  -- from a published fitting guide; 'measured' = we measured a physical
  -- sample; 'estimated' = clinically-reasoned default pending review.
  "fit_data_source" text NOT NULL DEFAULT 'estimated',
  "needs_clinical_review" boolean NOT NULL DEFAULT true,
  "reviewed_by_email" text,
  "reviewed_at" timestamp with time zone,
  -- Bumped on every substantive edit; stamped into fit reports.
  "catalog_version" integer NOT NULL DEFAULT 1,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "mask_models_interface_type_chk"
    CHECK ("interface_type" IN (
      'nasal', 'nasal_pillow', 'nasal_cradle', 'hybrid',
      'full_face', 'total_face', 'oral'
    )),
  CONSTRAINT "mask_models_service_line_chk"
    CHECK ("service_line" IN ('adult', 'pediatric', 'both')),
  CONSTRAINT "mask_models_vented_chk"
    CHECK ("vented" IN ('vented', 'non_vented', 'both')),
  CONSTRAINT "mask_models_hose_position_chk"
    CHECK ("hose_position" IS NULL
           OR "hose_position" IN ('front', 'top', 'side')),
  CONSTRAINT "mask_models_facial_hair_tolerance_chk"
    CHECK ("facial_hair_tolerance" IS NULL
           OR "facial_hair_tolerance" IN ('poor', 'fair', 'good')),
  CONSTRAINT "mask_models_side_sleeping_tolerance_chk"
    CHECK ("side_sleeping_tolerance" IS NULL
           OR "side_sleeping_tolerance" IN ('poor', 'fair', 'good')),
  CONSTRAINT "mask_models_claustrophobia_tolerance_chk"
    CHECK ("claustrophobia_tolerance" IS NULL
           OR "claustrophobia_tolerance" IN ('poor', 'fair', 'good')),
  CONSTRAINT "mask_models_status_chk"
    CHECK ("status" IN ('current', 'discontinued', 'pre_release')),
  CONSTRAINT "mask_models_fit_data_source_chk"
    CHECK ("fit_data_source" IN ('manufacturer', 'measured', 'estimated')),
  CONSTRAINT "mask_models_therapy_modes_chk"
    CHECK ("therapy_modes" <@ ARRAY['pap', 'niv']::text[]
           AND array_length("therapy_modes", 1) >= 1),
  CONSTRAINT "mask_models_pressure_range_chk"
    CHECK ("pressure_min_cm_h2o" IS NULL
           OR "pressure_max_cm_h2o" IS NULL
           OR "pressure_min_cm_h2o" <= "pressure_max_cm_h2o")
);
--> statement-breakpoint

-- Platform rows: one row per slug, globally.
CREATE UNIQUE INDEX IF NOT EXISTS "mask_models_platform_slug_idx"
  ON "resupply"."mask_models" ("slug")
  WHERE "org_id" IS NULL;
--> statement-breakpoint

-- Tenant-private rows: one row per slug per tenant, so two tenants can
-- each carry their own private model without colliding. Leads with org_id
-- per the 0476-0480 lesson.
CREATE UNIQUE INDEX IF NOT EXISTS "mask_models_org_slug_idx"
  ON "resupply"."mask_models" ("org_id", "slug")
  WHERE "org_id" IS NOT NULL;
--> statement-breakpoint

-- The engine's hot path: load every current model visible to a tenant.
CREATE INDEX IF NOT EXISTS "mask_models_visibility_idx"
  ON "resupply"."mask_models" ("org_id", "status", "interface_type");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "mask_models_manufacturer_idx"
  ON "resupply"."mask_models" ("manufacturer", "model_name");
--> statement-breakpoint

-- The clinical-review queue in the catalog admin page.
CREATE INDEX IF NOT EXISTS "mask_models_review_queue_idx"
  ON "resupply"."mask_models" ("needs_clinical_review", "manufacturer")
  WHERE "needs_clinical_review" = true;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- mask_size_variants — per-size millimetre bands.
-- ---------------------------------------------------------------
-- The single biggest gap this migration closes. Today sizing is a linear
-- partition of the model's OVERALL fit range into N equal buckets, which
-- is a stopgap and documented as one. Here each size carries its own
-- bands, and cushion vs frame are separate component rows so the engine
-- can recommend "AirFit F20, Medium cushion, Standard frame".
--
-- Every band is nullable: a nasal pillow is gated by nostril/nose width
-- and says nothing about nose-to-chin, while a full face is the reverse.
-- A NULL band means "this dimension does not gate this size" and the
-- engine skips it rather than treating it as a failed match.
CREATE TABLE IF NOT EXISTS "resupply"."mask_size_variants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mask_model_id" uuid NOT NULL
    REFERENCES "resupply"."mask_models"("id") ON DELETE CASCADE,
  "component" text NOT NULL DEFAULT 'cushion',
  -- Short code as the manufacturer prints it ('S', 'M', 'L', 'SW', 'LW').
  "size_code" text NOT NULL,
  "size_label" text NOT NULL,
  "sort_order" integer NOT NULL DEFAULT 0,
  "nose_width_min_mm" numeric(5, 1),
  "nose_width_max_mm" numeric(5, 1),
  "nose_height_min_mm" numeric(5, 1),
  "nose_height_max_mm" numeric(5, 1),
  "nose_to_chin_min_mm" numeric(5, 1),
  "nose_to_chin_max_mm" numeric(5, 1),
  "mouth_width_min_mm" numeric(5, 1),
  "mouth_width_max_mm" numeric(5, 1),
  "face_width_min_mm" numeric(5, 1),
  "face_width_max_mm" numeric(5, 1),
  "nostril_width_min_mm" numeric(5, 1),
  "nostril_width_max_mm" numeric(5, 1),
  "is_default" boolean NOT NULL DEFAULT false,
  "hcpcs_code" text REFERENCES "resupply"."hcpcs_codes"("code"),
  "manufacturer_part_number" text,
  "status" text NOT NULL DEFAULT 'current',
  "fit_data_source" text NOT NULL DEFAULT 'estimated',
  "needs_clinical_review" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "mask_size_variants_component_chk"
    CHECK ("component" IN (
      'cushion', 'frame', 'pillow', 'headgear', 'full_assembly'
    )),
  CONSTRAINT "mask_size_variants_status_chk"
    CHECK ("status" IN ('current', 'discontinued')),
  CONSTRAINT "mask_size_variants_fit_data_source_chk"
    CHECK ("fit_data_source" IN ('manufacturer', 'measured', 'estimated'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "mask_size_variants_model_component_size_idx"
  ON "resupply"."mask_size_variants"
     ("mask_model_id", "component", "size_code");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "mask_size_variants_model_idx"
  ON "resupply"."mask_size_variants"
     ("mask_model_id", "component", "sort_order");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "mask_size_variants_review_queue_idx"
  ON "resupply"."mask_size_variants" ("needs_clinical_review")
  WHERE "needs_clinical_review" = true;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- mask_components — replacement parts + payer replacement categories.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "resupply"."mask_components" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mask_model_id" uuid NOT NULL
    REFERENCES "resupply"."mask_models"("id") ON DELETE CASCADE,
  "component_type" text NOT NULL,
  "name" text NOT NULL,
  "hcpcs_code" text REFERENCES "resupply"."hcpcs_codes"("code"),
  -- Free-text payer bucket ('cushion', 'full mask', 'headgear') for
  -- payers whose replacement schedule does not map 1:1 to HCPCS.
  "payer_replacement_category" text,
  "manufacturer_part_number" text,
  -- Overrides hcpcs_codes.min_interval_days when a payer or the
  -- manufacturer specifies something different. NULL = use the HCPCS row.
  "replacement_interval_days" integer,
  "status" text NOT NULL DEFAULT 'current',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "mask_components_component_type_chk"
    CHECK ("component_type" IN (
      'cushion', 'pillow', 'frame', 'headgear', 'elbow',
      'tube', 'clip', 'filter', 'chinstrap'
    )),
  CONSTRAINT "mask_components_status_chk"
    CHECK ("status" IN ('current', 'discontinued'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "mask_components_model_idx"
  ON "resupply"."mask_components" ("mask_model_id", "component_type");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "mask_components_hcpcs_idx"
  ON "resupply"."mask_components" ("hcpcs_code")
  WHERE "hcpcs_code" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- mask_component_compatibility — "which frames does this cushion fit".
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "resupply"."mask_component_compatibility" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "component_id" uuid NOT NULL
    REFERENCES "resupply"."mask_components"("id") ON DELETE CASCADE,
  "compatible_mask_model_id" uuid NOT NULL
    REFERENCES "resupply"."mask_models"("id") ON DELETE CASCADE,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "mask_component_compatibility_pair_idx"
  ON "resupply"."mask_component_compatibility"
     ("component_id", "compatible_mask_model_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "mask_component_compatibility_model_idx"
  ON "resupply"."mask_component_compatibility" ("compatible_mask_model_id");
--> statement-breakpoint

-- ---------------------------------------------------------------
-- mask_contraindications — structured clinical exclusions.
-- ---------------------------------------------------------------
-- Replaces `contraindications: string[]` matched with
-- `lower.includes("mouth breath")`. A structured factor + severity means
-- the engine can HARD FILTER on safety (severity='exclude') instead of
-- applying a 0.15 multiplier that a commercial boost could out-score.
CREATE TABLE IF NOT EXISTS "resupply"."mask_contraindications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mask_model_id" uuid NOT NULL
    REFERENCES "resupply"."mask_models"("id") ON DELETE CASCADE,
  "factor" text NOT NULL,
  -- 'exclude' = tier-1 hard filter, nothing downstream can re-admit it.
  -- 'caution' = scoring penalty plus a caveat printed on the fit report.
  "severity" text NOT NULL DEFAULT 'caution',
  -- Plain-language reason, shown to the patient and printed in the report.
  "rationale" text NOT NULL,
  "source" text NOT NULL DEFAULT 'clinical_policy',
  "version_date" date,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "mask_contraindications_factor_chk"
    CHECK ("factor" IN (
      'mouth_breathing', 'nasal_obstruction', 'claustrophobia',
      'facial_hair', 'dentures', 'skin_breakdown', 'high_pressure',
      'supplemental_oxygen', 'magnet_implant_patient',
      'magnet_implant_household', 'niv_vented_mismatch',
      'hand_dexterity', 'side_sleeping', 'vision_cognitive',
      'pediatric_service_line'
    )),
  CONSTRAINT "mask_contraindications_severity_chk"
    CHECK ("severity" IN ('exclude', 'caution')),
  CONSTRAINT "mask_contraindications_source_chk"
    CHECK ("source" IN ('manufacturer_ifu', 'clinical_policy'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "mask_contraindications_model_factor_idx"
  ON "resupply"."mask_contraindications" ("mask_model_id", "factor");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "mask_contraindications_severity_idx"
  ON "resupply"."mask_contraindications" ("severity", "factor");
