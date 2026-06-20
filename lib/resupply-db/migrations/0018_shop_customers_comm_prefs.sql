-- shop_customers.communication_preferences — opt-in marketing flags
-- and DND window for the cash-pay storefront.
--
-- Why a JSONB blob and not flat columns:
--   The opt-in matrix is going to grow — language, channel weighting,
--   time-of-day preferences, frequency caps, etc. JSONB lets us add
--   keys without a migration each time, and the cardinality of any
--   single key is too low for an indexed column to pay off.
--
-- Default null (treated as "all transactional + opt-in marketing OFF
-- by default; abandoned-cart nudges OPT-IN by US default)" by every
-- dispatcher. We don't backfill — pre-existing shop_customers rows
-- inherit defaults the first time they're read.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "communication_preferences" jsonb;
