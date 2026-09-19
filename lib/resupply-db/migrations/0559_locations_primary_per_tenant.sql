-- Scope the "one primary location" rule to the TENANT.
--
-- 0235 created:
--   CREATE UNIQUE INDEX locations_single_primary_idx
--     ON resupply.locations (is_primary) WHERE is_primary = true;
--
-- The comment beside it read "At most one primary location", which is the right
-- rule — but the index key is `(is_primary)` with no `org_id`, so it enforced
-- at most one primary location ACROSS THE WHOLE PLATFORM. Once any single
-- tenant designated a primary branch, every other tenant's attempt failed with
--   duplicate key value violates unique constraint "locations_single_primary_idx"
--   DETAIL: Key (is_primary)=(t) already exists.
-- Nothing in the app layer could work around it: `clearExistingPrimary()` in
-- routes/admin/locations.ts correctly clears only the CALLER's org through the
-- org-scoped client, so the row blocking the insert belongs to a tenant the
-- request may not even read.
--
-- The replacement keys on `(org_id)` over the same partial predicate, which is
-- what the original comment described. It is strictly LOOSER than what it
-- replaces — any data satisfying "one primary globally" also satisfies "one
-- primary per org" — so there is no backfill and no possible violation at
-- create time.

DROP INDEX IF EXISTS "resupply"."locations_single_primary_idx";
--> statement-breakpoint

-- At most one primary location PER TENANT. Partial unique index over the
-- single TRUE value (false rows are unconstrained, so a tenant may have any
-- number of non-primary locations).
CREATE UNIQUE INDEX IF NOT EXISTS "locations_single_primary_per_org_idx"
  ON "resupply"."locations" ("org_id")
  WHERE "is_primary" = true;
