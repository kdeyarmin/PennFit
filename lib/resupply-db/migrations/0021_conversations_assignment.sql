-- conversations — assignment, SLA, escalation, priority columns.
--
-- Why these specific columns:
--   * assigned_admin_clerk_id: which CSR is currently working this
--     thread. NULL = unassigned (anyone in the queue can pick it up).
--     Mirrors the Clerk user id rather than a foreign key into
--     admin_users so the column keeps working even when the bootstrap
--     env-var admin handles a thread (those rows don't exist in
--     admin_users yet).
--   * assigned_at: when the current claim happened. Not strictly
--     needed for routing but makes "who's been sitting on this for
--     too long" reportable in one query.
--   * priority: 'low' | 'normal' | 'high' | 'urgent'. Defaults to
--     'normal'; CSRs (and supervisors) can promote a thread.
--   * sla_due_at: pre-computed SLA deadline. We store it as a
--     materialized timestamp rather than recomputing client-side
--     because the admin-list query needs to ORDER BY sla_due_at
--     to surface "about to breach" rows first. Updated by a small
--     trigger when status flips to awaiting_admin.
--   * escalated_at, escalated_to, escalation_reason: when a CSR
--     flags a thread for a supervisor's attention. The supervisor
--     view filters on escalated_at IS NOT NULL.
--
-- Per ADR 003 — versioned hand-authored migration. Additive only.

ALTER TABLE "resupply"."conversations"
  ADD COLUMN IF NOT EXISTS "assigned_admin_clerk_id" text,
  ADD COLUMN IF NOT EXISTS "assigned_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "priority" text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS "sla_due_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "escalated_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "escalated_to" text,
  ADD COLUMN IF NOT EXISTS "escalation_reason" text;

-- Indexes powering the new admin queue views.
--   "my queue":   WHERE assigned_admin_clerk_id = $1 AND status IN ('open','awaiting_admin')
--   "unassigned": WHERE assigned_admin_clerk_id IS NULL AND status IN ('open','awaiting_admin')
--   "breaching":  ORDER BY sla_due_at ASC NULLS LAST
-- Single composite index covers both filters; the partial WHERE keeps
-- it small (closed conversations don't need to be indexed for the
-- live work surface).
CREATE INDEX IF NOT EXISTS "conversations_assignee_active_idx"
  ON "resupply"."conversations" ("assigned_admin_clerk_id", "status")
  WHERE "status" IN ('open', 'awaiting_admin', 'awaiting_patient');

-- SLA breach scan: ordered by sla_due_at ascending so the first
-- bucket is the most-overdue. Partial — we only care about active rows.
CREATE INDEX IF NOT EXISTS "conversations_sla_due_active_idx"
  ON "resupply"."conversations" ("sla_due_at")
  WHERE "status" IN ('open', 'awaiting_admin');

-- Escalation queue: rows flagged for a supervisor's attention.
-- Partial because the column is NULL for the vast majority of rows.
CREATE INDEX IF NOT EXISTS "conversations_escalated_idx"
  ON "resupply"."conversations" ("escalated_at" DESC)
  WHERE "escalated_at" IS NOT NULL;
