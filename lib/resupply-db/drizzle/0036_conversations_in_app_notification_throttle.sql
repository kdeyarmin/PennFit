-- conversations.last_in_app_notification_at — timestamp of the most
-- recent "you have a new message from PennPaps" SendGrid send for
-- this thread.
--
-- Read by tryNotifyCustomerOfReply (Phase 13) to skip back-to-back
-- email blasts when a CSR posts multiple replies in quick succession.
-- The throttle window is enforced in app code (default 15 min), not
-- in the schema — the column is just a timestamp; schema doesn't care
-- how often we update it.
--
-- Patient-flow rows leave this null forever (no in-app notification
-- on those threads). For pre-Phase-13 in-app rows, null means
-- "no notification has been sent within the throttle window" — i.e.
-- the next reply still triggers an email, which is the desired
-- backwards-compatible behavior.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."conversations"
  ADD COLUMN IF NOT EXISTS "last_in_app_notification_at"
    timestamp with time zone;
