-- 0030_insurance_leads — persist submissions from the public
-- /insurance lead-capture form (POST /shop/insurance-leads).
--
-- Why this table exists:
--   The Wave 1 lead-capture form fires two SendGrid emails (team
--   notification + patient confirmation) but does not persist
--   anything. If the verifications mailbox is missed (vacation
--   filter rule, SendGrid outage, address typo) a lead is lost
--   silently. This table is the durable system of record so the
--   admin queue page (`/admin/shop/insurance-leads`) can show every
--   submission regardless of email outcome, and so a CSR can mark
--   each one as contacted/verified/closed with an optional note.
--
-- PHI handling:
--   This row contains member-id and date-of-birth — both PHI under
--   HIPAA. We store them in plain text columns inside the resupply
--   schema, which is consistent with how `patients.first_name` and
--   the rest of the resupply data is stored on this DB (a single
--   VPC-isolated Postgres with at-rest encryption). We do NOT mirror
--   them into the audit_log when the row is read; admin reads emit
--   a counts-only audit line (mirroring the existing audit policy
--   for patient detail reads).
--
-- Status lifecycle:
--   `new`        — just submitted; awaiting CSR triage. Default.
--   `contacted`  — CSR called/emailed the patient.
--   `verified`   — insurance verified; patient handed off to the
--                  fitting flow or the cash-pay shop.
--   `closed`     — declined / no-show / duplicate / spam.
--
-- Email-delivery flags (`notification_email_delivered`,
-- `confirmation_email_delivered`) capture the SendGrid send result
-- at submission time so the admin can spot mailbox-side outages
-- (e.g. "all rows from Tuesday have notification_delivered=false")
-- without cross-referencing the SendGrid event log.

CREATE TABLE IF NOT EXISTS "resupply"."insurance_leads" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
  "full_name" text NOT NULL,
  "email" text NOT NULL,
  "phone" text NOT NULL,
  "date_of_birth" text NOT NULL,
  "insurance_carrier" text NOT NULL,
  "member_id" text NOT NULL,
  "group_number" text,
  "prescribing_physician" text,
  "notes" text,
  "status" text DEFAULT 'new' NOT NULL,
  "csr_note" text,
  "notification_email_delivered" boolean DEFAULT false NOT NULL,
  "confirmation_email_delivered" boolean DEFAULT false NOT NULL,
  "submitter_ip" text,
  "user_agent" text,
  "moderated_at" timestamp with time zone,
  "moderated_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Status filtering on the admin queue is the dominant read pattern
-- (the page defaults to "show me only `new`"). A small index on
-- (status, created_at DESC) covers it without indexing every row by
-- status alone.
CREATE INDEX IF NOT EXISTS "insurance_leads_status_created_idx"
  ON "resupply"."insurance_leads" ("status", "created_at" DESC);
--> statement-breakpoint

-- Lookup by email is needed when a CSR pastes a patient's email into
-- the global lookup bar. Lowercase normalization happens at the API
-- layer (zod transform) so a plain B-tree on the column is fine.
CREATE INDEX IF NOT EXISTS "insurance_leads_email_idx"
  ON "resupply"."insurance_leads" ("email");
