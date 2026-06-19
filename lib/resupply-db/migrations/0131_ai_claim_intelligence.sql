-- 0131_ai_claim_intelligence — persist AI-driven claim scrub +
-- denial-analysis results so they are auditable, replayable, and
-- non-blocking when the LLM is unavailable.
--
-- Why
-- ---
-- Two new automation surfaces land in this sprint:
--
--   1. AI claim scrub  (pre-submission) — runs against every draft
--      claim, identifies missing-or-wrong data the deterministic
--      preflight engine can't catch (HCPCS-diagnosis pairing per
--      LCD, modifier-correctness, payer-specific gotchas), and
--      suggests structured patches the CSR can one-click apply.
--
--   2. AI denial analyzer (post-denial) — reads the CARC/RARC codes
--      on a denied claim + the catalog's recommended_action +
--      patient context, returns a root-cause summary, an actionable
--      fix plan, and (when the fix is mechanical) a patch the
--      auto-resubmit endpoint can apply before resubmitting.
--
-- Both surfaces store their output verbatim so:
--   * we can A/B prompts without losing prior analyses,
--   * the CSR can see the model's reasoning when they accept / reject
--     a suggested patch,
--   * the audit can prove "the AI suggested X on date Y, CSR
--     accepted/rejected on date Z" without re-running the model.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ────────────────────────────────────────────────────────────────────
-- 1. claim_scrub_results — per-claim AI scrub runs.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."claim_scrub_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "claim_id" uuid NOT NULL
    REFERENCES "resupply"."insurance_claims"("id") ON DELETE CASCADE,
  -- Overall verdict — drives the UI badge color and whether the
  -- submit endpoint should block.
  "verdict" text NOT NULL,
  -- Model id used for the run; lets us replay an analysis against a
  -- newer model and diff. Stored opaque so a model swap (gpt-5,
  -- claude-4, etc.) doesn't require a schema change.
  "model" varchar(80) NOT NULL,
  -- Prompt version (semver-ish) so we can correlate verdict drift
  -- with prompt edits.
  "prompt_version" varchar(20) NOT NULL,
  -- Confidence score the model assigned to its own verdict (0..1).
  "confidence" real,
  -- Structured findings the UI renders as a checklist.
  --   { "findings": [{ "key": ..., "severity": ..., "problem": ..., "recommended_fix": ... }],
  --     "summary": "..." }
  "findings_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Structured patches the auto-apply endpoint executes. Whitelisted
  -- by lib/billing/ai-patch-applier.ts; an unknown patch shape is
  -- ignored so a hallucinated kind never mutates the DB.
  "suggested_patches_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- CSR review state once a human looks at the run.
  "review_status" text NOT NULL DEFAULT 'pending',
  "reviewed_by_email" varchar(180),
  "reviewed_at" timestamp with time zone,
  -- Auto-apply log: array of { patch_index, outcome, error } so the
  -- audit can show which patches landed vs were rejected.
  "applied_patches_log" jsonb,
  "applied_at" timestamp with time zone,
  -- Latency + token counts for ops cost tracking.
  "latency_ms" integer,
  "prompt_tokens" integer,
  "completion_tokens" integer,
  -- Free-form failure message when status='errored'.
  "error_message" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "claim_scrub_results_verdict_enum"
    CHECK ("verdict" IN ('ready', 'fixable', 'blocking', 'errored')),
  CONSTRAINT "claim_scrub_results_review_status_enum"
    CHECK ("review_status" IN ('pending', 'accepted', 'rejected', 'auto_applied'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "claim_scrub_results_claim_idx"
  ON "resupply"."claim_scrub_results" ("claim_id", "created_at" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "claim_scrub_results_pending_idx"
  ON "resupply"."claim_scrub_results" ("review_status", "created_at" DESC)
  WHERE "review_status" = 'pending';
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 2. claim_denial_analyses — per-claim AI denial analyses.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."claim_denial_analyses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "claim_id" uuid NOT NULL
    REFERENCES "resupply"."insurance_claims"("id") ON DELETE CASCADE,
  "era_file_id" uuid
    REFERENCES "resupply"."era_files"("id") ON DELETE SET NULL,
  "model" varchar(80) NOT NULL,
  "prompt_version" varchar(20) NOT NULL,
  "confidence" real,
  -- Short human-readable rationale the AI extracted from the CARC/RARC
  -- codes + payer context. Surfaced inline on the denied-claim card.
  "root_cause_summary" text NOT NULL,
  -- Recommendation: should the CSR resubmit, appeal, write off, or
  -- bill the patient?
  "recommendation" text NOT NULL,
  -- Structured analysis JSON:
  --   { "mapped_codes": [{"code": "27", "system": "carc", "category": "...",
  --                       "explanation": "..."}],
  --     "fix_steps":    [{"step": "...", "field_path": "...",
  --                       "new_value": "..."}],
  --     "appeal_letter_sketch": "..." }
  "analysis_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Structured patches the auto-resubmit endpoint applies. Same
  -- whitelist contract as claim_scrub_results.suggested_patches_json.
  "suggested_patches_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- True iff the patches are safe enough that auto-resubmit may run
  -- without further CSR review. The route still requires a human
  -- one-click action; this column gates the "auto-resubmit" button.
  "can_auto_resubmit" boolean NOT NULL DEFAULT false,
  -- CSR review state.
  "review_status" text NOT NULL DEFAULT 'pending',
  "reviewed_by_email" varchar(180),
  "reviewed_at" timestamp with time zone,
  "applied_at" timestamp with time zone,
  -- Tracks the resubmit flow.
  "resubmit_office_ally_submission_id" uuid
    REFERENCES "resupply"."office_ally_submissions"("id") ON DELETE SET NULL,
  "latency_ms" integer,
  "prompt_tokens" integer,
  "completion_tokens" integer,
  "error_message" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "claim_denial_analyses_recommendation_enum"
    CHECK ("recommendation" IN (
      'auto_resubmit',
      'manual_resubmit',
      'appeal',
      'bill_patient',
      'write_off',
      'manual_review'
    )),
  CONSTRAINT "claim_denial_analyses_review_status_enum"
    CHECK ("review_status" IN (
      'pending',
      'accepted_resubmitted',
      'accepted_appealed',
      'accepted_written_off',
      'rejected',
      'errored'
    ))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "claim_denial_analyses_claim_idx"
  ON "resupply"."claim_denial_analyses" ("claim_id", "created_at" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "claim_denial_analyses_pending_idx"
  ON "resupply"."claim_denial_analyses" ("review_status", "created_at" DESC)
  WHERE "review_status" = 'pending';
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 3. ALTER insurance_claims — surface latest AI status.
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE "resupply"."insurance_claims"
  -- Latest scrub verdict, denormalised so the CSR queue can filter
  -- "blocking" claims without joining claim_scrub_results.
  ADD COLUMN IF NOT EXISTS "latest_scrub_verdict" text,
  ADD COLUMN IF NOT EXISTS "latest_scrub_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "latest_scrub_result_id" uuid
    REFERENCES "resupply"."claim_scrub_results"("id") ON DELETE SET NULL,
  -- Latest denial-analysis pointer.
  ADD COLUMN IF NOT EXISTS "latest_denial_analysis_id" uuid
    REFERENCES "resupply"."claim_denial_analyses"("id") ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "resupply"."insurance_claims"
  DROP CONSTRAINT IF EXISTS "insurance_claims_latest_scrub_verdict_enum";
--> statement-breakpoint

ALTER TABLE "resupply"."insurance_claims"
  ADD CONSTRAINT "insurance_claims_latest_scrub_verdict_enum"
    CHECK (
      "latest_scrub_verdict" IS NULL
      OR "latest_scrub_verdict" IN ('ready', 'fixable', 'blocking', 'errored')
    );
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "insurance_claims_scrub_verdict_idx"
  ON "resupply"."insurance_claims" ("latest_scrub_verdict", "updated_at" DESC)
  WHERE "latest_scrub_verdict" IS NOT NULL;
