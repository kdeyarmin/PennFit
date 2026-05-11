-- Seed: Medicare DMEPOS resupply cadences for the eligibility engine.
--
-- Why this seed exists
-- --------------------
-- Until now, CSRs held the per-payer resupply schedule in their heads
-- and case-by-case set patients.cadence_override_days. This file
-- codifies the standard Medicare LCD L33718 schedule as
-- frequency_rules so newly-onboarded patients pick up sane defaults
-- without an override and so the rule-tester surfaces an explanation
-- for why the engine picked a given cadence.
--
-- Resolution semantics (recap from frequency-rules.ts):
--   1. Per-patient overrides on `patients.cadence_override_days` win.
--   2. Otherwise, frequency_rules are evaluated in (priority asc,
--      created_at asc) order, FIRST match wins.
--   3. If no rule matches, fall back to `prescriptions.cadence_days`.
--
-- Priority choices
-- ----------------
--   * 200 — Medicare-specific rules. Match only when
--     `patients.insurance_payer = 'Medicare'`.
--   * 250 — NULL-payer fallback rules. Match any patient regardless
--     of payer, so commercial payers (Aetna/BCBS/UHC/Cigna/Humana)
--     pick up the same Medicare-baseline cadences until CSRs add
--     contract-specific rules ahead of them.
--
-- Admins can always insert higher-priority rules (priority < 200) to
-- override these defaults for a specific payer or contract.
--
-- SKU prefix conventions
-- ----------------------
-- Matches the uppercase-dashed convention used throughout the test
-- fixtures and admin-rule-tester defaults (MASK-NASAL-MED,
-- TUBING-STD-6FT, etc.). The Pacware-driven resupply catalog uses
-- this convention; the cash-pay Stripe storefront uses lowercase
-- which is intentionally NOT seeded here (storefront orders do not
-- run through the resupply eligibility engine).
--
-- Idempotency
-- -----------
-- Each row uses INSERT ... WHERE NOT EXISTS keyed on `name`. Re-running
-- this seed is a no-op once applied. Admins can rename a row in the
-- dashboard and the seed will re-insert the original (which is the
-- intended behaviour — the named seed row is the canonical default).

-- ── Medicare-specific (priority 200) ────────────────────────────────

INSERT INTO "resupply"."frequency_rules"
  (name, priority, match_item_sku_prefix, match_insurance_payer, cadence_days, default_channel, active, notes)
SELECT
  'Medicare — disposable filter (15 days, A7038)', 200, 'FILTER-DISP', 'Medicare', 15, NULL, true,
  'CMS LCD L33718. Two per month allowed.'
WHERE NOT EXISTS (SELECT 1 FROM "resupply"."frequency_rules" WHERE name = 'Medicare — disposable filter (15 days, A7038)');

INSERT INTO "resupply"."frequency_rules"
  (name, priority, match_item_sku_prefix, match_insurance_payer, cadence_days, default_channel, active, notes)
SELECT
  'Medicare — reusable filter (180 days, A7039)', 200, 'FILTER-REUSE', 'Medicare', 180, NULL, true,
  'CMS LCD L33718. One every 6 months.'
WHERE NOT EXISTS (SELECT 1 FROM "resupply"."frequency_rules" WHERE name = 'Medicare — reusable filter (180 days, A7039)');

INSERT INTO "resupply"."frequency_rules"
  (name, priority, match_item_sku_prefix, match_insurance_payer, cadence_days, default_channel, active, notes)
SELECT
  'Medicare — nasal pillows (14 days, A7033)', 200, 'PILLOW', 'Medicare', 14, NULL, true,
  'CMS LCD L33718. Two per month allowed.'
WHERE NOT EXISTS (SELECT 1 FROM "resupply"."frequency_rules" WHERE name = 'Medicare — nasal pillows (14 days, A7033)');

INSERT INTO "resupply"."frequency_rules"
  (name, priority, match_item_sku_prefix, match_insurance_payer, cadence_days, default_channel, active, notes)
SELECT
  'Medicare — mask cushion (30 days, A7031/A7032)', 200, 'CUSHION', 'Medicare', 30, NULL, true,
  'CMS LCD L33718. One per month for nasal or full-face cushion.'
WHERE NOT EXISTS (SELECT 1 FROM "resupply"."frequency_rules" WHERE name = 'Medicare — mask cushion (30 days, A7031/A7032)');

INSERT INTO "resupply"."frequency_rules"
  (name, priority, match_item_sku_prefix, match_insurance_payer, cadence_days, default_channel, active, notes)
SELECT
  'Medicare — mask interface (90 days, A7030/A7034)', 200, 'MASK', 'Medicare', 90, NULL, true,
  'CMS LCD L33718. One every 3 months for the full mask assembly.'
WHERE NOT EXISTS (SELECT 1 FROM "resupply"."frequency_rules" WHERE name = 'Medicare — mask interface (90 days, A7030/A7034)');

INSERT INTO "resupply"."frequency_rules"
  (name, priority, match_item_sku_prefix, match_insurance_payer, cadence_days, default_channel, active, notes)
SELECT
  'Medicare — headgear (180 days, A7035)', 200, 'HEADGEAR', 'Medicare', 180, NULL, true,
  'CMS LCD L33718. One every 6 months.'
WHERE NOT EXISTS (SELECT 1 FROM "resupply"."frequency_rules" WHERE name = 'Medicare — headgear (180 days, A7035)');

INSERT INTO "resupply"."frequency_rules"
  (name, priority, match_item_sku_prefix, match_insurance_payer, cadence_days, default_channel, active, notes)
SELECT
  'Medicare — chinstrap (180 days, A7036)', 200, 'CHINSTRAP', 'Medicare', 180, NULL, true,
  'CMS LCD L33718. One every 6 months.'
WHERE NOT EXISTS (SELECT 1 FROM "resupply"."frequency_rules" WHERE name = 'Medicare — chinstrap (180 days, A7036)');

INSERT INTO "resupply"."frequency_rules"
  (name, priority, match_item_sku_prefix, match_insurance_payer, cadence_days, default_channel, active, notes)
SELECT
  'Medicare — tubing (90 days, A7037/A4604)', 200, 'TUBING', 'Medicare', 90, NULL, true,
  'CMS LCD L33718. One every 3 months. Heated and standard tubing share the cadence.'
WHERE NOT EXISTS (SELECT 1 FROM "resupply"."frequency_rules" WHERE name = 'Medicare — tubing (90 days, A7037/A4604)');

INSERT INTO "resupply"."frequency_rules"
  (name, priority, match_item_sku_prefix, match_insurance_payer, cadence_days, default_channel, active, notes)
SELECT
  'Medicare — humidifier chamber (180 days, A7046)', 200, 'CHAMBER', 'Medicare', 180, NULL, true,
  'CMS LCD L33718. One every 6 months.'
WHERE NOT EXISTS (SELECT 1 FROM "resupply"."frequency_rules" WHERE name = 'Medicare — humidifier chamber (180 days, A7046)');

-- ── Cross-payer fallback (priority 250) ─────────────────────────────
-- Same cadences with NULL match_insurance_payer so commercial payers
-- (and uninsured cash-pay patients with a payer field set to anything
-- non-Medicare) inherit Medicare-equivalent defaults. CSRs override
-- with payer-specific rules at priority < 200 as contracts dictate.

INSERT INTO "resupply"."frequency_rules"
  (name, priority, match_item_sku_prefix, match_insurance_payer, cadence_days, default_channel, active, notes)
SELECT
  'Default — disposable filter (15 days)', 250, 'FILTER-DISP', NULL, 15, NULL, true,
  'Industry-standard fallback when no payer-specific rule matches.'
WHERE NOT EXISTS (SELECT 1 FROM "resupply"."frequency_rules" WHERE name = 'Default — disposable filter (15 days)');

INSERT INTO "resupply"."frequency_rules"
  (name, priority, match_item_sku_prefix, match_insurance_payer, cadence_days, default_channel, active, notes)
SELECT
  'Default — reusable filter (180 days)', 250, 'FILTER-REUSE', NULL, 180, NULL, true,
  'Industry-standard fallback when no payer-specific rule matches.'
WHERE NOT EXISTS (SELECT 1 FROM "resupply"."frequency_rules" WHERE name = 'Default — reusable filter (180 days)');

INSERT INTO "resupply"."frequency_rules"
  (name, priority, match_item_sku_prefix, match_insurance_payer, cadence_days, default_channel, active, notes)
SELECT
  'Default — nasal pillows (14 days)', 250, 'PILLOW', NULL, 14, NULL, true,
  'Industry-standard fallback when no payer-specific rule matches.'
WHERE NOT EXISTS (SELECT 1 FROM "resupply"."frequency_rules" WHERE name = 'Default — nasal pillows (14 days)');

INSERT INTO "resupply"."frequency_rules"
  (name, priority, match_item_sku_prefix, match_insurance_payer, cadence_days, default_channel, active, notes)
SELECT
  'Default — mask cushion (30 days)', 250, 'CUSHION', NULL, 30, NULL, true,
  'Industry-standard fallback when no payer-specific rule matches.'
WHERE NOT EXISTS (SELECT 1 FROM "resupply"."frequency_rules" WHERE name = 'Default — mask cushion (30 days)');

INSERT INTO "resupply"."frequency_rules"
  (name, priority, match_item_sku_prefix, match_insurance_payer, cadence_days, default_channel, active, notes)
SELECT
  'Default — mask interface (90 days)', 250, 'MASK', NULL, 90, NULL, true,
  'Industry-standard fallback when no payer-specific rule matches.'
WHERE NOT EXISTS (SELECT 1 FROM "resupply"."frequency_rules" WHERE name = 'Default — mask interface (90 days)');

INSERT INTO "resupply"."frequency_rules"
  (name, priority, match_item_sku_prefix, match_insurance_payer, cadence_days, default_channel, active, notes)
SELECT
  'Default — headgear (180 days)', 250, 'HEADGEAR', NULL, 180, NULL, true,
  'Industry-standard fallback when no payer-specific rule matches.'
WHERE NOT EXISTS (SELECT 1 FROM "resupply"."frequency_rules" WHERE name = 'Default — headgear (180 days)');

INSERT INTO "resupply"."frequency_rules"
  (name, priority, match_item_sku_prefix, match_insurance_payer, cadence_days, default_channel, active, notes)
SELECT
  'Default — tubing (90 days)', 250, 'TUBING', NULL, 90, NULL, true,
  'Industry-standard fallback when no payer-specific rule matches.'
WHERE NOT EXISTS (SELECT 1 FROM "resupply"."frequency_rules" WHERE name = 'Default — tubing (90 days)');

INSERT INTO "resupply"."frequency_rules"
  (name, priority, match_item_sku_prefix, match_insurance_payer, cadence_days, default_channel, active, notes)
SELECT
  'Default — humidifier chamber (180 days)', 250, 'CHAMBER', NULL, 180, NULL, true,
  'Industry-standard fallback when no payer-specific rule matches.'
WHERE NOT EXISTS (SELECT 1 FROM "resupply"."frequency_rules" WHERE name = 'Default — humidifier chamber (180 days)');
