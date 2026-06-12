-- Video-visit invite SMS delivery tracking (status-callback wiring).
--
-- Invite SMS for telehealth video visits previously omitted Twilio's
-- statusCallback, so after Twilio ACCEPTED the invite we were blind to
-- carrier-side delivery failures (A2P 10DLC filtering, unverified
-- toll-free, etc.) — the row read invite_delivered=true and staff had
-- no signal the patient never got the link. Video-visit invites have
-- no conversations/messages row (the existing /sms/status-callback
-- correlator), so the callback needs a home on the visit row itself,
-- mirroring 0309_recall_notifications_delivery_tracking:
--
--   * invite_twilio_message_sid  — the accepted message's SID, stamped
--                                  by the send path (and by the
--                                  callback, which can land first).
--   * invite_delivery_status     — Twilio lifecycle terminal state from
--                                  the status callback (sent /
--                                  delivered / undelivered / failed).
--                                  NULL = no callback yet (or
--                                  pre-feature row / email channel).
--                                  Deliberately SEPARATE from
--                                  invite_delivered, which records
--                                  "vendor accepted the send".
--   * invite_delivery_error_code — Twilio error code on
--                                  undelivered/failed.
--
-- No index on invite_twilio_message_sid: the callback correlates by
-- primary key (the videoVisitId query param baked into the signed
-- callback URL), never by SID scan.

ALTER TABLE "resupply"."video_visits"
  ADD COLUMN IF NOT EXISTS "invite_twilio_message_sid" text;
--> statement-breakpoint
ALTER TABLE "resupply"."video_visits"
  ADD COLUMN IF NOT EXISTS "invite_delivery_status" text;
--> statement-breakpoint
ALTER TABLE "resupply"."video_visits"
  ADD COLUMN IF NOT EXISTS "invite_delivery_error_code" text;
