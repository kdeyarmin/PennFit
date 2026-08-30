-- 0536_fitter_followup_alerts — chase the fitter funnel's two silent
-- drop-offs, and give staff a queue that says who went quiet.
--
-- THE GAP
-- -------
-- A staff member sends someone a mask-fitter link (`fitter_invites`,
-- migration 0243) and then nothing follows up, in either direction:
--
--   A. LINK SENT, FIT NEVER DONE. The row sits at status 'sent' (never
--      opened) or 'opened' (started, abandoned mid-flow) until
--      `expires_at` passes, at which point `shop/fitter-invite.ts` marks
--      it 'expired' lazily the next time somebody clicks a dead link.
--      No second message to the patient, no signal to the staff member
--      who sent it. Grep confirms it: NOTHING in the worker tree reads
--      `fitter_invites` — `refit-campaign.ts` only WRITES new ones.
--
--   B. FIT DONE, THEN NOTHING. The patient finishes, sees their
--      recommendation, and under `fitter.lead_capture_only` (seeded ON
--      for every tenant by 0518) the next step is THEIR move: submit a
--      `fitter_fit_requests` row. If they close the tab instead, the
--      fitting — measurements, questionnaire, a defensible
--      recommendation — is just a row nobody acts on. That is the most
--      expensive drop-off in the funnel, because the work is already
--      done.
--
-- The existing lead nudges do NOT cover either one. `fitter-lead-
-- reengage` and `fitter-lead-first-day-nudge` both scan
-- `resupply.fitter_leads`, which is the ANONYMOUS STOREFRONT funnel —
-- someone who found the site themselves and opted in at /consent. A
-- person a CSR deliberately mailed a link to has a `fitter_invites` row
-- and may have no lead row at all. Different table, different cohort,
-- no overlap.
--
-- WHY BOTH COHORTS ANCHOR ON `fitter_invites`
-- -------------------------------------------
-- Both need somewhere to send the follow-up, and the invite is the only
-- record that carries a contact for a fitting: `fit_sessions` has no
-- email or phone column, and a storefront fitting's contact lives in
-- `fitter_leads` (already chased by the two jobs above). So the sweep
-- reads invites, and the four nudge stamps below live on that one table.
--
-- STAFF ALERTS ARE NOT THE SAME THING AS PATIENT NUDGES
-- ----------------------------------------------------
-- `fitter_followup_alerts` is an INTERNAL feed, recorded regardless of
-- whether the tenant lets us message the patient — same posture as
-- `therapy_fleet_alerts` (0184), whose flag gates the outreach and never
-- the alert. A tenant that would rather phone people than email them
-- turns `fitter.followup_nudges` off and still gets the worklist; a
-- tenant with no SendGrid credentials still gets the worklist. The one
-- thing that must never happen is a patient going quiet and nobody
-- knowing.
--
-- PHI
-- ---
-- No contact details, names, measurements or clinical findings are
-- copied here. The alert row holds FOREIGN KEYS to the invite / request
-- / session / chart and a `detail` jsonb of counts and ids only; the
-- admin route joins the contact in at read time. That keeps the one copy
-- of a patient's email in the table that already owns it, and keeps this
-- table safe to count and log.
--
-- Per ADR 003 — versioned hand-authored migration, idempotent.

-- ---------------------------------------------------------------
-- 1. Nudge stamps — the idempotency ledger for the sweep.
-- ---------------------------------------------------------------
-- Four columns, two per cohort (a first nudge and a last one). They live
-- on `fitter_invites` rather than on a side table for the same reason
-- 0534 put its pair on `resupply_auth.users`: the sweep's duplicate-send
-- guard is a conditional UPDATE issued through PostgREST, and the row it
-- has to claim is the row it already read.
--
-- Nothing resets them. A staff RESEND mints a fresh token and re-stamps
-- `sent_at` on the SAME row, so the sweep treats a stamp older than
-- `sent_at` as stale and lets the resent invite earn its own nudges —
-- the same staleness trick 0534 plays against a token's `created_at`.
ALTER TABLE "resupply"."fitter_invites"
  ADD COLUMN IF NOT EXISTS "fit_reminder_sent_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "fit_final_reminder_sent_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "post_fit_reminder_sent_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "post_fit_final_reminder_sent_at" timestamp with time zone;
--> statement-breakpoint

COMMENT ON COLUMN "resupply"."fitter_invites"."fit_reminder_sent_at" IS
  'Cohort A first nudge: the link was sent and the fitting was never done. Compared against sent_at — a stamp older than the current sent_at is stale (the invite was resent) and does not suppress a fresh nudge.';
--> statement-breakpoint
COMMENT ON COLUMN "resupply"."fitter_invites"."post_fit_reminder_sent_at" IS
  'Cohort B first nudge: the fitting was completed and no fit request / order followed. Compared against completed_at for the same staleness reason.';
--> statement-breakpoint

-- Cohort A's candidate scan: invites that are still live and not yet
-- finished. Partial on the two open statuses so the index tracks the
-- outstanding backlog rather than every invite ever sent — the table
-- keeps completed and expired rows forever.
CREATE INDEX IF NOT EXISTS "fitter_invites_open_followup_idx"
  ON "resupply"."fitter_invites" ("org_id", "sent_at")
  WHERE "status" IN ('sent', 'opened');
--> statement-breakpoint

-- Cohort B's candidate scan: fittings that finished, newest first (the
-- sweep only looks back a bounded window — see POST_FIT_MAX_AGE_MS).
CREATE INDEX IF NOT EXISTS "fitter_invites_completed_followup_idx"
  ON "resupply"."fitter_invites" ("org_id", "completed_at" DESC)
  WHERE "status" IN ('completed', 'attached');
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 2. The staff-facing alert feed.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "resupply"."fitter_followup_alerts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),

  -- What went quiet. The first three are the patient's move; the fourth
  -- is OURS, and is deliberately in the same feed: from the patient's
  -- side "I asked and nobody called" is indistinguishable from "I did
  -- the fitting and nothing happened", so splitting them across two
  -- pages would hide half the problem.
  --   fit_not_started  — link delivered, never opened.
  --   fit_abandoned    — opened, started, never finished.
  --   fit_no_request   — fitting finished, no request and no order.
  --   request_unworked — the patient DID ask and the queue row has sat
  --                      past the one-business-day promise the results
  --                      page makes them.
  "alert_type" text NOT NULL,
  "severity" text NOT NULL DEFAULT 'medium',
  "status" text NOT NULL DEFAULT 'open',

  -- ── Subject. Exactly one of the first two is set; see the CHECK. ──
  -- CASCADE on both: an alert about a deleted row is noise a CSR would
  -- have to clear by hand.
  "fitter_invite_id" uuid
    REFERENCES "resupply"."fitter_invites"("id") ON DELETE CASCADE,
  "fit_request_id" uuid
    REFERENCES "resupply"."fitter_fit_requests"("id") ON DELETE CASCADE,
  -- Context, not subject. SET NULL so deleting a chart or a fitting
  -- leaves the alert standing (the invite still went unanswered).
  "fit_session_id" uuid
    REFERENCES "resupply"."fit_sessions"("id") ON DELETE SET NULL,
  "patient_id" uuid
    REFERENCES "resupply"."patients"("id") ON DELETE SET NULL,

  -- Counts / ids / channel names only — never a name, address, contact
  -- or clinical finding. The route joins contact in from the invite.
  "detail" jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- What the automated follow-up has already done, denormalised so the
  -- worklist can say "emailed twice, still nothing" without a join.
  "nudge_count" integer NOT NULL DEFAULT 0,
  "last_nudge_at" timestamp with time zone,
  "last_nudge_channel" text,

  -- ── Disposition ──
  -- resolved: the thing the alert was about happened (the sweep closes
  --           it; no human action needed).
  -- dismissed: a person decided it needs nothing. Distinct from resolved
  --           because the unique index below means a dismissed alert is
  --           never re-raised, and conflating the two would make
  --           "how many of these actually converted" unanswerable.
  "resolved_at" timestamp with time zone,
  "resolved_reason" text,
  "dismissed_at" timestamp with time zone,
  "dismissed_by_email" text,
  "staff_note" text,

  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "fitter_followup_alerts_type_chk"
    CHECK ("alert_type" IN (
      'fit_not_started', 'fit_abandoned', 'fit_no_request', 'request_unworked'
    )),
  CONSTRAINT "fitter_followup_alerts_severity_chk"
    CHECK ("severity" IN ('low', 'medium', 'high')),
  CONSTRAINT "fitter_followup_alerts_status_chk"
    CHECK ("status" IN ('open', 'resolved', 'dismissed')),
  CONSTRAINT "fitter_followup_alerts_resolved_reason_chk"
    CHECK ("resolved_reason" IS NULL OR "resolved_reason" IN (
      'fit_completed', 'request_received', 'dispensed',
      'invite_revoked', 'request_worked'
    )),
  -- An alert is ABOUT exactly one thing. Without this, a row with both
  -- keys set would be counted twice by the two unique indexes below and
  -- would deep-link to whichever one the UI happened to check first.
  CONSTRAINT "fitter_followup_alerts_subject_chk"
    CHECK (num_nonnulls("fitter_invite_id", "fit_request_id") = 1)
);
--> statement-breakpoint

-- One alert per (tenant, type, subject), FOR ALL TIME — not just among
-- open rows.
--
-- This is the load-bearing choice in the table and it is deliberately
-- NOT partial on status. Each alert type is a one-shot condition on a
-- specific row ("this invite was never opened"), so re-raising can only
-- mean re-raising something a person already dealt with. A partial index
-- scoped to open rows would resurrect every alert a CSR dismissed on the
-- very next tick, which is the fastest way to teach staff to ignore a
-- queue. The sweep therefore inserts blind and lets the index arbitrate,
-- exactly as 0519 does for duplicate fit requests: two concurrent ticks
-- both pass any read-then-write check a scan could make.
CREATE UNIQUE INDEX IF NOT EXISTS "fitter_followup_alerts_invite_unique"
  ON "resupply"."fitter_followup_alerts" ("org_id", "alert_type", "fitter_invite_id")
  WHERE "fitter_invite_id" IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "fitter_followup_alerts_request_unique"
  ON "resupply"."fitter_followup_alerts" ("org_id", "alert_type", "fit_request_id")
  WHERE "fit_request_id" IS NOT NULL;
--> statement-breakpoint

-- The page's dominant read: this tenant's open alerts, worst first.
-- Severity is text, so ordering by it is alphabetical ('high' < 'low' <
-- 'medium') and useless — the route sorts by created_at and groups by
-- severity in the client. The index serves the filter, not the sort key.
CREATE INDEX IF NOT EXISTS "fitter_followup_alerts_org_status_idx"
  ON "resupply"."fitter_followup_alerts"
     ("org_id", "status", "created_at" DESC);
--> statement-breakpoint

-- The sweep's auto-resolve pass looks up open alerts by subject.
CREATE INDEX IF NOT EXISTS "fitter_followup_alerts_open_invite_idx"
  ON "resupply"."fitter_followup_alerts" ("fitter_invite_id")
  WHERE "status" = 'open' AND "fitter_invite_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "fitter_followup_alerts_open_request_idx"
  ON "resupply"."fitter_followup_alerts" ("fit_request_id")
  WHERE "status" = 'open' AND "fit_request_id" IS NOT NULL;
--> statement-breakpoint

-- `resupply.set_updated_at()` was created in 0054 and is what every
-- other table's updated_at trigger calls.
DROP TRIGGER IF EXISTS trg_fitter_followup_alerts_set_updated_at
  ON resupply.fitter_followup_alerts;
--> statement-breakpoint
CREATE TRIGGER trg_fitter_followup_alerts_set_updated_at
  BEFORE UPDATE ON resupply.fitter_followup_alerts
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();
--> statement-breakpoint

-- RLS deny-all, matching the 0169/0170/0184 posture. service_role
-- bypasses; nothing else may read a row that names a patient chart.
ALTER TABLE "resupply"."fitter_followup_alerts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 3. fitter.followup_nudges — seeded ON, and here is why.
-- ---------------------------------------------------------------
-- Patient-facing campaigns in this repo normally ship OFF
-- (`fitter.refit_campaign`, `therapy_fleet.auto_outreach`), because the
-- risk they carry is a deploy that starts messaging a backlog of
-- historical rows the moment it lands.
--
-- This sweep cannot do that, structurally, and that is what changes the
-- default:
--   * Cohort A only chases invites that are STILL LIVE — inside their
--     own `expires_at`. Every historical invite is already expired or
--     finished, so the backlog is empty by construction.
--   * Cohort B only looks back POST_FIT_MAX_AGE_MS (30 days) from the
--     fitting's `completed_at`, and skips anyone who already asked or
--     already ordered.
--   * Both are capped per tick, so even a genuine burst drains an hour
--     at a time rather than in one SendGrid spike.
--
-- What is left is the thing the tenant already asked for: a second
-- message on a thread THEY started by sending this person a link. A
-- default of OFF would mean a link sent and never followed up — the
-- exact behaviour this migration exists to end — until somebody found a
-- toggle.
--
-- Turning it OFF stops the patient messages and keeps the staff alerts,
-- which is the setting a tenant who would rather phone people wants.
--
-- Keep in lockstep with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts — a key here that is
-- missing there silently no-ops in the admin toggle UI.
INSERT INTO resupply.feature_flags
  ("org_id", "key", "enabled", "description", "category")
SELECT o."id", v."key", v."enabled", v."description", v."category"
FROM resupply.organizations o
CROSS JOIN (VALUES
  ('fitter.followup_nudges',
   true,
   'Follow up automatically when a mask-fitter link goes unanswered. ON: '
     || 'someone sent a fitter link who has not started (or finished) the '
     || 'fitting gets a reminder while the link is still live, and someone '
     || 'who finished a fitting but never asked us to order gets a nudge to '
     || 'get in touch. Both stop the moment the patient acts. OFF: no '
     || 'patient messages go out — the staff worklist at '
     || 'Fitter > Follow-ups is still built either way, so nobody goes '
     || 'quiet without somebody knowing.',
   'Messaging')
) AS v("key", "enabled", "description", "category")
ON CONFLICT ("org_id", "key") DO NOTHING;
