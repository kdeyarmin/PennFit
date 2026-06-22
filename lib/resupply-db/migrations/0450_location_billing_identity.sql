-- 0450_location_billing_identity — Multi-location Phase 1: per-branch
-- billing identity fields on resupply.locations.
--
-- Background. resupply.locations (migration 0235) are BUSINESS BRANCHES
-- (name / code / address / phone / npi / is_primary). The multi_location
-- flag (0257) is a UI/grouping shell and — per its own note — NEVER
-- touches claims today: every branch's 837P goes out under the single
-- org-level dme_organization NPI/PTAN/address.
--
-- A real multi-branch DME must bill each branch under its OWN NPI/PTAN.
-- `locations.npi` already exists as the anchor; this migration adds the
-- remaining billing-identity fields a branch needs so the identity
-- resolver can build a location-level BillingProvider when a servicing
-- patient is anchored to that branch.
--
-- ALL columns are nullable + additive: every existing locations row stays
-- valid, and the resolver treats a location with no billing NPI as
-- "no location identity" → it falls back to the org-level identity, byte
-- for byte. So a single-location deployment (and the flag-off default) is
-- completely unaffected: nothing reads these columns unless
-- multi_location.enabled is ON and the location carries a billing NPI.
--
-- Out of scope by design (architecture Rule 14): locations are NOT
-- warehouses; this migration adds no inventory/stock concept. Phase 1 is
-- billing identity ONLY.
--
-- Plain table (no RLS), service-role only. Per ADR 003 — versioned
-- hand-authored migration; additive nullable columns are non-breaking.

ALTER TABLE "resupply"."locations"
  -- Legal/billing name for the branch. NULL → fall back to the org legal
  -- name (and ultimately the org-level identity).
  ADD COLUMN IF NOT EXISTS "billing_legal_name" text,
  -- Tax ID (EIN) the branch bills under. NULL → org tax_id.
  ADD COLUMN IF NOT EXISTS "billing_tax_id" text,
  -- Medicare PTAN for the branch. NULL → org medicare_ptan.
  ADD COLUMN IF NOT EXISTS "billing_ptan" text,
  -- Branch billing address (837P loop 2010AA). NULL on any field → the
  -- resolver uses the branch's own physical address columns (address_*),
  -- and ultimately the org-level address. Kept separate from the
  -- branch's physical/contact address so a branch can bill to a different
  -- address than it operates from (e.g. a central billing office).
  ADD COLUMN IF NOT EXISTS "billing_address_line1" text,
  ADD COLUMN IF NOT EXISTS "billing_address_line2" text,
  ADD COLUMN IF NOT EXISTS "billing_city" text,
  ADD COLUMN IF NOT EXISTS "billing_state" text,
  ADD COLUMN IF NOT EXISTS "billing_zip" text;
