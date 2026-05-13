-- appointment_requests — patient-initiated request inbox.
-- See schema/appointment-requests.ts.

CREATE TABLE IF NOT EXISTS "resupply"."appointment_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "requester_email" varchar(254) NOT NULL,
  "requester_name" varchar(200),
  "requester_phone" varchar(32),
  "topic" varchar(200) NOT NULL,
  "preferred_window" varchar(200),
  "notes" text,
  "status" varchar(16) NOT NULL DEFAULT 'new',
  "attached_patient_id" uuid,
  "assigned_admin_user_id" text,
  "triaged_at" timestamp with time zone,
  "scheduled_for" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "appointment_requests_status_enum"
    CHECK ("status" IN ('new','contacted','scheduled','declined','cancelled'))
);

CREATE INDEX IF NOT EXISTS "appointment_requests_status_idx"
  ON "resupply"."appointment_requests" ("status");
