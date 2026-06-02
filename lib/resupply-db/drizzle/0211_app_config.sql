-- 0211_app_config — Super-admin System Configuration store.
--
-- Backs the /admin/system/configuration console where a super-admin
-- enters integration credentials and platform secrets (AI vendor keys,
-- Twilio, SendGrid, Stripe, therapy-cloud OAuth, Office Ally, Parachute,
-- …) that historically lived ONLY as Railway environment variables.
--
-- Design notes
-- ------------
--   * One row per setting, keyed by the LITERAL environment-variable
--     name (`OPENAI_API_KEY`, `AIRVIEW_CLIENT_SECRET`, …). Keeping the
--     key identical to the env var means a stored value overlays
--     `process.env[key]` directly — no name-mapping table. The closed
--     set of writable keys is the code-level catalog in
--     artifacts/resupply-api/src/lib/app-config/catalog.ts; the route
--     layer refuses to write a key that isn't in it.
--   * `value` is stored in PLAINTEXT. Per the repo hard rule "No new
--     column-level encryption" (migration 0025 stripped pgcrypto), there
--     is no at-rest column encryption. The protection model is:
--       - the table is reachable only via the service-role client
--         (server-side; never the browser),
--       - the read API masks secret values (returns a last-4 hint, never
--         the plaintext), and
--       - only the `system.config.manage` permission (super_admin) can
--         read/write it.
--   * Catalog scope is INTENTIONALLY the optional / feature-gated env
--     vars that already degrade gracefully when unset. The bootstrap
--     credentials the process needs just to start (DATABASE_URL,
--     SUPABASE_URL/SERVICE_ROLE_KEY, PORT, RESUPPLY_LINK_HMAC_KEY,
--     the CORS allowlist, the storage bucket) are deliberately NOT in
--     the catalog and are never overridable here — they stay Railway
--     env so there is no "need the DB to read the creds that reach the
--     DB" cycle and no env-check ordering hazard.
--   * `updated_by_user_id` is free-form text (not an FK) so a deleted
--     admin row doesn't break the config row — same posture as
--     feature_flags.updated_by_user_id (migration 0149).
--
-- What this does NOT do
-- ---------------------
--   * No PHI. Keys are static env-var names; values are platform
--     credentials, never patient data.
--   * No history of secret VALUES. The companion app_config_events
--     table records only that a key was set/cleared and by whom — never
--     the before/after value — so the audit trail can't leak a secret.

CREATE TABLE IF NOT EXISTS resupply.app_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  -- Free-form text (not uuid / not FK): survives a deleted admin row,
  -- matching feature_flags.updated_by_user_id.
  updated_by_user_id text NULL,
  updated_by_email text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

-- app_config_events — append-only log of config writes.
--
-- Mirrors feature_flag_events (migration 0163): the System Config
-- console's "Recent activity" panel reads from here. INTENTIONALLY
-- NARROW and value-free — we record the key, the action ('set' |
-- 'clear'), whether a prior value existed, the operator, and when.
-- We never persist the secret itself, so the activity feed is safe to
-- render in the admin UI as-is.
CREATE TABLE IF NOT EXISTS resupply.app_config_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  action text NOT NULL,
  -- Whether a value already existed before this write — lets the panel
  -- render "set" vs "updated" without storing either value.
  had_previous boolean NOT NULL,
  CONSTRAINT app_config_events_action_chk
    CHECK (action IN ('set', 'clear')),
  operator_email text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

-- Newest-first lookup powers the activity panel's default view.
CREATE INDEX IF NOT EXISTS app_config_events_occurred_at_idx
  ON resupply.app_config_events (occurred_at DESC);

--> statement-breakpoint

-- Per-key history (clicking a setting filters here).
CREATE INDEX IF NOT EXISTS app_config_events_key_occurred_at_idx
  ON resupply.app_config_events (key, occurred_at DESC);
