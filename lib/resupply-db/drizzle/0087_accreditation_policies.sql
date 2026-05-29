-- accreditation_policies + admin_policy_attestations — the policy
-- catalog and per-staff acknowledgement records that drive the
-- DMEPOS accreditation evidence binder.
--
-- See lib/resupply-db/src/schema/accreditation-policies.ts and
-- admin-policy-attestations.ts for the full rationale (one row per
-- version, lifecycle via active_at/retired_at, no DELETE in normal
-- flow, soft FK to admin_users so deleting a staff row doesn't
-- erase audit history).
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+.

CREATE TABLE IF NOT EXISTS "resupply"."accreditation_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "policy_key" varchar(64) NOT NULL,
  "version" varchar(32) NOT NULL,
  "title" varchar(200) NOT NULL,
  "summary" text,
  "body_url" text,
  "category" varchar(32) NOT NULL,
  "active_at" timestamp with time zone,
  "retired_at" timestamp with time zone,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "accreditation_policies_policy_key_shape"
    CHECK ("policy_key" ~ '^[a-z0-9_]{1,64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "accreditation_policies_key_version_unique"
  ON "resupply"."accreditation_policies" ("policy_key", "version");

CREATE INDEX IF NOT EXISTS "accreditation_policies_active_retired_idx"
  ON "resupply"."accreditation_policies" ("active_at", "retired_at");

CREATE INDEX IF NOT EXISTS "accreditation_policies_category_idx"
  ON "resupply"."accreditation_policies" ("category");

CREATE TABLE IF NOT EXISTS "resupply"."admin_policy_attestations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "staff_user_id" text NOT NULL REFERENCES "resupply"."admin_users"("id"),
  "policy_id" uuid NOT NULL REFERENCES "resupply"."accreditation_policies"("id") ON DELETE RESTRICT,
  "attested_at" timestamp with time zone NOT NULL DEFAULT now(),
  "signature_method" text NOT NULL DEFAULT 'click_through',
  "acknowledged_text" text NOT NULL,
  "ip" inet,
  "user_agent" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- (staff, policy) UNIQUE — re-attesting requires the policy author
-- to bump the version (which inserts a new accreditation_policies
-- row).
CREATE UNIQUE INDEX IF NOT EXISTS "admin_policy_attestations_staff_policy_unique"
  ON "resupply"."admin_policy_attestations" ("staff_user_id", "policy_id");

CREATE INDEX IF NOT EXISTS "admin_policy_attestations_policy_idx"
  ON "resupply"."admin_policy_attestations" ("policy_id");

CREATE INDEX IF NOT EXISTS "admin_policy_attestations_staff_idx"
  ON "resupply"."admin_policy_attestations" ("staff_user_id");
