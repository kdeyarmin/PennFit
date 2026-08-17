-- 0482_mask_formulary — a DME's own mask formulary, across every axis.
--
-- Why
-- ---
-- The catalog (0481) is what EXISTS. The formulary is what a given DME
-- actually dispenses — and that differs by branch, by payer, by contract,
-- by what's on the shelf, by adult vs pediatric service line, and by
-- whether the patient is on PAP or NIV. Today none of that is
-- expressible: the recommendation engine carries a single hardcoded
-- `MANUFACTURER_BOOST = { "React Health": 1.15 }` that applies to every
-- tenant, forever.
--
-- Model
-- -----
--   formularies        — a versioned container. Exactly ONE active per
--                        tenant (partial unique index), which is what
--                        makes "formulary version" a single stampable
--                        value on a fit report.
--   formulary_rules    — scope × target × effect. Every scope axis is
--                        nullable and NULL means "any".
--   mask_availability  — inventory, kept separate because it changes on a
--                        sync cadence, not a deliberate-config cadence.
--
-- Resolution semantics (implemented in lib/fitting/formulary.ts, and the
-- reason this header is long — this is the part that is easy to get
-- subtly wrong):
--
--   1. A rule APPLIES iff, for EVERY scope axis, `rule.axis IS NULL OR
--      rule.axis = context.axis`, and today falls inside
--      [effective_from, effective_to].
--
--      Corollary that matters clinically: a rule with a non-null axis
--      does NOT apply when that context value is unknown. If we don't
--      know the payer, a payer-specific deny does not fire. We never
--      deny on an assumption.
--
--   2. SCOPE SPECIFICITY = sum of fixed weights over the non-null axes:
--        contract_ref 16 > payer_profile_id 8 > location_id 4
--        > therapy_mode 2 > service_line 1
--      Powers of two, so the sum is an unambiguous total ordering.
--      Ranked that way because a contract term is a legal obligation,
--      payer coverage outranks internal stocking preference, and a
--      branch's shelf outranks a therapy/population default.
--
--   3. TARGET SPECIFICITY: size_variant 4 > mask_model 3
--        > interface_type 2 > manufacturer 1.
--
--   4. AVAILABILITY: among applicable allow/deny rules, find the highest
--      (scopeSpecificity, targetSpecificity) tier at which any exists.
--      WITHIN THAT TIER, DENY BEATS ALLOW. No allow/deny rule at any
--      tier → the formulary's `default_posture`.
--
--      One sentence: the most specific applicable scope wins; within
--      equally-specific scopes the most specific target wins; within an
--      identical tier, deny beats allow.
--
--   5. PREFERENCE: exactly ONE rule contributes — the highest
--      (scopeSpecificity, targetSpecificity, created_at DESC) among
--      applicable 'prefer'/'deprioritize' rules. Preference never stacks,
--      so it can never compound past its bound.
--
-- THE INVARIANT THAT MATTERS MOST
-- ------------------------------
-- A formulary decision is a PROVIDER-PREFERENCE signal, evaluated at
-- tier 5 of the recommendation hierarchy — strictly below safety (1),
-- therapy compatibility (2), facial fit (3), and patient characteristics
-- (4). The resolver is handed ONLY the candidates that already survived
-- tiers 1-2, so a formulary `allow`/`prefer` can never resurrect a
-- clinical or safety exclusion. And a formulary `deny` never removes a
-- mask outright: it demotes and tags it, so that when tiers 1-4 leave
-- only out-of-formulary options the engine still surfaces the best one,
-- flagged, for a clinician to decide. Inventory behaves the same way —
-- out of stock annotates, never excludes.
--
-- That is the mechanical implementation of "financial margin must never
-- override a clinical or safety exclusion", and it is enforced by
-- construction (what the resolver is given) rather than by convention.
--
-- PHI: none. Formulary configuration is business data.
--
-- Per ADR 003 — versioned hand-authored migration. Tenant-scoped via
-- org_id (auto-tagged by the org-scoped Supabase client on every insert).

-- ---------------------------------------------------------------
-- formularies — the versioned container.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "resupply"."formularies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),
  "name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  -- 'open'   = anything in the catalog is dispensable unless denied.
  --            The default, and what every existing tenant gets, so
  --            behaviour is unchanged until somebody writes a rule.
  -- 'closed' = only explicitly allowed masks are dispensable. This is
  --            the "custom formulary" lever — a closed formulary plus
  --            one `allow manufacturer='ResMed'` rule is a complete
  --            single-vendor formulary.
  "default_posture" text NOT NULL DEFAULT 'open',
  -- Bumped on publish. Stamped onto every fit_sessions row and printed
  -- on every fit report, so a report reprinted a year later names the
  -- formulary revision that actually ran.
  "version" integer NOT NULL DEFAULT 1,
  "published_at" timestamp with time zone,
  "published_by_email" text,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "formularies_status_chk"
    CHECK ("status" IN ('draft', 'active', 'archived')),
  CONSTRAINT "formularies_default_posture_chk"
    CHECK ("default_posture" IN ('open', 'closed')),
  CONSTRAINT "formularies_name_chk"
    CHECK (length(btrim("name")) > 0)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "formularies_org_name_idx"
  ON "resupply"."formularies" ("org_id", "name");
--> statement-breakpoint

-- Exactly one active formulary per tenant. This is what lets a fit
-- report carry a single unambiguous "formulary version".
CREATE UNIQUE INDEX IF NOT EXISTS "formularies_org_single_active_idx"
  ON "resupply"."formularies" ("org_id")
  WHERE "status" = 'active';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "formularies_org_status_idx"
  ON "resupply"."formularies" ("org_id", "status", "updated_at" DESC);
--> statement-breakpoint

-- ---------------------------------------------------------------
-- formulary_rules — scope x target x effect.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "resupply"."formulary_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),
  "formulary_id" uuid NOT NULL
    REFERENCES "resupply"."formularies"("id") ON DELETE CASCADE,

  -- ── Scope axes. All nullable; NULL = "any". ──
  "location_id" uuid
    REFERENCES "resupply"."locations"("id") ON DELETE CASCADE,
  "payer_profile_id" uuid
    REFERENCES "resupply"."payer_profiles"("id") ON DELETE CASCADE,
  "contract_ref" text,
  "service_line" text,
  "therapy_mode" text,

  -- ── Target. Exactly one of the four target columns is populated,
  --    matching target_kind (one-hot, enforced below). ──
  "target_kind" text NOT NULL,
  "target_manufacturer" text,
  "target_interface_type" text,
  "target_mask_model_id" uuid
    REFERENCES "resupply"."mask_models"("id") ON DELETE CASCADE,
  "target_size_variant_id" uuid
    REFERENCES "resupply"."mask_size_variants"("id") ON DELETE CASCADE,

  -- ── Effect. ──
  "effect" text NOT NULL,
  -- 1 = most preferred. Required for 'prefer', meaningless otherwise.
  "preference_rank" integer,
  -- Coarse machine-readable reason, safe to show a clinician.
  "reason_code" text,
  -- Free-text internal note. STAFF-VISIBLE ONLY — redacted from every
  -- patient-facing surface, because "we make more margin on this one"
  -- is not something a patient should read.
  "reason_note" text,
  "effective_from" date,
  "effective_to" date,
  "created_by_email" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "formulary_rules_target_kind_chk"
    CHECK ("target_kind" IN (
      'manufacturer', 'interface_type', 'mask_model', 'size_variant', 'all'
    )),
  CONSTRAINT "formulary_rules_effect_chk"
    CHECK ("effect" IN ('allow', 'deny', 'prefer', 'deprioritize')),
  CONSTRAINT "formulary_rules_service_line_chk"
    CHECK ("service_line" IS NULL
           OR "service_line" IN ('adult', 'pediatric')),
  CONSTRAINT "formulary_rules_therapy_mode_chk"
    CHECK ("therapy_mode" IS NULL OR "therapy_mode" IN ('pap', 'niv')),
  -- One-hot: the populated target column must match target_kind.
  CONSTRAINT "formulary_rules_target_onehot_chk"
    CHECK (
      ("target_kind" = 'manufacturer'
        AND "target_manufacturer" IS NOT NULL
        AND "target_interface_type" IS NULL
        AND "target_mask_model_id" IS NULL
        AND "target_size_variant_id" IS NULL)
      OR ("target_kind" = 'interface_type'
        AND "target_manufacturer" IS NULL
        AND "target_interface_type" IS NOT NULL
        AND "target_mask_model_id" IS NULL
        AND "target_size_variant_id" IS NULL)
      OR ("target_kind" = 'mask_model'
        AND "target_manufacturer" IS NULL
        AND "target_interface_type" IS NULL
        AND "target_mask_model_id" IS NOT NULL
        AND "target_size_variant_id" IS NULL)
      OR ("target_kind" = 'size_variant'
        AND "target_manufacturer" IS NULL
        AND "target_interface_type" IS NULL
        AND "target_mask_model_id" IS NULL
        AND "target_size_variant_id" IS NOT NULL)
      OR ("target_kind" = 'all'
        AND "target_manufacturer" IS NULL
        AND "target_interface_type" IS NULL
        AND "target_mask_model_id" IS NULL
        AND "target_size_variant_id" IS NULL)
    ),
  CONSTRAINT "formulary_rules_preference_rank_chk"
    CHECK ("effect" <> 'prefer' OR "preference_rank" IS NOT NULL),
  CONSTRAINT "formulary_rules_effective_window_chk"
    CHECK ("effective_from" IS NULL
           OR "effective_to" IS NULL
           OR "effective_from" <= "effective_to")
);
--> statement-breakpoint

-- The resolver's load: every rule in one formulary, for one tenant.
CREATE INDEX IF NOT EXISTS "formulary_rules_org_formulary_idx"
  ON "resupply"."formulary_rules" ("org_id", "formulary_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "formulary_rules_org_model_idx"
  ON "resupply"."formulary_rules"
     ("org_id", "formulary_id", "target_mask_model_id")
  WHERE "target_mask_model_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "formulary_rules_org_manufacturer_idx"
  ON "resupply"."formulary_rules"
     ("org_id", "formulary_id", "target_manufacturer")
  WHERE "target_manufacturer" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "formulary_rules_org_payer_idx"
  ON "resupply"."formulary_rules"
     ("org_id", "formulary_id", "payer_profile_id")
  WHERE "payer_profile_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "formulary_rules_org_location_idx"
  ON "resupply"."formulary_rules"
     ("org_id", "formulary_id", "location_id")
  WHERE "location_id" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- mask_availability — the inventory axis.
-- ---------------------------------------------------------------
-- Separate from formulary_rules on purpose: this changes nightly from a
-- stock sync, while rules change deliberately when an operator edits
-- them. Availability NEVER excludes a mask — it demotes it inside tier 6
-- and annotates the recommendation ("recommended; currently out of stock
-- at your location"). `margin_rank` is a coarse 1-5 bucket rather than a
-- dollar figure precisely so that money can shade a tie-break and can
-- never become the dominant term.
CREATE TABLE IF NOT EXISTS "resupply"."mask_availability" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),
  -- NULL = applies org-wide.
  "location_id" uuid
    REFERENCES "resupply"."locations"("id") ON DELETE CASCADE,
  "mask_model_id" uuid NOT NULL
    REFERENCES "resupply"."mask_models"("id") ON DELETE CASCADE,
  -- NULL = model-level availability (all sizes).
  "size_variant_id" uuid
    REFERENCES "resupply"."mask_size_variants"("id") ON DELETE CASCADE,
  "availability" text NOT NULL DEFAULT 'unknown',
  "on_hand_qty" integer,
  "lead_time_days" integer,
  -- Coarse 1 (worst) .. 5 (best) margin bucket. Never a raw amount.
  "margin_rank" integer,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "mask_availability_availability_chk"
    CHECK ("availability" IN (
      'in_stock', 'low', 'out', 'special_order', 'not_stocked', 'unknown'
    )),
  CONSTRAINT "mask_availability_margin_rank_chk"
    CHECK ("margin_rank" IS NULL
           OR ("margin_rank" >= 1 AND "margin_rank" <= 5))
);
--> statement-breakpoint

-- One availability row per (tenant, location, model, variant). NULLS NOT
-- DISTINCT so the org-wide (location_id NULL) and model-level
-- (size_variant_id NULL) rows are genuinely unique rather than
-- duplicable. Leads with org_id per the 0476-0480 lesson.
CREATE UNIQUE INDEX IF NOT EXISTS "mask_availability_scope_idx"
  ON "resupply"."mask_availability"
     ("org_id", "location_id", "mask_model_id", "size_variant_id")
  NULLS NOT DISTINCT;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "mask_availability_org_model_idx"
  ON "resupply"."mask_availability" ("org_id", "mask_model_id");
--> statement-breakpoint

-- ---------------------------------------------------------------
-- Seed: one open, active formulary per tenant.
-- ---------------------------------------------------------------
-- Every tenant gets a stampable formulary version from day one, and the
-- resolver never has to handle a null case. 'open' posture with zero
-- rules is exactly today's behaviour, so no existing tenant changes.
INSERT INTO "resupply"."formularies"
  ("org_id", "name", "status", "default_posture", "version", "notes")
SELECT
  o."id",
  'Default formulary',
  'active',
  'open',
  1,
  'Auto-created by migration 0482. Open posture with no rules behaves '
  || 'exactly like the pre-formulary engine: every catalog mask is '
  || 'dispensable. Add rules to shape it.'
FROM "resupply"."organizations" o
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- Seed: Penn's React Health stocking preference, as tenant DATA.
-- ---------------------------------------------------------------
-- This replaces the hardcoded MANUFACTURER_BOOST = { "React Health":
-- 1.15 } that lived in the recommendation engine and applied to EVERY
-- tenant. Same business outcome for Penn Home Medical Supply — a viable
-- React Health mask out-ranks an otherwise-equivalent peer — but now it
-- is (a) tenant-scoped, (b) operator-editable without a deploy, and
-- (c) evaluated at tier 5, strictly below every clinical tier, so it can
-- never rescue a clinically worse mask.
INSERT INTO "resupply"."formulary_rules"
  ("org_id", "formulary_id", "target_kind", "target_manufacturer",
   "effect", "preference_rank", "reason_code", "reason_note")
SELECT
  f."org_id",
  f."id",
  'manufacturer',
  'React Health',
  'prefer',
  1,
  'preferred_vendor',
  'Migrated from the engine-level React Health boost (migration 0482). '
  || 'Penn preferentially stocks the React Health line.'
FROM "resupply"."formularies" f
JOIN "resupply"."organizations" o ON o."id" = f."org_id"
WHERE o."slug" = 'penn-home-medical'
  AND f."status" = 'active'
  -- formulary_rules has no natural unique key (a tenant may legitimately
  -- write several rules against the same manufacturer at different
  -- scopes), so idempotency comes from an explicit NOT EXISTS rather
  -- than ON CONFLICT.
  AND NOT EXISTS (
    SELECT 1 FROM "resupply"."formulary_rules" r
    WHERE r."formulary_id" = f."id"
      AND r."target_kind" = 'manufacturer'
      AND r."target_manufacturer" = 'React Health'
      AND r."effect" = 'prefer'
  );
