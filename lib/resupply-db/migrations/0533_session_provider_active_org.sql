-- 0533_session_provider_active_org — provider portal session-pinned active org.
--
-- Separate from impersonated_org_id (admin act-as, migration 0356). Lets a
-- provider on the CareMetric platform host select which DME's queue/RTM to
-- open after membership validation (provider_dme_links), without seed-org
-- soft-fallback on PHI list routes.
--
-- No cross-schema FK (same convention as impersonated_org_id).
-- Per ADR 003 — idempotent.

ALTER TABLE "resupply_auth"."sessions"
  ADD COLUMN IF NOT EXISTS "provider_active_org_id" uuid;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "auth_sessions_provider_active_org_idx"
  ON "resupply_auth"."sessions" ("provider_active_org_id")
  WHERE "provider_active_org_id" IS NOT NULL;
