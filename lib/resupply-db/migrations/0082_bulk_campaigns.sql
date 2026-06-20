-- bulk_campaigns — one-off and scheduled bulk-email sends to a
-- resolved patient or customer audience. See
-- lib/resupply-db/src/schema/bulk-campaigns.ts for the full
-- rationale, audience-kind enum, lifecycle, and PHI posture.
--
-- Phase A (this migration): schema + the draft/cancelled
-- transitions are persisted. Phase B will add the send-side worker
-- that transitions draft → sending → sent.
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+.

CREATE TABLE IF NOT EXISTS "resupply"."bulk_campaigns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" varchar(200) NOT NULL,
  "description" text,
  "audience_kind" text NOT NULL,
  "audience_payer" varchar(120),
  "channel" text NOT NULL DEFAULT 'email',
  "category" text NOT NULL,
  "compliance_attestation" text,
  "template_key" varchar(120) NOT NULL,
  "throttle_per_minute" integer NOT NULL DEFAULT 120,
  "status" text NOT NULL DEFAULT 'draft',
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "created_by_user_id" uuid,
  "cancelled_by_user_id" uuid,
  "total_recipients" integer NOT NULL DEFAULT 0,
  "suppressed_count" integer NOT NULL DEFAULT 0,
  "sent_count" integer NOT NULL DEFAULT 0,
  "failed_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "bulk_campaigns_audience_kind_enum"
    CHECK ("audience_kind" IN (
      'all_active_shop_customers',
      'all_active_patients',
      'by_patient_payer',
      'manual_list'
    )),
  CONSTRAINT "bulk_campaigns_channel_enum"
    CHECK ("channel" IN ('email')),
  CONSTRAINT "bulk_campaigns_category_enum"
    CHECK ("category" IN ('marketing', 'service', 'compliance')),
  CONSTRAINT "bulk_campaigns_status_enum"
    CHECK ("status" IN ('draft', 'sending', 'sent', 'paused', 'cancelled')),
  CONSTRAINT "bulk_campaigns_throttle_range"
    CHECK ("throttle_per_minute" >= 1 AND "throttle_per_minute" <= 3600),
  CONSTRAINT "bulk_campaigns_counts_non_negative" CHECK (
    "total_recipients" >= 0 AND
    "suppressed_count" >= 0 AND
    "sent_count" >= 0 AND
    "failed_count" >= 0
  )
);

CREATE INDEX IF NOT EXISTS "bulk_campaigns_status_created_idx"
  ON "resupply"."bulk_campaigns" ("status", "created_at");
