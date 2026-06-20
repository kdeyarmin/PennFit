-- 0342_asset_recovery_auto_populate_flag — Control Center toggle for the
-- nightly asset-recovery auto-population worker.
--
-- When ENABLED, the `asset-recovery.auto-populate` pg-boss job
-- (artifacts/resupply-api/src/worker/jobs/asset-recovery-auto-populate.ts)
-- opens an asset_recovery_cases row for each patient with a recent,
-- undismissed `usage_dropping` smart-trigger event that doesn't already
-- have an open case. When OFF, recovery cases are created only manually
-- via /admin/asset-recovery.
--
-- Seeded OFF: auto-creating cases is an operational action, so it is
-- opt-in. The worker no-ops while the flag is unset/disabled.
--
-- Keep in sync with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts.
--
-- Per ADR 003 — versioned hand-authored migration.

INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES (
  'asset_recovery.auto_populate',
  false,
  'Nightly auto-population of asset-recovery cases from discontinuation signals (undismissed usage-dropping smart triggers). When off, cases are opened only manually from /admin/asset-recovery.',
  'Resupply'
)
ON CONFLICT (key) DO NOTHING;
