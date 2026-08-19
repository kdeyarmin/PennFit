-- 0489_fitter_invite_in_office — start a fitting at the counter.
--
-- Why
-- ---
-- `fitter_invites.channel` has been ('email','sms') since 0243, which
-- encodes an assumption: a fitting always begins by sending the patient
-- something and then waiting. That is false for the case a DME cares
-- about most — the patient is standing at the counter right now. Today
-- staff have to email or text someone three feet away and hope they
-- check their phone before they leave.
--
-- 'in_office' is that third channel: the invite is created, nothing is
-- delivered, and the signed link is handed over on the spot as a QR code
-- the patient scans with their own phone. The row still exists, so the
-- fitting attributes back to the invite, to the staff member who started
-- it (`invited_by_user_id`), and — because the channel is recorded —
-- lets in-office and remote fittings be reported against each other.
--
-- Nothing else about the row changes. Delivery-shaped columns
-- (`recipient_email`, `recipient_phone_e164`) stay nullable and simply
-- go unset for a walk-in prospect with no contact details on file yet.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."fitter_invites"
  DROP CONSTRAINT IF EXISTS "fitter_invites_channel_chk";
--> statement-breakpoint

ALTER TABLE "resupply"."fitter_invites"
  ADD CONSTRAINT "fitter_invites_channel_chk"
  CHECK ("channel" IN ('email', 'sms', 'in_office'));
--> statement-breakpoint

COMMENT ON COLUMN "resupply"."fitter_invites"."channel" IS
  'How the invite reached the patient. email/sms are delivered; in_office is handed over as a QR code at the counter and never sent.';
