-- admin_users — DB-backed roster of admins / customer-service reps.
--
-- Supplements (not replaces) the RESUPPLY_ADMIN_EMAILS / RESUPPLY_AGENT_EMAILS
-- env-var allowlists. The env vars stay as the bootstrap layer that
-- always works regardless of DB state — they're how the very first
-- admin gets in, before there's anyone in the database to invite from.
-- Once that admin is in, additional team members are added through
-- the in-app "Team" page which writes to this table and triggers a
-- Clerk invitation.
--
-- Lifecycle:
--   pending  — invitation sent via Clerk; user has not accepted yet.
--               clerk_user_id is NULL until they sign up.
--   active   — user has signed in at least once; clerk_user_id linked.
--   revoked  — invite was withdrawn or membership was removed by an
--               admin. The row stays in the table for audit; the
--               middleware refuses to admit revoked rows.
--
-- Why an email-keyed row before the user signs up:
--   Clerk's sign-up flow doesn't fire a webhook into our system unless
--   we configure one. Linking by email at first-login (in the
--   requireAdmin middleware) keeps the wiring self-contained. The
--   UNIQUE on email_lower means there can't be two pending invites for
--   the same address.
--
-- Privacy: this table contains email + role + audit timestamps. It
-- does NOT contain PHI (those tables are in resupply.* keyed by PACware
-- patient id, not Clerk user id). Operator emails ARE stored in
-- plaintext for support / accountability — same posture as the
-- audit_log.actor_email column.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."admin_users" (
  "id" text PRIMARY KEY DEFAULT (gen_random_uuid()::text) NOT NULL,
  "email_lower" text NOT NULL UNIQUE,
  -- Populated on first successful login when the middleware matches by
  -- email. NULL while the row is in `pending` state.
  "clerk_user_id" text UNIQUE,
  -- 'admin' | 'agent'. We deliberately do NOT include 'viewer' yet —
  -- the read-only role would require touching every write endpoint,
  -- and the current pattern (admin + agent) is the matched contract
  -- of the requireAdminOnly middleware.
  "role" text NOT NULL DEFAULT 'agent',
  -- 'pending' | 'active' | 'revoked'.
  "status" text NOT NULL DEFAULT 'pending',
  -- Reference to the Clerk invitation id so we can resend / revoke it
  -- via the Clerk Backend API later. NULL for rows seeded outside the
  -- invite flow (e.g. the bootstrap admin row inserted by the migration
  -- when RESUPPLY_ADMIN_EMAILS is migrated into the table).
  "clerk_invitation_id" text,
  -- Free-form display name + optional notes for the team list.
  "display_name" text,
  "notes" text,
  -- Audit trail. invited_by is the inviter's clerk_user_id; revoked_by
  -- is the revoker's clerk_user_id.
  "invited_by" text,
  "invited_at" timestamp with time zone NOT NULL DEFAULT now(),
  "accepted_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_by" text,
  "last_login_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- The middleware looks up by email_lower on first login (no
-- clerk_user_id yet) and by clerk_user_id thereafter. Both lookups
-- need to be cheap; email_lower is already UNIQUE so it's covered,
-- and clerk_user_id is also UNIQUE — both auto-indexed.

-- Status filter for the "active members" view in the admin team page.
CREATE INDEX IF NOT EXISTS "admin_users_status_idx"
  ON "resupply"."admin_users" ("status");
