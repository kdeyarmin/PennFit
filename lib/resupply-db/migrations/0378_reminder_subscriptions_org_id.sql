-- 0378_reminder_subscriptions_org_id — make the storefront "supply reminders"
-- subscriptions tenant-scoped.
--
-- `public.reminder_subscriptions` (the storefront supply-reminder signups, not
-- the patient reminder system) was created with no org_id, so every tenant's
-- subscribers share one global email/manage-token namespace: a second tenant's
-- signups land under the seed org, and an admin "send"/list sees everyone's
-- subscribers. Add an org_id so subscribe records the host tenant, the admin
-- list/send filter to the caller's org, and the manage/unsubscribe copy can
-- carry the right brand. Manage/unsubscribe stay keyed by the globally-unique
-- manage_token, so existing manage links keep working regardless of host.
--
-- Cross-schema FK: the table lives in `public`; organizations lives in
-- `resupply`. Postgres allows the cross-schema reference.
--
-- Additive + idempotent: nullable column, seed backfill, indexed. NULL for any
-- pre-backfill row leaves it out of per-org filters until set.

ALTER TABLE "public"."reminder_subscriptions"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations" ("id");
--> statement-breakpoint

UPDATE "public"."reminder_subscriptions"
SET "org_id" = (
  SELECT "id" FROM "resupply"."organizations"
  WHERE "slug" = 'penn-home-medical'
  LIMIT 1
)
WHERE "org_id" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "reminder_subscriptions_org_idx"
  ON "public"."reminder_subscriptions" ("org_id");
--> statement-breakpoint

-- Re-key the email uniqueness per tenant: two tenants may each have a
-- subscriber with the same email. The old GLOBAL email-unique index would
-- otherwise block a second tenant from enrolling an email another tenant
-- already uses. (manage_token stays globally unique — tokens are random.)
-- Safe: after the backfill above every row has org_id = the seed org, and the
-- old global-unique guaranteed no duplicate emails, so (org_id, email) is
-- already unique. Partial on org_id IS NOT NULL; every insert sets org_id.
DROP INDEX IF EXISTS "public"."reminder_subscriptions_email_unique_idx";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "reminder_subscriptions_org_email_uq"
  ON "public"."reminder_subscriptions" ("org_id", "email")
  WHERE "org_id" IS NOT NULL;
