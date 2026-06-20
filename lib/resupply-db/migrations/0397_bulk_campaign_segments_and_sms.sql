-- 0397 — Bulk-campaign patient segments + SMS channel.
--
-- Extends the existing bulk-campaigns engine (migrations 0082/0083) in
-- two ways so tenants can send mass SMS *or* email to a finely-targeted
-- patient audience:
--
--   1. SMS channel. `bulk_campaigns.channel` may now be 'sms' as well
--      as 'email'. The send worker branches on this column: email goes
--      through the tenant SendGrid client (unchanged), SMS through the
--      tenant Twilio client. `bulk_campaign_recipients.recipient_phone`
--      snapshots the destination number the same way recipient_email
--      snapshots the address — so the resolved audience stays stable
--      even if the patient's contact info later changes.
--
--   2. Composable patient segments. A new audience_kind 'patient_segment'
--      carries a JSON filter spec in the new `audience_filter` column.
--      The spec ANDs together criteria the audience resolver knows how to
--      query: device manufacturer, device class, equipment model match
--      (covers masks where the model is recorded), "failing therapy"
--      (open low-adherence compliance alert), insurance payer, and
--      contact recency. Only the `patient_segment` kind sets this column;
--      it is NULL for every other audience.
--
-- While here we also FIX a latent constraint bug: the API has long
-- offered an 'by_therapy_cohort' audience (routes/admin/bulk-campaigns.ts,
-- lib/bulk-campaigns/fetch-candidates.ts) but the 0082 CHECK never listed
-- it, so a by_therapy_cohort draft INSERT would have violated the
-- constraint. The widened CHECK below admits it.
--
-- IMPORTANT — journal posture: not listed in _journal.json, matching the
-- established pattern for migrations 0050+. Forward-deploy-safe: every
-- statement is guarded (IF EXISTS / IF NOT EXISTS), and the constraint is
-- dropped-then-recreated so a re-run is idempotent.

-- 1. Allow SMS as a campaign channel (was 'email'-only).
ALTER TABLE "resupply"."bulk_campaigns"
  DROP CONSTRAINT IF EXISTS "bulk_campaigns_channel_enum";
ALTER TABLE "resupply"."bulk_campaigns"
  ADD CONSTRAINT "bulk_campaigns_channel_enum"
    CHECK ("channel" IN ('email', 'sms'));

-- 2. Widen the audience_kind enum: admit the already-referenced
--    'by_therapy_cohort' and the new composable 'patient_segment'.
ALTER TABLE "resupply"."bulk_campaigns"
  DROP CONSTRAINT IF EXISTS "bulk_campaigns_audience_kind_enum";
ALTER TABLE "resupply"."bulk_campaigns"
  ADD CONSTRAINT "bulk_campaigns_audience_kind_enum"
    CHECK ("audience_kind" IN (
      'all_active_shop_customers',
      'all_active_patients',
      'by_patient_payer',
      'by_therapy_cohort',
      'patient_segment',
      'manual_list'
    ));

-- 3. Composable segment spec. Set only when audience_kind='patient_segment';
--    NULL for every other audience. JSON shape is owned + validated by
--    lib/bulk-campaigns/patient-segment.ts.
ALTER TABLE "resupply"."bulk_campaigns"
  ADD COLUMN IF NOT EXISTS "audience_filter" jsonb;

-- 4. Snapshot the recipient phone for SMS campaigns, mirroring the
--    existing recipient_email snapshot. NULL for email campaigns and for
--    recipients with no phone on file (those are suppressed 'no_phone').
ALTER TABLE "resupply"."bulk_campaign_recipients"
  ADD COLUMN IF NOT EXISTS "recipient_phone" varchar(20);
