-- 0184 — therapy-fleet alerts feed + auto-outreach feature flag
-- (Therapy Fleet phase 7).
--
-- Phase 6 captures the fleet metrics nightly; this phase acts on them.
-- A nightly worker (therapy-fleet.alerts-scan) detects per-patient
-- threshold crossings (compliance slipping, residual AHI/leak high,
-- usage declining, device gone silent, a 90-day setup about to fail)
-- and maintains an internal alert feed here — one OPEN row per
-- (patient, alert_type), auto-resolved when the patient no longer
-- trips the threshold. CSRs work the feed via /admin/therapy-fleet/alerts.
--
-- Patient auto-outreach is OPTIONAL and OFF by default: the
-- `therapy_fleet.auto_outreach` flag (seeded disabled below) gates
-- whether the scan also sends the patient a gentle adherence SMS for
-- the patient-appropriate alert types. Even when on, the worker only
-- messages patients with an explicit SMS opt-in (communication
-- preferences smsTransactional=true) and respects DND + a 14-day
-- per-patient frequency cap — never DME-only patients with no consent
-- on file. `outreach_sent_at` records when an alert triggered a send.
--
-- PHI / log posture: detail holds small numeric context (e.g.
-- best_30day, days_remaining) — admin-only read, never logged. RLS
-- enabled deny-all to match the 0169/0170 posture.

CREATE TABLE IF NOT EXISTS "resupply"."therapy_fleet_alerts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "alert_type" text NOT NULL CHECK (
    "alert_type" IN (
      'compliance_risk',
      'high_ahi',
      'high_leak',
      'usage_decline',
      'no_recent_data',
      'setup_at_risk'
    )
  ),
  "severity" text NOT NULL CHECK ("severity" IN ('high', 'medium', 'low')),
  "status" text NOT NULL DEFAULT 'open'
    CHECK ("status" IN ('open', 'resolved')),
  "detail" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "outreach_sent_at" timestamptz,
  "resolved_at" timestamptz,
  "resolved_by_email" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- One OPEN alert per (patient, type) — the scan inserts only when none
-- is open, so the same slipping patient doesn't pile up duplicate rows.
CREATE UNIQUE INDEX IF NOT EXISTS "therapy_fleet_alerts_open_unique"
  ON "resupply"."therapy_fleet_alerts" ("patient_id", "alert_type")
  WHERE "status" = 'open';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "therapy_fleet_alerts_status_idx"
  ON "resupply"."therapy_fleet_alerts" ("status", "created_at" DESC);
--> statement-breakpoint

-- RLS — deny-all, matching 0169/0170. service_role bypasses.
ALTER TABLE "resupply"."therapy_fleet_alerts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Seed the auto-outreach feature flag DISABLED. isFeatureEnabled() fails
-- closed, so even without this row the default is off; seeding it makes
-- the flag visible + toggleable in the admin feature-flags console.
INSERT INTO "resupply"."feature_flags" ("key", "enabled", "description", "category")
VALUES (
  'therapy_fleet.auto_outreach',
  false,
  'When on, the nightly therapy-fleet alerts scan sends a gentle adherence SMS to consented patients (smsTransactional opt-in) for compliance-risk / device-silent / setup-at-risk alerts. Internal alerts are always recorded regardless of this flag.',
  'messaging'
)
ON CONFLICT ("key") DO NOTHING;
