-- 0156_fitter_csr_notes_and_cold_skip — CSR free-text notes per
-- lead + dispatcher-side cold-skip transition.
--
-- Two additions that compound on phase 5's reporting + recency:
--
-- 1. CSR notes
-- ------------
-- "Mark contacted" (mig 0154) stamps WHO + WHEN but not WHY.
-- Without a notes field a CSR who left a voicemail at 2pm has no
-- way to tell the colleague picking up the queue at 5pm what to
-- say on the second call. This column closes that gap with the
-- smallest possible shape — one nullable text column on the lead
-- row.
--
-- Free text length bounded server-side (zod max 2000 chars in the
-- route handler) so a runaway paste from a clipboard can't fill
-- the row. PHI policy: same posture as the rest of the lead row
-- (admin gate already cleared by requirePermission).
--
-- 2. Cold-lead suppression marker
-- -------------------------------
-- The pre-purchase cadence sends 6 touches over 60 days. A lead
-- who hasn't opened ANY of T1-T4 by day 14 is sending a clear
-- signal: this isn't the right message at the right time, or
-- they're not a buyer right now. Continuing to send T5 +
-- T6 wastes SendGrid quota AND raises the risk of an unsubscribe
-- (which is permanent and forfeits the T11 reactivation chance).
--
-- This column stamps when the dispatcher chose to short-circuit
-- a cold lead's remaining pre-purchase touches and fast-forward
-- to T11. Admin reporting can compare conversion rates between
-- cold-skipped vs. full-cadence cohorts to validate the rule.
--
-- The dispatcher logic itself (artifacts/resupply-api/src/worker/
-- jobs/fitter-supply-campaign.ts) does the actual transition; we
-- only add storage here.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "csr_notes" text;
--> statement-breakpoint

ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "cold_skipped_at" timestamp with time zone;
--> statement-breakpoint

-- Reporting index: "how many leads did we cold-skip this month
-- vs. last month?" Partial because the cold-skipped set is a
-- single-digit fraction of total fitter_leads and we only ever
-- query for non-null cold_skipped_at.
CREATE INDEX IF NOT EXISTS "fitter_leads_cold_skipped_idx"
  ON "resupply"."fitter_leads" ("cold_skipped_at" DESC)
  WHERE "cold_skipped_at" IS NOT NULL;
