-- 0150_report_presets — saved report shortcuts for the admin
-- Reports page.
--
-- An admin builds a report by picking a slug (orders, returns,
-- revenue-summary, …), a format (CSV / PDF / IIF / QBO-CSV), and a
-- date range. The Reports UI page-level state already supports this;
-- this migration adds per-user persistence so admins can save the
-- common combos (e.g. "Monthly close — last month, IIF") and
-- re-apply them in one click.
--
-- Design notes
-- ------------
--   * Scoped per-user. user_id stores the auth user id as text
--     (matches the feature_flags.updated_by_user_id posture so a
--     deleted admin row doesn't break the FK).
--   * Date range supports two shapes:
--       range_kind='preset'  → range_preset references a slug from
--                              the UI's DATE_PRESETS catalog. Useful
--                              for "always last month" semantics.
--       range_kind='absolute' → range_from + range_to are pinned
--                              dates (one-off saved windows).
--   * Optional default recipient. When set, the Email-this-report
--     modal pre-fills the recipient field. Doesn't trigger any
--     automated send — scheduled-digests is a follow-up.
--   * No "shared" presets. Per-user posture keeps the UI simple
--     ("my presets") and avoids permission collisions between
--     admins. A future PR can promote to org-wide if operators ask.
--
-- PHI / PII posture
-- -----------------
-- No PHI. `name` is admin-supplied free text — we don't accept
-- patient identifiers there and the column is exposed only to the
-- preset's owner. `recipient` is an admin-supplied email address;
-- same posture as the per-call Email modal.

CREATE TABLE IF NOT EXISTS resupply.report_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Owning admin's auth user id. Text (not uuid) so a deleted auth
  -- row doesn't cascade-delete the preset history — same posture as
  -- feature_flags.updated_by_user_id.
  user_id text NOT NULL,
  name text NOT NULL CHECK (length(name) > 0 AND length(name) <= 120),
  slug text NOT NULL,
  -- The download format. Matches the four-format catalog in
  -- artifacts/cpap-fitter/src/pages/admin/admin-reports.tsx:
  --   csv | pdf | iif | qbo.csv
  format text NOT NULL CHECK (format IN ('csv', 'pdf', 'iif', 'qbo.csv')),
  range_kind text NOT NULL CHECK (range_kind IN ('absolute', 'preset')),
  -- When range_kind='preset', this is the testId of the entry in
  -- DATE_PRESETS (e.g. 'preset-last-month'). When kind='absolute',
  -- this is NULL.
  range_preset text NULL,
  -- When range_kind='absolute', these are inclusive bounds. Stored
  -- as `date` (not timestamptz) — the Reports backend treats the
  -- whole calendar day as inclusive, so the start-of-day /
  -- end-of-day clamp lives in the route handler, not the row.
  range_from date NULL,
  range_to date NULL,
  -- Optional default recipient for the Email modal pre-fill.
  -- Validated server-side; the table doesn't enforce shape.
  recipient text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Coherent date-range shape: absolute requires both bounds set,
  -- preset requires the catalog key.
  CONSTRAINT report_presets_range_shape CHECK (
    (range_kind = 'absolute' AND range_from IS NOT NULL AND range_to IS NOT NULL AND range_preset IS NULL)
    OR
    (range_kind = 'preset' AND range_preset IS NOT NULL AND range_from IS NULL AND range_to IS NULL)
  )
);

--> statement-breakpoint

-- Per-user listing is the dominant access pattern; the index keeps
-- the GET /admin/reports/presets fast even as the table grows.
CREATE INDEX IF NOT EXISTS report_presets_user_idx
  ON resupply.report_presets (user_id, created_at DESC);
