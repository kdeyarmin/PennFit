-- Recall SMS delivery tracking (status-callback wiring).
--
-- Recall notifications sent by SMS previously omitted Twilio's
-- statusCallback, so after Twilio ACCEPTED a recall text we were blind
-- to carrier-side delivery failures — a safety-critical recall could
-- silently bounce and the row would still read 'sent'. Recall sends
-- have no conversations/messages row (the existing /sms/status-callback
-- correlator), so the callback needs a home on the notification row
-- itself:
--
--   * twilio_message_sid   — the accepted message's SID, stamped by the
--                            send sweep (and by the callback, which can
--                            land before the sweep's terminal flip).
--   * delivery_status      — Twilio lifecycle terminal state as reported
--                            by the status callback (sent / delivered /
--                            undelivered / failed). NULL = no callback
--                            yet (or pre-feature row). Deliberately a
--                            SEPARATE column from `status`: `status` is
--                            the send-sweep state machine (queued →
--                            sending → sent/failed/skipped) and the
--                            webhook must never fight it.
--   * delivery_error_code  — Twilio error code on undelivered/failed.
--
-- No index on twilio_message_sid: the callback correlates by primary
-- key (the recallNotificationId query param baked into the signed
-- callback URL), never by SID scan.

ALTER TABLE "resupply"."recall_notifications"
  ADD COLUMN IF NOT EXISTS "twilio_message_sid" text;
--> statement-breakpoint
ALTER TABLE "resupply"."recall_notifications"
  ADD COLUMN IF NOT EXISTS "delivery_status" text;
--> statement-breakpoint
ALTER TABLE "resupply"."recall_notifications"
  ADD COLUMN IF NOT EXISTS "delivery_error_code" text;
