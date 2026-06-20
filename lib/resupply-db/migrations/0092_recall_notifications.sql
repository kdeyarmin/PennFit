-- recall_notifications — per-asset, per-recall audit row.
-- See schema/recall-notifications.ts for the full rationale.
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+.

CREATE TABLE IF NOT EXISTS "resupply"."recall_notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "recall_id" uuid NOT NULL REFERENCES "resupply"."equipment_recalls"("id") ON DELETE CASCADE,
  "asset_id" uuid NOT NULL REFERENCES "resupply"."equipment_assets"("id") ON DELETE CASCADE,
  "patient_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "channel" text,
  "notified_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "failed_reason" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "recall_notifications_status_enum"
    CHECK ("status" IN ('queued', 'sent', 'failed', 'bounced', 'skipped')),
  CONSTRAINT "recall_notifications_channel_enum"
    CHECK ("channel" IS NULL OR "channel" IN ('email', 'sms', 'letter'))
);

-- One row per (recall, asset) — matcher upserts idempotently.
CREATE UNIQUE INDEX IF NOT EXISTS "recall_notifications_recall_asset_unique"
  ON "resupply"."recall_notifications" ("recall_id", "asset_id");

-- Send-worker hot path: oldest queued rows first.
CREATE INDEX IF NOT EXISTS "recall_notifications_queued_idx"
  ON "resupply"."recall_notifications" ("created_at")
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS "recall_notifications_patient_idx"
  ON "resupply"."recall_notifications" ("patient_id");
