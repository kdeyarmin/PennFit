-- 0146_inbound_referral_preflight — Phase 3 of the inbound referral
-- roadmap.
--
-- Adds:
--   inbound_referral_preflight_checks — one row per pre-flight check
--   we ran on an inbound referral. The pre-flight library
--   (lib/inbound-dispatchers/preflight.ts) and its companion worker
--   (worker/jobs/inbound-referral-preflight.ts) emit these so a CSR
--   can see "does this payer need PA? has eligibility been verified?
--   are docs missing?" inline on the triage detail page without
--   re-running every check by hand.
--
-- Why a child table (vs. denormalised columns on inbound_referral_orders)
-- ---------------------------------------------------------------------
-- Pre-flight is iterative: the same referral runs PA-requirement once,
-- eligibility on demand when CSR confirms the patient match, and a
-- docs-gap re-scan when a new document arrives. Each check is its own
-- row with a timestamp + outcome blob — the CSR sees the history, not
-- just the latest snapshot.
--
-- check_kind values (enforced in the library, not the DB):
--   pa_requirement       — does this payer require PA for the HCPCS?
--   eligibility          — 270/271 round-trip outcome
--   docs_gap             — which clinical-doc kinds are missing
--   physician_fax_queued — physician_fax_outreach row was enqueued
--   pas_endpoint_available — payer has davinci_pas_endpoint_url set
--
-- Outcomes are jsonb so the library can iterate on the shape without
-- another migration.
--
-- Per ADR 003 — versioned hand-authored migration. New table; safe
-- to re-apply via IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "resupply"."inbound_referral_preflight_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "referral_id" uuid NOT NULL
    REFERENCES "resupply"."inbound_referral_orders"("id") ON DELETE CASCADE,
  -- Free-form classification (see header). Sized for headroom on
  -- future additions.
  "check_kind" varchar(40) NOT NULL,
  -- Outcome bag — shape per check_kind, documented in the library.
  -- Example pa_requirement:
  --   { "payer_profile_id": "uuid|null", "payer_slug": "highmark_bcbs_pa"|null,
  --     "requires_pa": true, "matched_payer_name": "Highmark Inc." }
  "outcome_json" jsonb NOT NULL,
  -- High-level pass/fail label so the queue list can colour-code
  -- without unpacking the jsonb on every row.
  "outcome_status" text NOT NULL DEFAULT 'info',
  -- Optional FK to the row a side-effecting check produced (e.g.
  -- physician_fax_outreach when docs_gap triggered a fax).
  "produced_row_table" varchar(80),
  "produced_row_id" uuid,
  -- Who ran it. 'system:cron:preflight' for the worker tick;
  -- admin email when a CSR hit "Run pre-flight now".
  "ran_by" varchar(180) NOT NULL DEFAULT 'system:cron:preflight',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "inbound_referral_preflight_outcome_status_enum"
    CHECK ("outcome_status" IN ('info', 'ok', 'warn', 'error', 'skipped'))
);
--> statement-breakpoint

-- The detail page wants "most recent check_kind per referral" — a
-- composite index drives that lookup cheaply.
CREATE INDEX IF NOT EXISTS "inbound_referral_preflight_referral_kind_idx"
  ON "resupply"."inbound_referral_preflight_checks"
  ("referral_id", "check_kind", "created_at" DESC);
--> statement-breakpoint

-- Stamp on inbound_referral_orders so the queue list page can show
-- a "preflight: not yet run | running | complete" badge without
-- joining to the checks table. NULL means "never ran".
ALTER TABLE "resupply"."inbound_referral_orders"
  ADD COLUMN IF NOT EXISTS "preflight_completed_at" timestamp with time zone;
