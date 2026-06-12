-- Backfill patients.timezone from the address state.
--
-- Migration 0161 added patients.timezone (default 'America/New_York')
-- to gate automated reminders into the patient's local 9am–8pm window,
-- and explicitly deferred deriving a real value from the address to "a
-- separate task". That task never shipped, so every patient enrolled
-- before 0161 — and every patient since whose creation path didn't set
-- it — is treated as Eastern. A Pacific patient's quiet-hours window is
-- effectively 12pm–11pm local: inside the TCPA 8am–9pm bound, but well
-- outside our internal 9am–8pm policy.
--
-- Mapping: non-Eastern states → DOMINANT IANA zone. This is a subset of
-- timezoneForUsState (lib/resupply-domain/src/us-timezone.ts) so rows whose
-- derived zone is still 'America/New_York' are left untouched. Split-zone states map to
-- their majority side — at worst a one-hour skew, strictly better than
-- the three-hour Eastern-default error. Both USPS codes and full state
-- names are matched (CSV/PacWare imports carry either).
--
-- Scope guard: only rows still on the default 'America/New_York' are
-- touched, so an explicitly set timezone is never overwritten. Rows
-- whose state derives to Eastern (or doesn't derive at all) are left
-- alone. Idempotent: a second run matches zero rows because every
-- updated row no longer has the Eastern default.
UPDATE "resupply"."patients" AS p
SET "timezone" = m.tz,
    "updated_at" = now()
FROM (
  VALUES
    -- Central
    ('AL', 'America/Chicago'), ('ALABAMA', 'America/Chicago'),
    ('AR', 'America/Chicago'), ('ARKANSAS', 'America/Chicago'),
    ('IA', 'America/Chicago'), ('IOWA', 'America/Chicago'),
    ('IL', 'America/Chicago'), ('ILLINOIS', 'America/Chicago'),
    ('KS', 'America/Chicago'), ('KANSAS', 'America/Chicago'),
    ('LA', 'America/Chicago'), ('LOUISIANA', 'America/Chicago'),
    ('MN', 'America/Chicago'), ('MINNESOTA', 'America/Chicago'),
    ('MO', 'America/Chicago'), ('MISSOURI', 'America/Chicago'),
    ('MS', 'America/Chicago'), ('MISSISSIPPI', 'America/Chicago'),
    ('ND', 'America/Chicago'), ('NORTH DAKOTA', 'America/Chicago'),
    ('NE', 'America/Chicago'), ('NEBRASKA', 'America/Chicago'),
    ('OK', 'America/Chicago'), ('OKLAHOMA', 'America/Chicago'),
    ('SD', 'America/Chicago'), ('SOUTH DAKOTA', 'America/Chicago'),
    ('TN', 'America/Chicago'), ('TENNESSEE', 'America/Chicago'),
    ('TX', 'America/Chicago'), ('TEXAS', 'America/Chicago'),
    ('WI', 'America/Chicago'), ('WISCONSIN', 'America/Chicago'),
    -- Mountain
    ('CO', 'America/Denver'), ('COLORADO', 'America/Denver'),
    ('ID', 'America/Denver'), ('IDAHO', 'America/Denver'),
    ('MT', 'America/Denver'), ('MONTANA', 'America/Denver'),
    ('NM', 'America/Denver'), ('NEW MEXICO', 'America/Denver'),
    ('UT', 'America/Denver'), ('UTAH', 'America/Denver'),
    ('WY', 'America/Denver'), ('WYOMING', 'America/Denver'),
    -- Arizona observes no DST — its own zone.
    ('AZ', 'America/Phoenix'), ('ARIZONA', 'America/Phoenix'),
    -- Pacific
    ('CA', 'America/Los_Angeles'), ('CALIFORNIA', 'America/Los_Angeles'),
    ('NV', 'America/Los_Angeles'), ('NEVADA', 'America/Los_Angeles'),
    ('OR', 'America/Los_Angeles'), ('OREGON', 'America/Los_Angeles'),
    ('WA', 'America/Los_Angeles'), ('WASHINGTON', 'America/Los_Angeles'),
    -- Non-contiguous + territories
    ('AK', 'America/Anchorage'), ('ALASKA', 'America/Anchorage'),
    ('HI', 'Pacific/Honolulu'), ('HAWAII', 'Pacific/Honolulu'),
    ('PR', 'America/Puerto_Rico'), ('PUERTO RICO', 'America/Puerto_Rico'),
    ('VI', 'America/St_Thomas'), ('VIRGIN ISLANDS', 'America/St_Thomas'),
    ('GU', 'Pacific/Guam'), ('GUAM', 'Pacific/Guam'),
    ('MP', 'Pacific/Guam'), ('NORTHERN MARIANA ISLANDS', 'Pacific/Guam'),
    ('AS', 'Pacific/Pago_Pago'), ('AMERICAN SAMOA', 'Pacific/Pago_Pago')
) AS m(state, tz)
WHERE p."timezone" = 'America/New_York'
  AND p."address" IS NOT NULL
  AND upper(regexp_replace(btrim(p."address"->>'state'), '\s+', ' ', 'g')) = m.state;
