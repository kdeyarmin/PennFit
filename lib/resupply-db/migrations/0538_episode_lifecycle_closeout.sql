-- 0538_episode_lifecycle_closeout — give every resupply cycle an ending,
-- and record why it ended.
--
-- THE GAP
-- -------
-- `resupply.episodes` has a beginning and no end. An episode is opened
-- `outreach_pending` (lib/episodes/open-outreach-episode.ts), flipped to
-- `awaiting_response` by a reminder send, and flipped to `confirmed` or
-- `declined` by a patient. That is the entire set of writers. Three more
-- statuses — `fulfilled`, `expired`, `canceled` — are READ by
-- lib/analytics/aggregate.ts, routes/episodes/counts.ts, the
-- /admin/episodes?status= filter, and the generated SPA client types,
-- and are written by NOTHING. Every one of those surfaces has been
-- reporting a permanent zero.
--
-- The same is true of two columns on the table itself: `expires_at` and
-- `metadata` have existed since 0000 and have never been written.
--
-- And when a cycle DOES drop out, we record only that it did, never
-- why. A funnel that says "31 episodes declined" without saying whether
-- they declined, opted out, went unanswered, or were closed by a CSR
-- cannot tell an operator what to fix.
--
-- WHAT THIS ADDS
-- --------------
--   1. `closed_at` / `closed_reason` / `closing_fulfillment_id` — the
--      close-out record. `closed_reason` is the vocabulary in
--      lib/resupply-domain/src/episode-status.ts.
--   2. `cycle_number` — which pass through the ladder this is. Without
--      it the outcome funnel cannot tell a first fill from a repeat, so
--      acquisition and retention collapse into one number.
--   3. CHECK constraints on `status` and `closed_reason`, both
--      **NOT VALID**. There is no CHECK on `status` today, and 500k+
--      historical rows were written before this vocabulary was pinned.
--      NOT VALID applies the constraint to new writes without scanning
--      (or failing on) what is already there — the constraint can be
--      VALIDATEd later, off the deploy path, once a survey confirms the
--      existing rows conform.
--   4. `expires_at` backfilled for open episodes, so the expiry sweep
--      has something to read on its first run. Going forward
--      `openOutreachEpisode` stamps it.
--   5. `voice_calls.org_id` backfilled from `conversations`.
--      recordVoiceCallEvent has always inserted through the RAW client
--      with no org_id, while /admin/voice/metrics and the
--      channel-engagement analytics read through the org-scoped client
--      (which appends `.eq("org_id", …)`) — so both surfaces returned
--      zero rows for EVERY tenant, including the seed tenant.
--      worker/jobs/reminder-escalation.ts carries a `.raw()` workaround
--      naming this exact bug.
--   6. `resupply.integration_reconciliation_runs` — the per-source
--      diff of our therapy snapshots against a manufacturer portal
--      export. No such concept existed; the closest thing
--      (lib/integrations/diff-settings.ts) compares our snapshot to our
--      own previous snapshot, which cannot detect that we are behind.
--   7. Two feature flags, both seeded so the behaviour change is opt-in
--      per tenant rather than a deploy-day surprise.
--
-- SAFETY
-- ------
-- Every statement is additive and idempotent (IF NOT EXISTS / DO
-- NOTHING / NOT VALID). No column is dropped, no value is rewritten
-- except the two backfills, both of which only touch rows whose target
-- column is currently NULL and are therefore re-runnable.

-- ── 1. episodes: the close-out record ────────────────────────────────
ALTER TABLE "resupply"."episodes"
  ADD COLUMN IF NOT EXISTS "closed_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "closed_reason" text,
  ADD COLUMN IF NOT EXISTS "closing_fulfillment_id" uuid,
  ADD COLUMN IF NOT EXISTS "cycle_number" integer NOT NULL DEFAULT 1;
--> statement-breakpoint

-- The fulfillment that closed the cycle. ON DELETE SET NULL, not
-- CASCADE: deleting a fulfillment must not delete the history of the
-- episode it satisfied.
DO $$ BEGIN
  ALTER TABLE "resupply"."episodes"
    ADD CONSTRAINT "episodes_closing_fulfillment_id_fk"
    FOREIGN KEY ("closing_fulfillment_id")
    REFERENCES "resupply"."fulfillments"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- ── 2. Status + reason vocabulary ────────────────────────────────────
-- Keep in lockstep with EPISODE_STATUSES / EPISODE_CLOSED_REASONS in
-- lib/resupply-domain/src/episode-status.ts.
--
-- READ THIS BEFORE CHANGING THE CONSTRAINT SHAPE.
--
-- NOT VALID is NOT "the constraint only applies to new rows". It skips
-- the one-time back-scan, but Postgres still enforces the constraint on
-- every subsequent INSERT **and UPDATE** — including an UPDATE that does
-- not touch `status` at all. So a single legacy row carrying an
-- off-vocabulary status would turn the next patient confirm that touches
-- that row into a 500, on a patient-facing path, with no warning here.
--
-- The survey below refuses instead. A failed migration gates the deploy
-- (Railway's preDeployCommand keeps the PREVIOUS release serving — it
-- does not take the site down), which is strictly better than shipping a
-- landmine that fires on a live confirm.
--
-- The two constraints are deliberately INDEPENDENT: a cross-column
-- status <-> closed_reason CHECK would make every status correction a
-- two-column-atomic write. That pairing is enforced in TypeScript by
-- buildEpisodeClosure() instead.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(DISTINCT "status", ', ') INTO bad
    FROM "resupply"."episodes"
   WHERE "status" NOT IN (
     'outreach_pending', 'awaiting_response', 'address_hold',
     'confirmed', 'fulfilled', 'declined', 'expired', 'canceled'
   );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'resupply.episodes.status carries off-vocabulary values (%). Reconcile '
      'those rows before adding the CHECK — see the header of this migration.',
      bad;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'episodes_status_enum'
       AND conrelid = 'resupply.episodes'::regclass
  ) THEN
    ALTER TABLE "resupply"."episodes"
      ADD CONSTRAINT "episodes_status_enum"
      CHECK ("status" IN (
        'outreach_pending', 'awaiting_response', 'address_hold',
        'confirmed', 'fulfilled', 'declined', 'expired', 'canceled'
      )) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'episodes_closed_reason_enum'
       AND conrelid = 'resupply.episodes'::regclass
  ) THEN
    ALTER TABLE "resupply"."episodes"
      ADD CONSTRAINT "episodes_closed_reason_enum"
      CHECK ("closed_reason" IS NULL OR "closed_reason" IN (
        'shipped', 'assumed_shipped',
        'patient_declined', 'patient_opted_out',
        'no_response', 'never_contacted',
        'csr_canceled', 'prescription_ended', 'patient_inactive',
        'duplicate', 'coverage_lost'
      )) NOT VALID;
  END IF;
END
$$;
--> statement-breakpoint

-- Deliberately NO CHECK on fulfillments.status in this migration. Same
-- NOT-VALID-enforced-on-UPDATE hazard, on the confirm hot path, and the
-- table still carries an unresolved spelling split: every filter in the
-- app excludes 'cancelled' (double-L, reminders.ts:634 and
-- resolve-sku-entitlement.ts:89) while the admin badge renders 'canceled'
-- (single-L). The vocabulary is pinned in TypeScript
-- (FULFILLMENT_CANCELLED) first; the constraint can follow once a survey
-- confirms only one spelling exists in the data.

-- ── 3. Indexes for the sweeps and the outcome funnel ─────────────────
-- The grace/expiry sweeps scan (org, status, due_at); the outcome
-- funnel windows on (org, closed_at). Both currently fall back to the
-- single-column episodes_status_idx / episodes_due_at_idx from 0000,
-- which do not compose across tenants.
CREATE INDEX IF NOT EXISTS "episodes_org_status_due_idx"
  ON "resupply"."episodes" ("org_id", "status", "due_at");
--> statement-breakpoint

-- The expiry sweep scans open episodes by expiry date.
CREATE INDEX IF NOT EXISTS "episodes_open_expires_idx"
  ON "resupply"."episodes" ("org_id", "expires_at")
  WHERE "status" IN ('outreach_pending', 'awaiting_response', 'address_hold');
--> statement-breakpoint

-- The order-outcome funnel's mouth: episodes that became DUE in a window,
-- any status.
CREATE INDEX IF NOT EXISTS "episodes_org_due_idx"
  ON "resupply"."episodes" ("org_id", "due_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "episodes_org_closed_at_idx"
  ON "resupply"."episodes" ("org_id", "closed_at")
  WHERE "closed_at" IS NOT NULL;
--> statement-breakpoint

-- Ship-evidence lookups walk fulfillments by (org, episode) and by the
-- PacWare order ref during import matching. The 0000 indexes are
-- single-column and not org-composed.
CREATE INDEX IF NOT EXISTS "fulfillments_org_episode_idx"
  ON "resupply"."fulfillments" ("org_id", "episode_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "fulfillments_org_shipped_at_idx"
  ON "resupply"."fulfillments" ("org_id", "shipped_at")
  WHERE "shipped_at" IS NOT NULL;
--> statement-breakpoint

-- Ship-evidence matcher, exact-key strategy. `pacware_order_ref` has
-- never been written; the first shipment import stamps it, and every
-- later import is then an index probe instead of a patient+SKU+date
-- search.
CREATE INDEX IF NOT EXISTS "fulfillments_org_order_ref_idx"
  ON "resupply"."fulfillments" ("org_id", "pacware_order_ref")
  WHERE "pacware_order_ref" IS NOT NULL;
--> statement-breakpoint

-- Ship-evidence matcher, patient + SKU + date fallback.
CREATE INDEX IF NOT EXISTS "fulfillments_org_patient_sku_idx"
  ON "resupply"."fulfillments"
     ("org_id", "patient_id", "item_sku", "created_at" DESC);
--> statement-breakpoint

-- Safety-net grace sweep: queued-and-unshipped, by age.
CREATE INDEX IF NOT EXISTS "fulfillments_org_unshipped_idx"
  ON "resupply"."fulfillments" ("org_id", "created_at")
  WHERE "shipped_at" IS NULL AND "status" = 'queued';
--> statement-breakpoint

-- Order-outcome funnel: fulfillments -> insurance_claims. The join key
-- has existed since 0118 and has never been indexed; the funnel chunks
-- .in() on it.
CREATE INDEX IF NOT EXISTS "insurance_claims_fulfillment_idx"
  ON "resupply"."insurance_claims" ("fulfillment_id")
  WHERE "fulfillment_id" IS NOT NULL;
--> statement-breakpoint

-- ── 4. Backfill expires_at for open episodes ─────────────────────────
-- EPISODE_EXPIRY_DAYS (45) — comfortably past the ladder's own
-- stop-nagging age (RESUPPLY_ESCALATION_MAX_DAYS, default 21) so expiry
-- closes a cycle the ladder has already given up on rather than racing
-- it. Anchored on due_at so an episode that is not due yet does not
-- arrive pre-expired. Only fills NULLs, so a re-run is a no-op and an
-- already-stamped row is left alone.
UPDATE "resupply"."episodes"
SET "expires_at" = "due_at" + INTERVAL '45 days'
WHERE "expires_at" IS NULL
  AND "status" IN ('outreach_pending', 'awaiting_response');
--> statement-breakpoint

-- ── 5. Backfill voice_calls.org_id from its conversation ─────────────
-- See the header. Only fills NULLs; a call whose conversation is gone
-- (or itself un-orged) stays NULL and is reported by the metrics route
-- as unattributed rather than silently misfiled under the seed tenant.
UPDATE "resupply"."voice_calls" vc
SET "org_id" = c."org_id"
FROM "resupply"."conversations" c
WHERE vc."conversation_id" = c."id"
  AND vc."org_id" IS NULL
  AND c."org_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "voice_calls_org_created_idx"
  ON "resupply"."voice_calls" ("org_id", "created_at");
--> statement-breakpoint

-- ── 6. Therapy reconciliation runs ───────────────────────────────────
-- One row per operator-run diff of our stored therapy data against a
-- manufacturer portal export. Stores COUNTS and structural identifiers
-- only — never the uploaded rows, which carry partner patient ids and
-- usage figures. `discrepancies` holds the per-category tallies plus a
-- capped sample of partner patient ids so a CSR can go look, which is
-- the minimum needed to act on the result.
CREATE TABLE IF NOT EXISTS "resupply"."integration_reconciliation_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "source" text NOT NULL,
  "status" text DEFAULT 'completed' NOT NULL,
  "portal_rows" integer DEFAULT 0 NOT NULL,
  "local_rows" integer DEFAULT 0 NOT NULL,
  "matched_count" integer DEFAULT 0 NOT NULL,
  "missing_locally_count" integer DEFAULT 0 NOT NULL,
  "missing_in_portal_count" integer DEFAULT 0 NOT NULL,
  "mismatched_count" integer DEFAULT 0 NOT NULL,
  "discrepancies" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "window_start" date,
  "window_end" date,
  "error_message" text,
  "run_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "resupply"."integration_reconciliation_runs"
    ADD CONSTRAINT "integration_reconciliation_runs_org_fk"
    FOREIGN KEY ("org_id") REFERENCES "resupply"."organizations"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "resupply"."integration_reconciliation_runs"
    ADD CONSTRAINT "integration_reconciliation_runs_source_enum"
    CHECK ("source" IN ('resmed_airview', 'philips_care', 'react_health'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "resupply"."integration_reconciliation_runs"
    ADD CONSTRAINT "integration_reconciliation_runs_status_enum"
    CHECK ("status" IN ('completed', 'failed'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "integration_reconciliation_runs_org_created_idx"
  ON "resupply"."integration_reconciliation_runs"
     ("org_id", "created_at" DESC);
--> statement-breakpoint

-- ── 7. Feature flags ─────────────────────────────────────────────────
-- Keep in lockstep with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts — a key here that is
-- missing there silently no-ops in the admin toggle UI.
--
-- Both seed OFF. `due_at_authoritative` changes WHEN a live patient is
-- reminded, so it is flipped per tenant after the backfill script's
-- dry-run shows no drift for that tenant. `ship_evidence_required`
-- decides whether the next cycle waits for a real ship event; a tenant
-- with no ship feed at all must not silently fall out of the ladder,
-- so the safety-net sweep runs either way.
INSERT INTO resupply.feature_flags
  ("org_id", "key", "enabled", "description", "category")
SELECT o."id", v."key", v."enabled", v."description", v."category"
FROM resupply.organizations o
CROSS JOIN (VALUES
  ('resupply.due_at_authoritative',
   false,
   'Decide who is due from the episode''s own due date. ON: the hourly '
     || 'scan reminds an episode once its due date passes, and that date '
     || 'is recomputed from real shipment evidence every time a shipment '
     || 'is recorded. OFF (default): the scan keeps deriving due-ness '
     || 'from how long ago the last order was queued, ignoring the due '
     || 'date entirely. Turn this on only after running the due-date '
     || 'backfill for this tenant — until then the two answers can '
     || 'disagree and patients would be reminded early or late.',
   'Resupply'),
  ('resupply.ship_evidence_required',
   false,
   'Wait for proof of shipment before starting the next refill cycle. '
     || 'ON: the next cycle opens when a shipment is recorded (a PacWare '
     || 'shipped-orders import or a staff "mark shipped"), dated from the '
     || 'actual ship date. OFF (default): the next cycle opens as soon as '
     || 'the patient confirms, as it does today. Either way, an order '
     || 'that never gets shipment evidence within the grace window still '
     || 'starts its next cycle, so nobody stops being reminded because '
     || 'paperwork went missing.',
   'Resupply')
) AS v("key", "enabled", "description", "category")
ON CONFLICT ("org_id", "key") DO NOTHING;
