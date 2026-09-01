-- 0543_lifecycle_health_monitoring — the state behind the lifecycle
-- health signals: what is currently wrong, since when, and what has
-- already been said about it.
--
-- WHY ANY STATE AT ALL
-- --------------------
-- A monitor that recomputes from scratch every tick can tell you a
-- number is bad. It cannot tell you:
--
--   * whether this is NEW (worth an email) or the same thing it said an
--     hour ago (worth nothing);
--   * whether it got WORSE since it was first seen;
--   * how long it has been wrong, which is usually the part that decides
--     whether anyone acts.
--
-- Without those, the only two designs available are "notify every tick"
-- — which trains everyone to filter the sender — and "notify never".
-- The existing DLQ digest deliberately re-notifies daily because its
-- cadence IS daily; an hourly scan cannot do that.
--
-- ONE OPEN ALERT PER SIGNAL PER SCOPE — ENFORCED BY THE DATABASE
-- --------------------------------------------------------------
-- The deduplication arbiter must be the unique index, not a read-then-
-- write check in the job. Two overlapping ticks (a slow scan and its
-- successor, or two worker instances during a rollover) both pass any
-- check the application could make, and the result is two open alerts
-- for one problem and two emails about it.
--
-- The index is partial on `resolved_at IS NULL` so the same signal may
-- legitimately fire again later — the history of past alerts is kept,
-- which is what makes "this breaks every Monday" visible.
--
-- SCOPE: TENANT OR PLATFORM
-- -------------------------
-- Most signals are per tenant. Two are not, and cannot honestly be
-- rendered as though they were:
--
--   * voice calls that landed with NO org_id — by definition they belong
--     to no tenant, and showing the same global number inside every
--     tenant's panel would have each operator chasing another's problem;
--   * inbound webhooks that failed tenant attribution — same.
--
-- So rows carry `scope_id`: an org uuid as text, or the literal
-- 'platform'. `org_id` stays a real, FK-checked uuid column for tenant
-- rows (so the org-scoped client's automatic filter works and a deleted
-- tenant's alerts cascade away) and is NULL for platform rows. A CHECK
-- keeps the two from drifting apart.
--
-- `scope_id` rather than a nullable unique key because this database
-- targets Postgres 14, where NULLs in a unique index are distinct — a
-- unique index over a nullable org_id would happily accept a hundred
-- open platform alerts for the same signal.
--
-- PHI
-- ---
-- Counts, ages, ratios, table names, signal keys. `detail` is a bounded
-- JSON object of NUMBERS and vocabulary strings — never a patient id, a
-- name, a phone number, a message body, or a vendor payload. The whole
-- point of an aggregate monitor is that it never needs one.

-- ── 1. Open + historical alerts ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."lifecycle_health_alerts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- An org uuid as text, or 'platform'.
  "scope_id" text NOT NULL,
  "org_id" uuid,
  "signal_key" text NOT NULL,
  -- The CURRENT severity of this alert: 'warning' or 'failure'.
  "status" text NOT NULL,
  -- The worst severity this alert has ever reached. An alert that went
  -- failure -> warning is recovering, not fixed, and a responder who
  -- only sees the current status cannot tell those apart.
  "peak_status" text NOT NULL,
  "observed_value" double precision,
  "threshold_value" double precision,
  "sample_size" integer,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "first_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- When a human or a recovery closed it. NULL = still open.
  "resolved_at" timestamp with time zone,
  "resolved_reason" text,
  -- Notification bookkeeping. `notify_count` is how many times anyone
  -- was told about THIS alert; a high number on a still-open alert is
  -- itself a finding.
  "last_notified_at" timestamp with time zone,
  "last_notified_status" text,
  "notify_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "resupply"."lifecycle_health_alerts"
    ADD CONSTRAINT "lifecycle_health_alerts_org_fk"
    FOREIGN KEY ("org_id") REFERENCES "resupply"."organizations"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- scope_id and org_id must agree. Without this a row could claim tenant
-- scope while carrying no tenant, and the org-scoped client would then
-- never return it — an alert that exists and is invisible.
DO $$ BEGIN
  ALTER TABLE "resupply"."lifecycle_health_alerts"
    ADD CONSTRAINT "lifecycle_health_alerts_scope_agrees"
    CHECK (
      ("org_id" IS NULL AND "scope_id" = 'platform')
      OR ("org_id" IS NOT NULL AND "scope_id" = "org_id"::text)
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "resupply"."lifecycle_health_alerts"
    ADD CONSTRAINT "lifecycle_health_alerts_status_enum"
    CHECK ("status" IN ('warning', 'failure'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "resupply"."lifecycle_health_alerts"
    ADD CONSTRAINT "lifecycle_health_alerts_peak_status_enum"
    CHECK ("peak_status" IN ('warning', 'failure'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- A resolved alert must say why. 'recovered' (the signal came back
-- inside its threshold) and 'acknowledged' (a person closed it) are
-- different outcomes, and an alert list where they render the same
-- cannot answer "did we fix it, or did someone silence it?".
DO $$ BEGIN
  ALTER TABLE "resupply"."lifecycle_health_alerts"
    ADD CONSTRAINT "lifecycle_health_alerts_resolution_pairs"
    CHECK (
      ("resolved_at" IS NULL AND "resolved_reason" IS NULL)
      OR ("resolved_at" IS NOT NULL AND "resolved_reason" IS NOT NULL)
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- THE DEDUPLICATION ARBITER. See the header.
CREATE UNIQUE INDEX IF NOT EXISTS "lifecycle_health_alerts_open_uniq"
  ON "resupply"."lifecycle_health_alerts" ("scope_id", "signal_key")
  WHERE "resolved_at" IS NULL;
--> statement-breakpoint

-- The panel reads open alerts for one scope; the history view reads a
-- scope's alerts newest-first.
CREATE INDEX IF NOT EXISTS "lifecycle_health_alerts_scope_created_idx"
  ON "resupply"."lifecycle_health_alerts" ("scope_id", "created_at" DESC);
--> statement-breakpoint

-- ── 2. Last-scan observation snapshot ────────────────────────────────
-- One row per (scope, signal), overwritten by every scan.
--
-- The admin surface computes most signals live, but two of them can only
-- be measured from inside the worker (dead-letter queue depth is a
-- pg-boss API call, and there is no boss handle in an HTTP request). For
-- those, the panel reads the last scan instead — and because the row
-- carries `observed_at`, it can say HOW OLD that reading is rather than
-- presenting a twelve-hour-old number as current.
--
-- It also gives every signal an "as of" even when nothing is wrong,
-- which is the difference between "the monitor is quiet" and "the
-- monitor has not run since Tuesday".
CREATE TABLE IF NOT EXISTS "resupply"."lifecycle_health_observations" (
  "scope_id" text NOT NULL,
  "org_id" uuid,
  "signal_key" text NOT NULL,
  -- ok | warning | failure | disabled | not_configured | unknown
  "status" text NOT NULL,
  "observed_value" double precision,
  "sample_size" integer,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "observed_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("scope_id", "signal_key")
);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "resupply"."lifecycle_health_observations"
    ADD CONSTRAINT "lifecycle_health_observations_org_fk"
    FOREIGN KEY ("org_id") REFERENCES "resupply"."organizations"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "resupply"."lifecycle_health_observations"
    ADD CONSTRAINT "lifecycle_health_observations_scope_agrees"
    CHECK (
      ("org_id" IS NULL AND "scope_id" = 'platform')
      OR ("org_id" IS NOT NULL AND "scope_id" = "org_id"::text)
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "resupply"."lifecycle_health_observations"
    ADD CONSTRAINT "lifecycle_health_observations_status_enum"
    CHECK ("status" IN (
      'ok', 'warning', 'failure', 'disabled', 'not_configured', 'unknown'
    ));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- ── 3. Inbound tenant-attribution failures ───────────────────────────
-- An inbound SMS or call whose tenant could not be resolved is DROPPED,
-- correctly and by design: the alternative is filing a stranger's
-- message under whichever practice happened to look closest, which is
-- the tenant-isolation bug this platform refuses to have.
--
-- But dropped meant unrecorded, so the failure rate was zero-by-
-- construction and a misconfigured DID could go unnoticed for as long
-- as nobody happened to call about it. (`safeAudit` is a no-op stub —
-- migration 0156 retired audit_log — so the audit line at those call
-- sites records nothing.)
--
-- This is a ROLLUP, deliberately: a day, a channel, a reason, and a
-- count. There is no phone number, no message id, and no room for one.
-- Attribution failed, so there is no tenant to scope a PHI-bearing row
-- to in the first place — the only safe record of the event is one that
-- contains nothing about the person who sent it.
CREATE TABLE IF NOT EXISTS "resupply"."inbound_attribution_failures" (
  "day" date NOT NULL,
  "channel" text NOT NULL,
  "reason" text NOT NULL,
  "failures" integer DEFAULT 0 NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("day", "channel", "reason")
);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "resupply"."inbound_attribution_failures"
    ADD CONSTRAINT "inbound_attribution_failures_channel_enum"
    CHECK ("channel" IN ('sms', 'voice'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- The vocabulary is closed on purpose: an open-ended reason string is
-- how free text (and eventually a phone number) ends up in a table that
-- promises it holds none.
DO $$ BEGIN
  ALTER TABLE "resupply"."inbound_attribution_failures"
    ADD CONSTRAINT "inbound_attribution_failures_reason_enum"
    CHECK ("reason" IN (
      -- Nobody owns the dialled/texted number on that channel.
      'unknown_called_number',
      -- The caller's own number exists in more than one tenant, so
      -- ownership is genuinely undecidable and the resolver failed
      -- closed rather than guessing.
      'ambiguous_caller',
      -- The caller's number matched nothing anywhere.
      'unknown_caller',
      -- The directory read itself failed. Not the same as "no match" —
      -- this one is an outage.
      'directory_unavailable'
    ));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- Increment one rollup bucket atomically.
--
-- A read-modify-write from the application would lose increments under
-- exactly the conditions that matter — a misrouted number generating a
-- burst of inbound traffic — and would understate the very spike the
-- signal exists to catch. ON CONFLICT DO UPDATE is one statement and
-- one row lock.
CREATE OR REPLACE FUNCTION "resupply"."record_inbound_attribution_failure"(
  p_channel text,
  p_reason text
) RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO "resupply"."inbound_attribution_failures"
    ("day", "channel", "reason", "failures")
  VALUES (CURRENT_DATE, p_channel, p_reason, 1)
  ON CONFLICT ("day", "channel", "reason") DO UPDATE
    SET "failures" = "resupply"."inbound_attribution_failures"."failures" + 1,
        "last_seen_at" = now();
$$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "inbound_attribution_failures_day_idx"
  ON "resupply"."inbound_attribution_failures" ("day" DESC);
