-- 0379_org_ops_notification_emails — per-tenant internal notification
-- recipients so a second tenant's order/lead notifications go to ITS OWN
-- staff, not the seed operator's inbox.
--
-- Two operational recipients were global env vars (PENN_FULFILLMENT_EMAIL,
-- INSURANCE_LEAD_NOTIFICATION_EMAIL), so every tenant's fitter-flow order
-- notification and insurance-lead notification landed in the seed (PennPaps)
-- mailbox. Model them per tenant on `organizations`:
--   * fulfillment_email      — where new fitter-flow order notifications go.
--   * lead_notification_email — where insurance-lead form notifications go.
--
-- Both NULLABLE with NO backfill: a NULL leaves the existing env default in
-- place (the seed operator's mailbox), so single-tenant is unchanged; a tenant
-- sets its own value to redirect its notifications. Business-contact data,
-- not PHI.
--
-- Per ADR 003 — additive, idempotent.

ALTER TABLE "resupply"."organizations"
  ADD COLUMN IF NOT EXISTS "fulfillment_email" text;
--> statement-breakpoint

ALTER TABLE "resupply"."organizations"
  ADD COLUMN IF NOT EXISTS "lead_notification_email" text;
