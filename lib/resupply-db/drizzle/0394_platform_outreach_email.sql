-- Platform outreach email (super-admin broadcast tool).
--
-- A PLATFORM-LEVEL marketing/outreach engine, distinct from the
-- per-tenant `bulk_campaigns` engine (which targets a tenant's own
-- patients / shop customers). This one lets the platform super-admin
-- email three audiences from the platform's OWN sender
-- (SENDGRID_FROM_EMAIL / "CareMetric Breathe"):
--
--   * existing tenants      — the owner accounts of each org
--   * saved contacts/leads  — a platform-global mini-CRM (this file)
--   * ad-hoc / pasted lists — cold/blind marketing
--
-- These tables are platform-GLOBAL (no org_id): the rows belong to the
-- platform operator, not to any one tenant, and are only ever read /
-- written through the service-role client behind `requirePlatformAdmin`.
--
-- Mirrors the bulk_campaigns drain/throttle pattern (a pg-boss tick
-- claims a batch, sends, finalizes, re-enqueues) so the proven
-- send-side semantics carry over.
--
-- IMPORTANT — journal posture: not listed in _journal.json, matching the
-- established pattern for migrations 0050+.

-- ── Contacts / leads (platform-global mini-CRM) ────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."platform_contacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" varchar(320) NOT NULL,
  "name" varchar(200),
  "company" varchar(200),
  "tags" text[] NOT NULL DEFAULT '{}',
  "notes" text,
  "unsubscribed" boolean NOT NULL DEFAULT false,
  "unsubscribed_at" timestamp with time zone,
  "source" varchar(40) NOT NULL DEFAULT 'manual',
  "created_by_email" varchar(320),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "platform_contacts_source_enum"
    CHECK ("source" IN ('manual', 'import'))
);

-- One row per email address (case-insensitive). Upserts on import key
-- off this so re-importing the same list is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS "platform_contacts_email_unique"
  ON "resupply"."platform_contacts" (lower("email"));

-- Tag filtering for "contacts_by_tag" audiences.
CREATE INDEX IF NOT EXISTS "platform_contacts_tags_idx"
  ON "resupply"."platform_contacts" USING gin ("tags");

CREATE OR REPLACE FUNCTION "resupply"."set_platform_contacts_updated_at"()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "platform_contacts_updated_at_trigger"
  BEFORE UPDATE ON "resupply"."platform_contacts"
  FOR EACH ROW
  EXECUTE FUNCTION "resupply"."set_platform_contacts_updated_at"();

-- ── Campaigns ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."platform_email_campaigns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" varchar(200) NOT NULL,
  "subject" varchar(300) NOT NULL,
  "body_html" text,
  "body_text" text NOT NULL,
  -- 'all_tenants' | 'selected_tenants' | 'all_contacts'
  --   | 'contacts_by_tag' | 'manual_list'
  "audience_kind" text NOT NULL,
  -- Audience parameters: { tenantIds?: string[], tag?: string,
  --   emails?: string[] } — shape depends on audience_kind.
  "audience_payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "throttle_per_minute" integer NOT NULL DEFAULT 60,
  "status" text NOT NULL DEFAULT 'draft',
  "total_recipients" integer NOT NULL DEFAULT 0,
  "suppressed_count" integer NOT NULL DEFAULT 0,
  "sent_count" integer NOT NULL DEFAULT 0,
  "failed_count" integer NOT NULL DEFAULT 0,
  "created_by_email" varchar(320),
  "created_by_user_id" uuid,
  "cancelled_by_user_id" uuid,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "platform_email_campaigns_audience_enum"
    CHECK ("audience_kind" IN (
      'all_tenants', 'selected_tenants', 'all_contacts',
      'contacts_by_tag', 'manual_list'
    )),
  CONSTRAINT "platform_email_campaigns_status_enum"
    CHECK ("status" IN ('draft', 'sending', 'sent', 'paused', 'cancelled')),
  CONSTRAINT "platform_email_campaigns_throttle_check"
    CHECK ("throttle_per_minute" BETWEEN 1 AND 3600)
);

CREATE INDEX IF NOT EXISTS "platform_email_campaigns_status_idx"
  ON "resupply"."platform_email_campaigns" ("status");

CREATE OR REPLACE FUNCTION "resupply"."set_platform_email_campaigns_updated_at"()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "platform_email_campaigns_updated_at_trigger"
  BEFORE UPDATE ON "resupply"."platform_email_campaigns"
  FOR EACH ROW
  EXECUTE FUNCTION "resupply"."set_platform_email_campaigns_updated_at"();

-- ── Recipients (per-send delivery log) ─────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."platform_email_recipients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "campaign_id" uuid NOT NULL
    REFERENCES "resupply"."platform_email_campaigns"("id") ON DELETE CASCADE,
  -- 'tenant' | 'contact' | 'manual'
  "recipient_kind" text NOT NULL,
  -- Source row id (organizations.id / platform_contacts.id) when known;
  -- NULL for ad-hoc 'manual' addresses.
  "recipient_ref" uuid,
  "recipient_email" varchar(320) NOT NULL,
  "recipient_name" varchar(200),
  "status" text NOT NULL DEFAULT 'pending',
  "suppression_reason" varchar(80),
  "error" text,
  "send_attempts" integer NOT NULL DEFAULT 0,
  "vendor_message_id" varchar(200),
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "platform_email_recipients_kind_enum"
    CHECK ("recipient_kind" IN ('tenant', 'contact', 'manual')),
  CONSTRAINT "platform_email_recipients_status_enum"
    CHECK ("status" IN (
      'pending', 'suppressed', 'sending', 'sent', 'failed', 'retry_pending'
    ))
);

CREATE INDEX IF NOT EXISTS "platform_email_recipients_campaign_idx"
  ON "resupply"."platform_email_recipients" ("campaign_id");

-- Worker drain pattern: pull pending rows for the active campaign.
CREATE INDEX IF NOT EXISTS "platform_email_recipients_campaign_status_idx"
  ON "resupply"."platform_email_recipients" ("campaign_id", "status");

-- Dedupe — a given email appears at most once per campaign.
CREATE UNIQUE INDEX IF NOT EXISTS "platform_email_recipients_campaign_email_unique"
  ON "resupply"."platform_email_recipients" ("campaign_id", lower("recipient_email"));

CREATE OR REPLACE FUNCTION "resupply"."set_platform_email_recipients_updated_at"()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "platform_email_recipients_updated_at_trigger"
  BEFORE UPDATE ON "resupply"."platform_email_recipients"
  FOR EACH ROW
  EXECUTE FUNCTION "resupply"."set_platform_email_recipients_updated_at"();
