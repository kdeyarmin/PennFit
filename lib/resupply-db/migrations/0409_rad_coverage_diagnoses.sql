-- 0409_rad_coverage_diagnoses — RAD (LCD L33800) diagnoses for E0470/E0471.
--
-- Extends the medical-necessity edit catalog (migration 0408) beyond the
-- PAP/OSA baseline (L33718) to the Respiratory Assist Device policy
-- (LCD L33800 / Policy Article A52517). RADs — E0470 (bilevel WITHOUT
-- backup rate) and E0471 (bilevel WITH backup rate / BiPAP-ST) — are
-- covered for four NON-OSA clinical categories. This migration seeds the
-- first three; the fourth (restrictive thoracic) is intentionally DEFERRED
-- (see the Scope note below), so it is NOT yet covered by the catalog:
--   * central sleep apnea (CSA) / complex sleep apnea                [seeded]
--   * sleep-related hypoventilation syndrome (incl. obesity hypovent.) [seeded]
--   * severe chronic obstructive pulmonary disease (COPD)            [seeded]
--   * restrictive thoracic disorders (neuromuscular / chest-wall)    [deferred]
--
-- Why this matters for the preflight edit: without these rows, an E0471
-- claim carrying a genuine RAD diagnosis (e.g. primary central sleep apnea
-- G47.31) would get "no opinion". More importantly, this PRESERVES the
-- E0471/OSA guard from 0408 — obstructive sleep apnea (G47.33) is
-- deliberately NOT seeded for E0471, so an E0471 line with a primary OSA
-- diagnosis still warns (OSA does not justify a backup-rate device under
-- L33718). E0470 already carries G47.33 (L33718, the post-CPAP-failure
-- step-up) from 0408 and gains the RAD set here, so it is dual-policy.
--
-- Scope note: the broad restrictive-thoracic / neuromuscular ICD-10 family
-- (a long list in A52517: muscular dystrophies, ALS, post-polio,
-- kyphoscoliosis, ...) is intentionally NOT enumerated here — a CPAP/PAP
-- resupply shop rarely bills it, an incomplete partial list is worse than
-- none, and an uncatalogued diagnosis yields "no opinion" (never a false
-- "covered"). Seed it (and any per-payer override) as a follow-on.
--
-- Codes are stored DOTLESS + uppercase to match 0408 and the evaluator's
-- normalisation (lib/billing/coverage-diagnosis.ts). 'J44' is stored as a
-- 3-char category prefix — every J44.x is COPD — and the evaluator's prefix
-- match covers J44.0/J44.1/J44.9.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

INSERT INTO "resupply"."hcpcs_coverage_diagnoses"
  (hcpcs_code, icd10_code, description, policy)
VALUES
  -- E0470 — bilevel without backup rate (entry RAD for all categories).
  ('E0470', 'G4731', 'Primary central sleep apnea', 'LCD L33800'),
  ('E0470', 'G4737', 'Central sleep apnea in conditions classified elsewhere', 'LCD L33800'),
  ('E0470', 'G4734', 'Idiopathic non-obstructive alveolar hypoventilation', 'LCD L33800'),
  ('E0470', 'G4735', 'Congenital central alveolar hypoventilation', 'LCD L33800'),
  ('E0470', 'G4736', 'Sleep related hypoventilation in conditions classified elsewhere', 'LCD L33800'),
  ('E0470', 'E662',  'Obesity hypoventilation syndrome (morbid obesity w/ alveolar hypoventilation)', 'LCD L33800'),
  ('E0470', 'J44',   'Severe chronic obstructive pulmonary disease (J44.x)', 'LCD L33800'),
  -- E0471 — bilevel WITH backup rate. Same RAD categories; OSA (G47.33) is
  -- intentionally absent (see header).
  ('E0471', 'G4731', 'Primary central sleep apnea', 'LCD L33800'),
  ('E0471', 'G4737', 'Central sleep apnea in conditions classified elsewhere', 'LCD L33800'),
  ('E0471', 'G4734', 'Idiopathic non-obstructive alveolar hypoventilation', 'LCD L33800'),
  ('E0471', 'G4735', 'Congenital central alveolar hypoventilation', 'LCD L33800'),
  ('E0471', 'G4736', 'Sleep related hypoventilation in conditions classified elsewhere', 'LCD L33800'),
  ('E0471', 'E662',  'Obesity hypoventilation syndrome (morbid obesity w/ alveolar hypoventilation)', 'LCD L33800'),
  ('E0471', 'J44',   'Severe chronic obstructive pulmonary disease (J44.x)', 'LCD L33800')
ON CONFLICT ("hcpcs_code", "icd10_code") DO NOTHING;
