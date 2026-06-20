-- 0409_rad_coverage_diagnoses — RAD (LCD L33800) diagnoses for E0470/E0471.
--
-- Extends the medical-necessity edit catalog (migration 0408) beyond the
-- PAP/OSA baseline (L33718) to the Respiratory Assist Device policy
-- (LCD L33800 / Policy Article A52517). RADs — E0470 (bilevel WITHOUT
-- backup rate) and E0471 (bilevel WITH backup rate / BiPAP-ST) — are
-- covered for FOUR non-OSA clinical categories, ALL seeded below:
--   * central sleep apnea (CSA) / complex sleep apnea
--   * sleep-related hypoventilation syndrome (incl. obesity hypoventilation)
--   * severe chronic obstructive pulmonary disease (COPD)
--   * restrictive thoracic disorders (neuromuscular disease + thoracic-cage
--     abnormality)
--
-- IMPORTANT — this is a CLINICAL CROSSWALK, not a CMS code table.
-- A52517 does NOT publish an enumerated "ICD-10 codes that support medical
-- necessity" list for RAD (the policy's Group 1 section is N/A): coverage is
-- narrative/criteria-driven (a qualifying diagnosis PLUS a physiologic test
-- — PaCO2, nocturnal SpO2, MIP/FVC — PLUS "COPD not the major contributor").
-- So these rows are screening SIGNALS for the preflight medical-necessity
-- warning (necessary-but-not-sufficient), never a hard coverage finding.
-- Their job here is to keep a genuine RAD claim from FALSE-warning; the
-- physiologic gates live in the documentation, out of this catalog's scope.
--
-- This completes the E0470/E0471 covered set so the preflight no longer
-- emits a false-positive `medical_necessity_dx` warning for a covered RAD
-- diagnosis (e.g. ALS / kyphoscoliosis) that an earlier partial seed missed.
-- It PRESERVES the E0471/OSA guard from 0408: obstructive sleep apnea
-- (G47.33) is NOT a RAD indication and is deliberately absent for E0471, so
-- an E0471 + primary-OSA claim still warns. E0470 keeps G47.33 from 0408
-- (the post-CPAP-failure OSA step-up under L33718) and so is dual-policy.
--
-- Codes are stored DOTLESS + uppercase to match 0408 and the evaluator's
-- normalisation (lib/billing/coverage-diagnosis.ts). The evaluator matches a
-- claim diagnosis by PREFIX, so a 3-char category root (e.g. 'G71') covers
-- its whole family. Roots are used ONLY where every leaf qualifies
-- (G12/G35/G70/G71/G72/G80/G82/M41); mixed families are stored as the
-- specific qualifying leaves so a prefix can't over-claim — e.g. kyphosis
-- M40.0/.1/.2 (NOT lordosis M40.3/.4/.5), the diaphragm leaf J98.6 (NOT all
-- of J98), and the thoracic Q67.5-.8 / Q76.3-.9 leaves (NOT skull/face or
-- spina-bifida-occulta siblings).
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

-- Both RAD devices share the same covered set (OSA G47.33 stays E0470-only,
-- seeded in 0408). A CROSS JOIN keeps the device × diagnosis grid DRY.
INSERT INTO "resupply"."hcpcs_coverage_diagnoses"
  (hcpcs_code, icd10_code, description, policy)
SELECT d.hcpcs, c.icd10, c.descr, 'LCD L33800'
FROM (VALUES ('E0470'), ('E0471')) AS d(hcpcs)
CROSS JOIN (VALUES
  -- Central / complex sleep apnea.
  ('G4731', 'Primary central sleep apnea'),
  ('G4737', 'Central sleep apnea in conditions classified elsewhere'),
  -- Sleep-related hypoventilation syndrome (incl. obesity hypoventilation).
  ('G4734', 'Idiopathic non-obstructive alveolar hypoventilation'),
  ('G4735', 'Congenital central alveolar hypoventilation'),
  ('G4736', 'Sleep related hypoventilation in conditions classified elsewhere'),
  ('E662',  'Obesity hypoventilation syndrome (morbid obesity w/ alveolar hypoventilation)'),
  -- Severe COPD (J44.x family).
  ('J44',   'Severe chronic obstructive pulmonary disease (J44.x)'),
  -- Restrictive thoracic — neuromuscular disease (safe family roots + leaves).
  ('G12',   'Motor neuron disease / spinal muscular atrophy incl. ALS (G12.x)'),
  ('G14',   'Postpolio syndrome'),
  ('G35',   'Multiple sclerosis (G35.x)'),
  ('G600',  'Hereditary motor and sensory neuropathy (Charcot-Marie-Tooth)'),
  ('G610',  'Guillain-Barre syndrome'),
  ('G6181', 'Chronic inflammatory demyelinating polyneuropathy'),
  ('G70',   'Myasthenia gravis / myoneural junction disorders (G70.x)'),
  ('G71',   'Muscular dystrophies / myopathies / myotonic disorders (G71.x)'),
  ('G72',   'Other and unspecified myopathies (G72.x)'),
  ('G80',   'Cerebral palsy (G80.x)'),
  ('G82',   'Paraplegia / quadriplegia (G82.x)'),
  ('J986',  'Disorders of diaphragm (diaphragmatic / phrenic paralysis)'),
  -- Restrictive thoracic — thoracic-cage abnormality (kyphosis/scoliosis,
  -- congenital spine & chest-wall; lordosis and non-thoracic siblings excluded).
  ('M400',  'Postural kyphosis (M40.0x)'),
  ('M401',  'Secondary kyphosis (M40.1x)'),
  ('M402',  'Other / unspecified kyphosis (M40.2x)'),
  ('M41',   'Scoliosis incl. neuromuscular scoliosis (M41.x)'),
  ('Q675',  'Congenital deformity of spine'),
  ('Q676',  'Pectus excavatum'),
  ('Q677',  'Pectus carinatum'),
  ('Q678',  'Other congenital deformity of chest'),
  ('Q763',  'Congenital scoliosis due to congenital bony malformation'),
  ('Q7641', 'Congenital kyphosis'),
  ('Q7649', 'Other congenital malformation of spine, not associated with scoliosis'),
  ('Q766',  'Other congenital malformations of ribs'),
  ('Q767',  'Congenital malformation of sternum'),
  ('Q768',  'Other congenital malformations of bony thorax'),
  ('Q769',  'Congenital malformation of bony thorax, unspecified')
) AS c(icd10, descr)
ON CONFLICT ("hcpcs_code", "icd10_code") DO NOTHING;
