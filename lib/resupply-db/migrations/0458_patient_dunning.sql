-- 0458_patient_dunning — patient AR dunning / collections engine.
--
-- Why
-- ---
-- Today an unpaid patient-responsibility balance gets ONE statement
-- (billing-statement-send, consent + quiet-hours aware) and optional payment
-- plans / autopay. Nothing escalates when that statement goes unpaid, and
-- there is no structured hand-off to a collections agency. This adds a dunning
-- LADDER — statement → reminder → second notice → final notice → agency export
-- — driven by a worker on a cadence, that de-escalates the moment the balance
-- is paid or the patient goes onto a plan / autopay. The ladder timing +
-- channels live in code (@workspace/resupply-domain DEFAULT_DUNNING_POLICY) so
-- the decision logic is pure and tested; these tables hold the per-patient
-- run state + an append-only touch log.
--
-- Model
-- -----
--   * patient_dunning_runs   — one active run per patient balance cycle. The
--     current ladder step, when the next step is due, and the run status
--     (active / paused / resolved / cancelled) with a reason. opened_on anchors
--     the policy's cumulative day-offsets.
--   * patient_dunning_events — append-only log of every touch / state change
--     (step, channel, outcome, balance at touch). Reason codes only — no PHI.
--
-- Per ADR 003 — versioned hand-authored migration. Tenant-scoped via org_id.
-- The agency step never auto-sends: it flags the run for a reviewable export
-- (collections is a legal/reputational decision a human signs off on).

-- ────────────────────────────────────────────────────────────────────
-- 1. patient_dunning_runs — one balance cycle per patient.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."patient_dunning_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,

  -- Balance the run opened on (cents) — for worklist ranking; the live balance
  -- is recomputed each tick from claims/payments.
  "opened_balance_cents" integer NOT NULL DEFAULT 0,
  -- Anchors the policy's cumulative day-offsets.
  "opened_on" date NOT NULL DEFAULT CURRENT_DATE,

  "current_step" text NOT NULL DEFAULT 'statement',
  "next_action_at" timestamp with time zone,
  "last_step_at" timestamp with time zone,

  "status" text NOT NULL DEFAULT 'active',
  "paused_reason" text,
  "resolved_reason" text,

  "created_by_email" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "patient_dunning_runs_step_chk"
    CHECK ("current_step" IN (
      'statement', 'reminder', 'second_notice', 'final_notice',
      'agency', 'resolved'
    )),
  CONSTRAINT "patient_dunning_runs_status_chk"
    CHECK ("status" IN ('active', 'paused', 'resolved', 'cancelled')),
  CONSTRAINT "patient_dunning_runs_paused_reason_chk"
    CHECK ("paused_reason" IS NULL OR "paused_reason" IN (
      'payment_plan_active', 'autopay_enrolled', 'disputed', 'manual_hold'
    )),
  CONSTRAINT "patient_dunning_runs_resolved_reason_chk"
    CHECK ("resolved_reason" IS NULL OR "resolved_reason" IN (
      'paid', 'written_off', 'agency_handoff', 'manual'
    ))
);
--> statement-breakpoint

-- The tick: active runs whose next step is due. Partial index keeps it to the
-- live set.
CREATE INDEX IF NOT EXISTS "patient_dunning_runs_due_idx"
  ON "resupply"."patient_dunning_runs" ("next_action_at")
  WHERE "status" = 'active';
--> statement-breakpoint

-- The collections worklist: a tenant's runs ranked by balance.
CREATE INDEX IF NOT EXISTS "patient_dunning_runs_worklist_idx"
  ON "resupply"."patient_dunning_runs"
  ("org_id", "status", "opened_balance_cents" DESC);
--> statement-breakpoint

-- At most one non-terminal run per patient (don't double-dun). Partial unique.
CREATE UNIQUE INDEX IF NOT EXISTS "patient_dunning_runs_one_active_idx"
  ON "resupply"."patient_dunning_runs" ("patient_id")
  WHERE "status" IN ('active', 'paused');
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 2. patient_dunning_events — append-only touch / state log.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."patient_dunning_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),
  "run_id" uuid NOT NULL
    REFERENCES "resupply"."patient_dunning_runs"("id") ON DELETE CASCADE,

  "step" text NOT NULL,
  "channel" text NOT NULL DEFAULT 'none',
  "outcome" text NOT NULL,
  -- Reason code only — never PHI / free-text patient content.
  "detail" text,
  "amount_at_touch_cents" integer,
  "actor_email" text,
  "occurred_at" timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "patient_dunning_events_channel_chk"
    CHECK ("channel" IN ('email', 'sms', 'letter', 'none')),
  CONSTRAINT "patient_dunning_events_outcome_chk"
    CHECK ("outcome" IN (
      'sent', 'skipped', 'failed', 'paused', 'resolved', 'handoff'
    ))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "patient_dunning_events_run_idx"
  ON "resupply"."patient_dunning_events" ("run_id", "occurred_at");
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 3. Feature flags. Keep in sync with FEATURE_FLAG_KEYS in
--    artifacts/resupply-api/src/lib/feature-flags.ts.
--    feature_flags is per-tenant since migration 0350 (PK (org_id, key)).
-- ────────────────────────────────────────────────────────────────────
-- Both seeded OFF: net-new patient-facing outreach with TCPA exposure. When
-- collections.dunning is OFF the open-scan + tick jobs no-op; turning it on
-- begins escalating unpaid balances (consent + quiet-hours always enforced).
-- collections.agency_export gates the final agency hand-off export separately.
INSERT INTO resupply.feature_flags ("org_id", "key", "enabled", "description", "category")
SELECT o."id", v."key", v."enabled", v."description", v."category"
FROM "resupply"."organizations" o
CROSS JOIN (VALUES
  ('collections.dunning',
   false,
   'Patient AR dunning ladder. When ON, unpaid patient-responsibility balances escalate on a cadence (statement → reminder → second notice → final notice → agency), pausing automatically the moment the balance is paid or the patient goes onto a payment plan / autopay. Consent + quiet-hours are always enforced. When OFF, the open-scan and tick jobs no-op.',
   'Billing'),
  ('collections.agency_export',
   false,
   'Collections agency hand-off export. When ON, runs that reach the agency step can be exported (formula-injection-guarded CSV) for a collections agency. Nothing is ever sent to an agency automatically — the export is a reviewed, deliberate action. When OFF, the agency step simply parks the run for review.',
   'Billing')
) AS v("key", "enabled", "description", "category")
ON CONFLICT ("org_id", "key") DO NOTHING;
