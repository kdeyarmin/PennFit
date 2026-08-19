-- 0497_fit_sessions_refit_entry_point — make re-fit outreach attributable.
--
-- 0483 constrained `fit_sessions.entry_point` to the three ways a fitting
-- could start at the time: a link you sent, a fitting run at the counter,
-- and the kiosk QR. 0490 then added a fourth — the established-patient
-- re-fit campaign, which offers a fresh fitting to patients who reported a
-- leaking or uncomfortable fit and to patients on a discontinued mask —
-- and it had nowhere to record itself.
--
-- The consequence was silent rather than loud: a campaign fitting fell
-- through to the `remote_link` default, so it was counted alongside
-- ordinary text and email invitations. The one number the campaign exists
-- to move — whether re-approaching a patient already on service produces
-- better fits than leaving them alone — could not be read out of the
-- outcomes report at all.
--
-- Idempotent by drop-then-add: ADD CONSTRAINT has no IF NOT EXISTS, and
-- re-applying the file must be a no-op (the ledger dedups on content hash,
-- so any re-apply runs the whole file again).
--
-- No backfill. Sessions already recorded as `remote_link` stay that way:
-- we cannot tell after the fact which of them came from the campaign, and
-- inventing an attribution is worse than a short gap in the series.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."fit_sessions"
  DROP CONSTRAINT IF EXISTS "fit_sessions_entry_point_chk";
--> statement-breakpoint

ALTER TABLE "resupply"."fit_sessions"
  ADD CONSTRAINT "fit_sessions_entry_point_chk"
  CHECK ("entry_point" IN (
    'remote_link',
    'in_office',
    'kiosk_qr',
    'refit_campaign'
  ));
