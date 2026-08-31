-- 0541_pacware_shipment_import_ledger — remember which shipment files
-- have been imported, and record every ship date that could not be
-- changed in place.
--
-- TWO GAPS, ONE TABLE EACH
-- ------------------------
--
-- 1. NOTHING REMEMBERS A FILE.
--    `POST /admin/pacware/import/shipments` accepts an `Idempotency-Key`
--    header, which stops a double-submit of the same REQUEST. It does
--    nothing about the far more common accident: the same exported file
--    uploaded twice — a fresh browser tab, a colleague repeating the
--    step, a retry after a timeout that had actually succeeded.
--
--    Per-row idempotency does hold (recordShipmentEvidence claims the
--    fulfillment with `.is("shipped_at", null)`, so a second pass is a
--    no-op), which is why this has never corrupted anything. But the
--    operator gets no signal at all: the second import reports the same
--    counts as the first with everything "unchanged", and there is no way
--    to tell that from a file that legitimately contained nothing new.
--
--    `pacware_shipment_imports` stores a CONTENT HASH per commit. A
--    re-upload is recognised and refused unless the operator explicitly
--    says they meant it.
--
-- 2. A SHIP DATE THAT HAS BEEN BILLED CANNOT BE CORRECTED IN PLACE.
--    `fulfillments.shipped_at` becomes the date of service on an 837P.
--    Once a claim carries it, the payer has been told something. A later
--    import carrying a different date for the same order must not
--    silently overwrite it — the claim and the record would disagree
--    with nobody knowing, and the disagreement surfaces as a denial
--    weeks later.
--
--    Today `recordShipmentEvidence` simply returns `already_recorded`
--    and drops the new date on the floor. Safe, but silent: the
--    correction the warehouse sent is lost.
--
--    `shipment_date_exceptions` records the conflict — both dates, the
--    claim it affects — and leaves it for a person.
--
-- PHI: neither table stores a report row, a patient identifier, a name,
-- or a SKU. Hashes, counts, internal UUIDs and dates only.

CREATE TABLE IF NOT EXISTS "resupply"."pacware_shipment_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  -- SHA-256 of the normalized report text. Normalized (line endings,
  -- BOM, trailing newline) so a file re-saved from Excel is recognised
  -- as the same file — those edits change every byte and no meaning.
  "file_hash" text NOT NULL,
  "mode" text NOT NULL,
  "total_data_rows" integer DEFAULT 0 NOT NULL,
  "applied_count" integer DEFAULT 0 NOT NULL,
  -- Per-disposition tallies: matched, ambiguous, unmatched, duplicate,
  -- cancelled, invalid, too_old, future_dated, already_recorded,
  -- date_conflict. Kept as jsonb rather than ten columns because the
  -- vocabulary is owned by
  -- lib/resupply-integrations-pacware/src/shipment-classify.ts and a
  -- new disposition must not require a migration.
  "dispositions" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "oldest_ship_date" date,
  "newest_ship_date" date,
  -- True when the operator knowingly re-imported a file already on file.
  "reimport_acknowledged" boolean DEFAULT false NOT NULL,
  "imported_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "resupply"."pacware_shipment_imports"
    ADD CONSTRAINT "pacware_shipment_imports_org_fk"
    FOREIGN KEY ("org_id") REFERENCES "resupply"."organizations"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "resupply"."pacware_shipment_imports"
    ADD CONSTRAINT "pacware_shipment_imports_mode_enum"
    CHECK ("mode" IN ('preview', 'commit'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- Only COMMITS claim a hash. A preview is a question, not an event: an
-- operator previewing the same file five times while they work out what
-- it will do must not be told they already imported it.
--
-- Partial-unique rather than a plain unique index for the same reason,
-- and scoped per tenant because two tenants can legitimately receive
-- byte-identical reports from the same warehouse.
CREATE UNIQUE INDEX IF NOT EXISTS "pacware_shipment_imports_commit_hash_idx"
  ON "resupply"."pacware_shipment_imports" ("org_id", "file_hash")
  WHERE "mode" = 'commit';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "pacware_shipment_imports_org_created_idx"
  ON "resupply"."pacware_shipment_imports" ("org_id", "created_at" DESC);
--> statement-breakpoint

-- ── Ship-date correction exceptions ──────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."shipment_date_exceptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "fulfillment_id" uuid NOT NULL,
  -- What is on file now. This is the date a claim was built on.
  "recorded_shipped_at" timestamp with time zone NOT NULL,
  -- What the new import says it should be.
  "proposed_shipped_at" timestamp with time zone NOT NULL,
  -- The claim, when the recorded date has already gone out on one.
  "claim_id" uuid,
  "source" text DEFAULT 'pacware_import' NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "resolution" text,
  "resolution_note" text,
  "raised_by_email" text,
  "resolved_by_email" text,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "resupply"."shipment_date_exceptions"
    ADD CONSTRAINT "shipment_date_exceptions_org_fk"
    FOREIGN KEY ("org_id") REFERENCES "resupply"."organizations"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- ON DELETE CASCADE: an exception about a fulfillment that no longer
-- exists has nothing to resolve.
DO $$ BEGIN
  ALTER TABLE "resupply"."shipment_date_exceptions"
    ADD CONSTRAINT "shipment_date_exceptions_fulfillment_fk"
    FOREIGN KEY ("fulfillment_id")
    REFERENCES "resupply"."fulfillments"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "resupply"."shipment_date_exceptions"
    ADD CONSTRAINT "shipment_date_exceptions_status_enum"
    CHECK ("status" IN ('open', 'resolved'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- The four things a person can decide. `corrected` is the only one that
-- rewrites the ship date, and it is expected to be paired with a
-- corrected claim.
DO $$ BEGIN
  ALTER TABLE "resupply"."shipment_date_exceptions"
    ADD CONSTRAINT "shipment_date_exceptions_resolution_enum"
    CHECK ("resolution" IS NULL OR "resolution" IN (
      'kept_recorded', 'corrected', 'duplicate_report', 'invalid_report'
    ));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- A resolved exception must say what was decided, and an open one must
-- not pretend to. Enforced in the database because two writers reach
-- this table (the import route and the resolution route).
DO $$ BEGIN
  ALTER TABLE "resupply"."shipment_date_exceptions"
    ADD CONSTRAINT "shipment_date_exceptions_resolved_has_resolution"
    CHECK (
      ("status" = 'open' AND "resolution" IS NULL)
      OR ("status" = 'resolved' AND "resolution" IS NOT NULL)
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- One OPEN exception per fulfillment. A repeated import of the same
-- conflicting file must not queue the same decision ten times; a fresh
-- conflict after the first is resolved legitimately opens a new one.
CREATE UNIQUE INDEX IF NOT EXISTS "shipment_date_exceptions_open_idx"
  ON "resupply"."shipment_date_exceptions" ("org_id", "fulfillment_id")
  WHERE "status" = 'open';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "shipment_date_exceptions_org_status_idx"
  ON "resupply"."shipment_date_exceptions" ("org_id", "status", "created_at" DESC);
