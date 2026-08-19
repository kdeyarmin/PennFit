-- 0501_fit_session_rescan_reason — store the clinician's rescan note.
--
-- "Request rescan" has always REQUIRED a reason (the route validates 3-2000
-- chars) and the console told the clinician "your note is recorded on the
-- session" — but nothing stored it: only its length landed in the event
-- detail, and the text was thrown away. The UI copy was corrected to admit
-- that in the interim; this column makes the original claim true.
--
-- Why a column rather than fit_session_events.detail: the events table's
-- contract is ids/codes/counts only — clinician free text can carry PHI and
-- events are the wrong place for it. The session row already carries
-- clinician free text under the same posture (override_reason), so the
-- rescan reason sits beside it.
--
-- Nullable, no backfill: sessions whose rescan predates this column simply
-- have no note, and inventing one would be worse than the gap.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent (M4).

ALTER TABLE "resupply"."fit_sessions"
  ADD COLUMN IF NOT EXISTS "rescan_reason" text;
