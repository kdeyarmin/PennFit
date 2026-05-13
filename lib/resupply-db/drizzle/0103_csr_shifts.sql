-- csr_shifts — scheduled coverage windows per staff member.
-- See schema/csr-shifts.ts for the rationale.

CREATE TABLE IF NOT EXISTS "resupply"."csr_shifts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "staff_user_id" text NOT NULL,
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'scheduled',
  "notes" text,
  "created_by_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "csr_shifts_status_enum"
    CHECK ("status" IN ('scheduled','called_off','actual')),
  CONSTRAINT "csr_shifts_range_valid"
    CHECK ("ends_at" > "starts_at")
);

CREATE INDEX IF NOT EXISTS "csr_shifts_staff_idx"
  ON "resupply"."csr_shifts" ("staff_user_id", "starts_at");

CREATE INDEX IF NOT EXISTS "csr_shifts_range_idx"
  ON "resupply"."csr_shifts" ("starts_at", "ends_at");
