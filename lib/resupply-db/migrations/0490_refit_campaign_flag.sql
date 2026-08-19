-- 0490_refit_campaign_flag — proactive re-fit outreach, seeded OFF.
--
-- Why
-- ---
-- Every fitter campaign this platform runs targets NEW leads: the
-- first-day nudge, the re-engage sweep, the six-touch supply campaign.
-- Nothing ever goes back to a patient already on service. So a patient
-- who told us their mask leaks — through the post-delivery survey we
-- ourselves sent — gets that answer filed into a staff worklist and
-- hears nothing, and a patient wearing a mask the manufacturer has since
-- discontinued keeps wearing it until something breaks.
--
-- This flag gates a scan that closes both loops by offering those
-- patients a fresh fitting.
--
-- Seeded OFF, and it must stay that way until a tenant decides
-- otherwise. This is unsolicited patient contact: it carries the same
-- consent, TCPA and quiet-hours weight as any other outreach, and the
-- decision to start it belongs to the DME, not to a deploy. The job
-- additionally requires an opt-in boot env var, so a tenant flipping
-- this flag alone still sends nothing until an operator has deliberately
-- enabled the worker too — the same two-key pattern the other
-- patient-contacting dispatchers use.
--
-- Keep in lockstep with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts — a key here that is
-- missing there silently no-ops in the admin toggle UI.
--
-- Per ADR 003 — versioned hand-authored migration.

-- Unquoted `resupply.feature_flags`, matching 0485 and every other flag
-- seed: the catalog drift guard (feature-flags.catalog.test.ts) scans
-- migrations for that literal string to decide which files to parse, so
-- the quoted form would make this seed invisible to it and the key would
-- read as "in code but never seeded".
INSERT INTO resupply.feature_flags
  ("org_id", "key", "enabled", "description", "category")
SELECT
  o."id",
  v."key",
  v."enabled",
  v."description",
  v."category"
FROM resupply.organizations o
CROSS JOIN (VALUES
  ('fitter.refit_campaign',
   false,
   'Proactive re-fit outreach to patients already on service. Offers a '
     || 'fresh mask fitting to patients who reported a leaking or '
     || 'uncomfortable fit on the post-delivery survey, and to patients '
     || 'wearing a mask the manufacturer has discontinued. One message '
     || 'per patient per quarter, subject to the usual consent, '
     || 'quiet-hours and do-not-disturb rules. OFF: those patients hear '
     || 'nothing until staff reach out by hand.',
   'Clinical')
) AS v("key", "enabled", "description", "category")
ON CONFLICT ("org_id", "key") DO NOTHING;
