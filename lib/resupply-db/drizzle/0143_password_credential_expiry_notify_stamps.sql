-- 0143_password_credential_expiry_notify_stamps — track when the
-- invite-password expiry notifier has emailed an invited user about
-- their operator-typed credential.
--
-- Background. Migration 0142 added `set_by_admin_at` so the sign-in
-- handler can refuse an admin-typed password after the 7-day TTL.
-- That gate fires on the SIGN-IN side, so an invited user who never
-- comes back only finds out their password is dead when they finally
-- try to use it.
--
-- A background sweep now scans expiring/expired admin-typed
-- credentials and emails the invited user via SendGrid: a heads-up
-- nudge around day 5, and a final "your invite has expired — ask
-- your admin to re-invite you" once `set_by_admin_at` crosses the
-- TTL. These two columns are the idempotency stamps so the sweep
-- never double-sends.
--
-- Both columns are NULLABLE on purpose:
--   * Legacy rows from before this sweep was deployed start NULL and
--     will receive at most one of each email (the sweep treats NULL
--     as "not yet notified").
--   * Successful password changes / resets clear `set_by_admin_at`
--     back to NULL (see writeUserChosenPassword); these notify
--     stamps stay set but become inert because the eligibility query
--     also predicates on `set_by_admin_at IS NOT NULL`.
--   * A re-invite of the same account stamps a NEW `set_by_admin_at`
--     via the upsert in team-invite.ts but does NOT reset these
--     columns. The sweep handles this by clearing them whenever the
--     reminder timestamps predate the current `set_by_admin_at` —
--     see invite-password-expiry-notify.ts for the predicate.
ALTER TABLE "resupply_auth"."password_credentials"
  ADD COLUMN IF NOT EXISTS "expiry_reminder_sent_at" timestamp with time zone;

ALTER TABLE "resupply_auth"."password_credentials"
  ADD COLUMN IF NOT EXISTS "expired_notice_sent_at" timestamp with time zone;
