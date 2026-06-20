-- 0235_locations_groundwork — multi-location (multi-branch) GROUNDWORK
-- (owner #O1, step 1 of N).
--
-- PennFit is single-tenant today (one singleton dme_organization). This
-- is the NON-BREAKING first step toward multiple branches: a business-
-- location table + nullable location_id anchors on the two tables that
-- most naturally belong to a branch (staff home location + patient
-- servicing location). It deliberately does NOT re-scope any query —
-- every existing read/write is unchanged because location_id is nullable
-- and nothing filters on it yet. The data-scoping rewrite (RBAC by
-- location, per-branch analytics, etc.) is a separate, larger effort
-- gated on a business decision.
--
-- NOTE: `locations` here are BUSINESS branches (where staff work /
-- patients are serviced) — NOT warehouses or any inventory concept.
-- Inventory/warehousing remains Pacware's system of record (arch Rule
-- 14); this table never tracks stock.
--
-- Plain table (no RLS), service-role only. Per ADR 003 — versioned
-- hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."locations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "code" text,
  "address_line1" text,
  "address_line2" text,
  "city" text,
  "state" text,
  "postal_code" text,
  "phone_e164" text,
  "npi" text,
  "is_primary" boolean NOT NULL DEFAULT false,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "locations_name_chk" CHECK (length(btrim("name")) > 0)
);
--> statement-breakpoint

-- At most one primary location. Partial unique index over the single
-- TRUE value (NULL/false rows are unconstrained).
CREATE UNIQUE INDEX IF NOT EXISTS "locations_single_primary_idx"
  ON "resupply"."locations" ("is_primary")
  WHERE "is_primary" = true;
--> statement-breakpoint

-- Nullable anchors. Additive + nullable → every existing row stays valid
-- and every existing query is unaffected.
ALTER TABLE "resupply"."patients"
  ADD COLUMN IF NOT EXISTS "location_id" uuid
  REFERENCES "resupply"."locations"("id");
--> statement-breakpoint
ALTER TABLE "resupply"."admin_users"
  ADD COLUMN IF NOT EXISTS "location_id" uuid
  REFERENCES "resupply"."locations"("id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "patients_location_idx"
  ON "resupply"."patients" ("location_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_users_location_idx"
  ON "resupply"."admin_users" ("location_id");
