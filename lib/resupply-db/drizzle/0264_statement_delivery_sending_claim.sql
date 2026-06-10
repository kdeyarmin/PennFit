-- 0264_statement_delivery_sending_claim — close the statement
-- double-send race (app-review 2026-06-10, P1-8).
-- (Authored as 0262; renumbered to 0264 after a prefix collision with
-- main's 0262_messages_sender_role_deepgram_transcript.)
--
-- `sendOneStatement` used to read the row, dispatch email/SMS, and
-- only then flip delivery_status → sent (unconditionally). Two
-- concurrent senders — an operator's single-send click racing the
-- batch sweep over the same 'pending' row — both passed the read and
-- both delivered, double-billing the patient. The fix is a
-- claim-then-send state machine in lib/billing/statement-send.ts:
--
--   pending | failed  --claim-->  sending  --outcome-->  sent | failed | skipped
--
-- The claim is a conditional UPDATE (`WHERE delivery_status IN
-- ('pending','failed') RETURNING id`): exactly one concurrent sender
-- gets the row; the loser sees zero rows and skips. 'failed' stays
-- claimable so an operator can retry a failed send; 'sent' is NOT
-- claimable — re-sending a delivered bill is the bug this closes.
--
-- This migration only widens the CHECK constraint to admit the new
-- transient 'sending' state. Operational note: a process crash between
-- claim and outcome leaves the row in 'sending' — visible in the admin
-- statements view, excluded from both the batch scan and new claims;
-- flip it back to 'pending' by hand after confirming nothing was sent.
--
-- Re-run-safe: DROP IF EXISTS + ADD; every existing value is a member
-- of the widened set, so the ADD's validation scan cannot fail.
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."patient_billing_statements"
  DROP CONSTRAINT IF EXISTS "patient_billing_statements_delivery_status_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."patient_billing_statements"
  ADD CONSTRAINT "patient_billing_statements_delivery_status_enum"
  CHECK ("delivery_status" IN ('pending', 'sending', 'sent', 'failed', 'skipped'));
