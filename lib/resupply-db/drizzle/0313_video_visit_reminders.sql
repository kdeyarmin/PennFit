-- 0313_video_visit_reminders — pre-visit reminder stamp.
--
-- The video-visits.reminder-sweep worker job sends the patient a
-- "starting soon" SMS/email shortly before a SCHEDULED visit's start
-- time. `reminder_sent_at` is the at-most-once claim stamp (the sweep
-- claims a row by setting it before sending, mirroring the dispatcher
-- atomic-claim convention).

ALTER TABLE resupply.video_visits
  ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz;

-- Partial index sized for the sweep's hot query: open scheduled visits
-- that haven't been reminded yet, scanned by start time every 10 min.
CREATE INDEX IF NOT EXISTS video_visits_reminder_sweep_idx
  ON resupply.video_visits (scheduled_at)
  WHERE status = 'scheduled' AND reminder_sent_at IS NULL;
