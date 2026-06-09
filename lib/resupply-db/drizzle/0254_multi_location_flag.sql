-- 0254_multi_location_flag — Control Center toggle for the multi-branch
-- (multi-location) feature.
--
-- PennFit is single-branch by default. The multi-location feature
-- (owner #O1) lets a company register multiple business branches and
-- assign patients + staff to them, with a per-branch rollup. A
-- single-location DME never needs any of that, so the whole surface is
-- gated behind this flag:
--   * ON  — the Locations admin page, the patient/staff branch pickers,
--            the patients-list branch filter, and the soft "default to
--            my branch" behavior are all shown.
--   * OFF — none of the branch UI appears; the app behaves exactly as it
--            did pre-multi-location (the location_id columns simply stay
--            null). Billing identity is shared at the org level either
--            way, so this flag never touches claims.
--
-- Seeded DISABLED so existing single-branch deployments see no change
-- until an admin opts in from the Control Center. INSERT … ON CONFLICT
-- DO NOTHING keeps re-runs idempotent and never clobbers an admin's
-- intentional toggle.
--
-- Keep in sync with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts.

INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('multi_location.enabled',
   false,
   'Multi-branch company. When ON, the admin console shows the Locations page plus per-patient and per-staff branch assignment, a branch filter on the patients list, and per-branch counts. When OFF (the default), the company is treated as a single branch and none of the branch UI appears. Billing identity is shared at the org level in both modes.',
   'Operations')
ON CONFLICT (key) DO NOTHING;
