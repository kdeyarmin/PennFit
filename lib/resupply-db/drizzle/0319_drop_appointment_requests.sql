-- Drop appointment_requests — the patient-initiated appointment-request
-- process was removed from the app (PR #727): the /admin/appointment-requests
-- routes, page, nav entry, and API client are gone and nothing reads or
-- writes this table anymore. The shared company calendar
-- (company_calendar_events) is unrelated and unaffected.
--
-- Destructive by design: any historical request rows are deleted with the
-- table. Idempotent for fresh-replay and re-apply (IF EXISTS); the index
-- and CHECK constraint from 0104/0109 drop with the table.

DROP TABLE IF EXISTS "resupply"."appointment_requests";
