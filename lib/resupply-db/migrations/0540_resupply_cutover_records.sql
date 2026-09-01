-- 0540_resupply_cutover_records — an auditable record of every
-- per-tenant resupply lifecycle cutover.
--
-- THE GAP
-- -------
-- `resupply.due_at_authoritative` and `resupply.ship_evidence_required`
-- (migration 0538) both change WHEN a live patient is next contacted.
-- They are seeded OFF and are meant to be flipped tenant by tenant, only
-- after that tenant's data has been shown to be ready.
--
-- But they are ordinary feature flags. Nothing recorded that a readiness
-- check was ever run, what it said, or who decided the tenant was ready.
-- `feature_flag_events` records THAT a toggle happened; it cannot record
-- the evidence the toggle was based on. So six weeks later, when a
-- tenant's patients are being reminded at the wrong time, there is no way
-- to answer "was this tenant assessed, and did the assessment pass?".
--
-- WHAT THIS ADDS
-- --------------
-- One row per cutover DECISION — enable, rollback, or a standalone
-- readiness evaluation — carrying:
--
--   * which flag, previous value, new value;
--   * who decided and when;
--   * the readiness VERDICT and the full readiness REPORT it came from;
--   * `evidence_id`, a stable identifier the operator also puts on the
--     ticket, so a row here and a validation record outside the system
--     can be tied together;
--   * `rollback_reason` when a flag is turned back off.
--
-- READINESS EXPIRES. A tenant assessed in March and flipped in July was
-- not really assessed: the book of business moved underneath the
-- evaluation. `evaluated_at` plus a TTL in application code is what makes
-- "Validation expired" a state the console can show, rather than a
-- distinction nobody can draw.
--
-- PHI
-- ---
-- `report` holds COUNTS, drift statistics, and a capped sample of
-- INTERNAL episode UUIDs. No names, no contact details, no payer, no
-- clinical content. The readiness assessor is what enforces that; this
-- comment is the contract it is written against.

CREATE TABLE IF NOT EXISTS "resupply"."resupply_cutover_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "flag_key" text NOT NULL,
  "action" text NOT NULL,
  "previous_value" boolean,
  "new_value" boolean,
  "readiness_status" text NOT NULL,
  "report" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "evidence_id" text,
  "rollback_reason" text,
  "actor_email" text,
  "actor_user_id" text,
  "evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "resupply"."resupply_cutover_records"
    ADD CONSTRAINT "resupply_cutover_records_org_fk"
    FOREIGN KEY ("org_id") REFERENCES "resupply"."organizations"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- Validating CHECKs, not NOT VALID: the table is brand new and empty, so
-- there is no historical row that could be broken by enforcing them. (See
-- migration 0539 and docs/runbooks/validate-episode-constraints.md for
-- why NOT VALID is only ever a concession to existing data.)
DO $$ BEGIN
  ALTER TABLE "resupply"."resupply_cutover_records"
    ADD CONSTRAINT "resupply_cutover_records_flag_enum"
    CHECK ("flag_key" IN (
      'resupply.due_at_authoritative',
      'resupply.ship_evidence_required'
    ));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "resupply"."resupply_cutover_records"
    ADD CONSTRAINT "resupply_cutover_records_action_enum"
    CHECK ("action" IN ('evaluate', 'enable', 'rollback'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "resupply"."resupply_cutover_records"
    ADD CONSTRAINT "resupply_cutover_records_readiness_enum"
    CHECK ("readiness_status" IN ('ready', 'blocked', 'not_evaluated', 'error'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- An `enable` MUST carry a readiness verdict of `ready`. Expressed in the
-- database, not only in the route, because "we flipped it without an
-- assessment" is exactly the failure this table exists to make
-- impossible — and a second writer (the CLI) reaches the same table.
DO $$ BEGIN
  ALTER TABLE "resupply"."resupply_cutover_records"
    ADD CONSTRAINT "resupply_cutover_records_enable_requires_ready"
    CHECK ("action" <> 'enable' OR "readiness_status" = 'ready');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- A rollback must say why. A flag that went back off without a reason is
-- indistinguishable from one that was never turned on.
DO $$ BEGIN
  ALTER TABLE "resupply"."resupply_cutover_records"
    ADD CONSTRAINT "resupply_cutover_records_rollback_needs_reason"
    CHECK (
      "action" <> 'rollback'
      OR ("rollback_reason" IS NOT NULL AND length(btrim("rollback_reason")) >= 10)
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "resupply_cutover_records_org_flag_idx"
  ON "resupply"."resupply_cutover_records"
     ("org_id", "flag_key", "created_at" DESC);
--> statement-breakpoint

-- Deliberately NO flag writes in this migration. Neither
-- `due_at_authoritative` nor `ship_evidence_required` is enabled here,
-- for any tenant, ever: a migration runs on every deploy for every
-- tenant at once, which is the precise opposite of a per-tenant cutover
-- gated on that tenant's own evidence.
