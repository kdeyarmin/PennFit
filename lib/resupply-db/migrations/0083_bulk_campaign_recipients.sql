-- bulk_campaign_recipients — one row per individual the audience
-- resolver produced for a bulk_campaigns row. The audience is
-- snapshotted into this table at create-time so the count and
-- list stay stable even as the underlying patient/customer rows
-- shift.
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+.

CREATE TABLE IF NOT EXISTS "resupply"."bulk_campaign_recipients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "campaign_id" uuid NOT NULL REFERENCES "resupply"."bulk_campaigns"("id") ON DELETE CASCADE,
  "recipient_kind" text NOT NULL,
  "recipient_id" uuid NOT NULL,
  "recipient_email" varchar(320),
  "status" text NOT NULL DEFAULT 'pending',
  "suppression_reason" varchar(80),
  "sent_at" timestamp with time zone,
  "vendor_message_id" varchar(200),
  "error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "bulk_campaign_recipients_kind_enum"
    CHECK ("recipient_kind" IN ('patient', 'shop_customer')),
  CONSTRAINT "bulk_campaign_recipients_status_enum"
    CHECK ("status" IN ('pending', 'suppressed', 'sending', 'sent', 'failed')),
  CONSTRAINT "bulk_campaign_recipients_suppression_reason_check"
    CHECK (
      ("status" = 'suppressed' AND "suppression_reason" IS NOT NULL AND "suppression_reason" <> '')
      OR ("status" <> 'suppressed' AND "suppression_reason" IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS "bulk_campaign_recipients_campaign_idx"
  ON "resupply"."bulk_campaign_recipients" ("campaign_id");

-- Worker drain pattern: pull pending rows for the active campaign.
CREATE INDEX IF NOT EXISTS "bulk_campaign_recipients_campaign_status_idx"
  ON "resupply"."bulk_campaign_recipients" ("campaign_id", "status");

-- Dedupe — a given recipient can appear at most once per campaign.
CREATE UNIQUE INDEX IF NOT EXISTS "bulk_campaign_recipients_campaign_recipient_unique"
  ON "resupply"."bulk_campaign_recipients"
  ("campaign_id", "recipient_kind", "recipient_id");

-- Trigger to automatically update the updated_at timestamp on row updates.
-- The $onUpdateFn in Drizzle ORM has no effect when using Supabase/PostgREST,
-- so we handle it at the database level.
CREATE OR REPLACE FUNCTION "resupply"."set_bulk_campaign_recipients_updated_at"()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "bulk_campaign_recipients_updated_at_trigger"
  BEFORE UPDATE ON "resupply"."bulk_campaign_recipients"
  FOR EACH ROW
  EXECUTE FUNCTION "resupply"."set_bulk_campaign_recipients_updated_at"();
