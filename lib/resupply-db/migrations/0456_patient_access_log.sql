-- 0456 — patient access log (admin "Audit Trail" report)
--
-- A plain, queryable access-trail table recording WHICH staff member
-- accessed WHICH patient's information, WHEN, and from where. It backs
-- the admin Audit Trail report (filterable by time frame / employee /
-- patient).
--
-- This is deliberately NOT the retired HIPAA tamper-evident
-- `resupply.audit_log` chain (retired in the 0156 compliance cleanup)
-- and is NOT wired to the no-op `@workspace/resupply-audit` package.
-- There is no HMAC chain, no pgcrypto, and no per-row signature — it is
-- a simple append log. Rows are written best-effort by the
-- `recordPatientAccess` middleware on the admin API and never block or
-- fail a request.
--
-- PHI posture: stores only stable identifiers (patient / customer ids,
-- staff email + id) plus the HTTP method and path. It never stores
-- patient names, DOB, or any free-text clinical content, and it never
-- stores the request query string (which can carry patient-name search
-- terms). Patient display names are resolved on read for the report,
-- not persisted here.
--
-- Tenant-scoped: carries `org_id` so it flows through
-- getOrgScopedClient() like every other `resupply` table — inserts are
-- auto-tagged and reads auto-filtered by tenant.

CREATE TABLE IF NOT EXISTS "resupply"."patient_access_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid,
  "admin_user_id" text NOT NULL,
  "admin_email" text NOT NULL,
  "admin_role" text,
  "action" text NOT NULL,
  "method" text,
  "path" text,
  "target_table" text,
  "target_id" text,
  "patient_id" text,
  "status_code" integer,
  "ip" text,
  "user_agent" text,
  "impersonator_user_id" text,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Main report scan: tenant + newest-first time window.
CREATE INDEX IF NOT EXISTS "patient_access_log_org_occurred_idx" ON "resupply"."patient_access_log" USING btree ("org_id", "occurred_at" DESC);--> statement-breakpoint
-- Filter by employee within a tenant.
CREATE INDEX IF NOT EXISTS "patient_access_log_org_email_idx" ON "resupply"."patient_access_log" USING btree ("org_id", "admin_email", "occurred_at" DESC);--> statement-breakpoint
-- Filter by patient within a tenant.
CREATE INDEX IF NOT EXISTS "patient_access_log_org_patient_idx" ON "resupply"."patient_access_log" USING btree ("org_id", "patient_id", "occurred_at" DESC);--> statement-breakpoint
-- Filter by action verb within a tenant.
CREATE INDEX IF NOT EXISTS "patient_access_log_org_action_idx" ON "resupply"."patient_access_log" USING btree ("org_id", "action");
