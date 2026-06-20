-- 0411_insurance_discovery_addon — "Insurance discovery" platform billing
-- add-on + its `insurance.discovery` feature-flag gate.
--
-- Insurance discovery searches Office Ally's payer network from patient
-- demographics to find ACTIVE coverage when the patient's insurance is
-- unknown, or a coverage on file came back inactive. It is sold as a paid
-- add-on (this migration seeds the catalog row) and gated per-tenant by the
-- `insurance.discovery` feature flag. As with every other paid feature
-- (e.g. the AI voice agent / `voice.agent`), buying the add-on is the
-- COMMERCIAL entitlement and is decoupled from the runtime gate: the add-on
-- row records billing, while turning the feature ON is a separate admin step
-- — flip `insurance.discovery` in Control Center / System Configuration. The
-- discovery route refuses to run while the flag is off.
--
-- ADDITIVE / idempotent, but the two ON CONFLICT clauses behave differently:
--   * billing_addons uses DO UPDATE, so re-running this migration REFRESHES
--     the catalog row (name, price, etc.) from the values here. Re-runs are
--     ledger-gated (the migrator applies each file once), so this only fires
--     on an intentional replay — it is NOT a place that preserves a price a
--     platform owner later edited in the catalog UI; such an edit would be
--     reset by a replay. Edit the price in the UI (or a new migration), not
--     by re-running this one.
--   * feature_flags uses DO NOTHING, so a re-run never clobbers an
--     intentional toggle.
--
-- Two concerns, two tables:
--   1. billing_addons      — the global catalog row (premium, recurring).
--   2. feature_flags       — one per-tenant gate row, seeded OFF.

-- 1. Catalog add-on. Premium, recurring; each discovery search is a billable
--    clearinghouse round-trip metered as billingTransactionsPerMonth (the
--    same meter as eligibility checks), and per-search clearinghouse fees
--    pass through.
INSERT INTO "resupply"."billing_addons" ("code", "name", "category", "description", "recurring_price_cents", "one_time_min_cents", "one_time_max_cents", "unit_label", "usage_metric", "pass_through_note", "sort_order") VALUES
('insurance_discovery','Insurance discovery','premium','Search the payer network from patient demographics to find active coverage when insurance is unknown or a coverage on file came back inactive.',29900,NULL,NULL,'month','billingTransactionsPerMonth','Per-search clearinghouse discovery fees pass through.',95)
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "category" = EXCLUDED."category",
  "description" = EXCLUDED."description",
  "recurring_price_cents" = EXCLUDED."recurring_price_cents",
  "one_time_min_cents" = EXCLUDED."one_time_min_cents",
  "one_time_max_cents" = EXCLUDED."one_time_max_cents",
  "unit_label" = EXCLUDED."unit_label",
  "usage_metric" = EXCLUDED."usage_metric",
  "pass_through_note" = EXCLUDED."pass_through_note",
  "sort_order" = EXCLUDED."sort_order",
  "updated_at" = now();
--> statement-breakpoint

-- 2. Feature-flag gate, seeded DISABLED — it's a paid add-on that triggers
--    real clearinghouse spend, so it must be an explicit opt-in (enabled when
--    a tenant buys the add-on). feature_flags is PER-TENANT since migration
--    0350 (PK (org_id, key)); seed one row per organization and conflict on
--    (org_id, key). Keep in sync with FEATURE_FLAG_KEYS in
--    artifacts/resupply-api/src/lib/feature-flags.ts.
INSERT INTO resupply.feature_flags ("org_id", "key", "enabled", "description", "category")
SELECT o."id", v."key", v."enabled", v."description", v."category"
FROM "resupply"."organizations" o
CROSS JOIN (VALUES
  ('insurance.discovery', false, 'Insurance discovery add-on. When ON (and the Office Ally discovery endpoint is configured), staff can search the payer network from a patient''s demographics to find active coverage when their insurance is unknown or a coverage on file came back inactive. Seeded OFF — it is a paid add-on that triggers real clearinghouse spend, so enable it for tenants that have purchased it.', 'Billing')
) AS v("key", "enabled", "description", "category")
ON CONFLICT ("org_id", "key") DO NOTHING;
