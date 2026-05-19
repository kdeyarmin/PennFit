-- 0122_shop_customers_winback_tracking — idempotency stamps for the
-- annual deductible-reset campaign and the lapsed-customer win-back
-- dispatcher.
--
-- Both new workers need to remember "have we already sent this to
-- this customer in this cycle?" without scanning bulk-campaign rows
-- (those are too generic to enforce a per-customer-per-cycle gate).
-- One column each, both nullable:
--
--   winback_sent_at         — timestamp of the most recent
--                             lapsed-customer win-back email. The
--                             dispatcher requires this to be NULL
--                             or older than 365 days before sending
--                             again. Net effect: at most one win-
--                             back per customer per year.
--
--   deductible_reset_year   — the 4-digit calendar year of the most
--                             recent deductible-reset push for this
--                             customer. The Nov-1 cron compares
--                             against the current year and skips
--                             customers already stamped. Storing
--                             the year (vs. a timestamp) keeps the
--                             "did we already send this cycle?"
--                             check trivial and survives clock
--                             drift / re-runs in the same day.
--
-- Both columns are nullable; legacy rows pre-this-migration are
-- treated as "never sent" by both workers.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "winback_sent_at"
    timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "deductible_reset_year"
    integer;
--> statement-breakpoint

-- Hot query for the win-back dispatcher: rows never-sent or sent
-- more than 365 days ago. The partial index keeps the index small
-- enough that the dispatcher's daily scan stays cheap even as the
-- shop_customers table grows.
CREATE INDEX IF NOT EXISTS "shop_customers_winback_eligible_idx"
  ON "resupply"."shop_customers" ("winback_sent_at" NULLS FIRST);
