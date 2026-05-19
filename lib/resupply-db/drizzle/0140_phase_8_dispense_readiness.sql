-- 0140_phase_8_dispense_readiness — AI-driven pre-dispense readiness
-- reviewer.
--
-- Why
-- ---
-- The existing claim_preflight surface answers "can I bill this
-- claim?" — but the question CSRs actually ask before shipping a
-- product is "is everything in place to dispense this to the
-- patient?" That's a broader gate covering insurance + clinical
-- documentation + provider + prior auth + forms + DME-org
-- compliance + capped-rental status + equipment recall + patient
-- acknowledgments. The reviewer runs all of those checks, then
-- asks the LLM to synthesize a plain-English action plan listing
-- exactly what's missing and how to obtain it.
--
-- One row per review run. The route is fire-on-demand — the CSR
-- triggers it when they're about to dispense, or the auto-workflow
-- engine fires it when a new fulfillment is created.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."dispense_readiness_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  -- The HCPCS being readied. Some checks branch on this (e.g. PA
  -- requirement applies only to specific HCPCS families).
  "hcpcs_code" varchar(12) NOT NULL,
  -- Optional pointer to the fulfillment row triggering the review.
  "fulfillment_id" uuid
    REFERENCES "resupply"."fulfillments"("id") ON DELETE SET NULL,
  -- Optional pre-resolved payer + coverage; route falls back to
  -- patient.primary if null.
  "payer_profile_id" uuid
    REFERENCES "resupply"."payer_profiles"("id") ON DELETE SET NULL,
  "insurance_coverage_id" uuid
    REFERENCES "resupply"."insurance_coverages"("id") ON DELETE SET NULL,

  -- ── Overall verdict ──
  "ready_to_dispense" boolean NOT NULL,
  "overall_verdict" text NOT NULL,
  -- LLM-supplied estimate of how long until the gaps could be
  -- closed (assuming the action plan is followed). Null when the
  -- AI couldn't estimate or there were no gaps.
  "estimated_days_to_ready" integer,

  -- ── Deterministic-check output ──
  -- Array of { key, severity, label, detail, category, fixAction? }.
  -- Same shape as the existing claim_preflight findings; the AI
  -- synthesizer reads this verbatim.
  "deterministic_findings_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "checks_total" integer NOT NULL DEFAULT 0,
  "checks_passed" integer NOT NULL DEFAULT 0,
  "checks_warning" integer NOT NULL DEFAULT 0,
  "checks_failed" integer NOT NULL DEFAULT 0,

  -- ── AI synthesis output ──
  -- One-paragraph human summary. Safe to surface verbatim to CSRs.
  "ai_summary" text,
  -- Structured action plan:
  --   [{ priority: 1..N, action, how_to_obtain, owner_role,
  --      estimated_days, blocks_dispense }]
  "ai_action_plan_json" jsonb,
  -- LLM ops metadata.
  "ai_model" varchar(80),
  "ai_prompt_version" varchar(20),
  "ai_confidence" real,
  "ai_latency_ms" integer,
  "ai_prompt_tokens" integer,
  "ai_completion_tokens" integer,
  "ai_error_message" text,

  -- CSR review state.
  "review_status" text NOT NULL DEFAULT 'pending',
  "reviewed_by_email" varchar(180),
  "reviewed_at" timestamp with time zone,

  "created_by_email" varchar(180) NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "dispense_readiness_overall_verdict_enum"
    CHECK ("overall_verdict" IN (
      'ready', 'gaps_with_fixable', 'gaps_with_blocking', 'errored'
    )),
  CONSTRAINT "dispense_readiness_review_status_enum"
    CHECK ("review_status" IN (
      'pending', 'acknowledged', 'remediated', 'overridden', 'cancelled'
    )),
  CONSTRAINT "dispense_readiness_confidence_range"
    CHECK (
      "ai_confidence" IS NULL
      OR ("ai_confidence" >= 0 AND "ai_confidence" <= 1)
    ),
  CONSTRAINT "dispense_readiness_estimated_days_nonneg"
    CHECK ("estimated_days_to_ready" IS NULL OR "estimated_days_to_ready" >= 0)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "dispense_readiness_patient_idx"
  ON "resupply"."dispense_readiness_reviews"
  ("patient_id", "created_at" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "dispense_readiness_pending_idx"
  ON "resupply"."dispense_readiness_reviews"
  ("review_status", "created_at" DESC)
  WHERE "review_status" = 'pending';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "dispense_readiness_verdict_idx"
  ON "resupply"."dispense_readiness_reviews"
  ("overall_verdict", "created_at" DESC)
  WHERE "overall_verdict" IN ('gaps_with_fixable', 'gaps_with_blocking');
