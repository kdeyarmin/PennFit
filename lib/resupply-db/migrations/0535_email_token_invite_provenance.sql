-- 0535_email_token_invite_provenance — record WHICH invite an email token
-- belongs to, so the follow-up sweep doesn't have to infer it.
--
-- Background
-- ----------
-- Migration 0534 added the nudge stamps for
-- artifacts/resupply-api/src/worker/jobs/invite-acceptance-reminder.ts. That
-- sweep then had to answer two questions the token could not:
--
--   1. "Is this an INVITE at all?" Four invite flows and the ordinary
--      forgot-password flow all write `purpose='password_reset'`, and an
--      invitee stays `status='invited'` until the reset completes — so the
--      acceptance gate does not separate them. The sweep leaned on token
--      LIFESPAN (invites mint 7 days, recovery mints
--      AUTH_EMAIL_TOKEN_TTL_HOURS, 24h by default). Correct against current
--      defaults, but it is a heuristic: raising that env var to 168 would
--      silently collapse it and start chasing people who merely reset a
--      password.
--
--   2. "Whose invite is it?" `resupply_auth` carries no org_id, so the sweep
--      reverse-looked-up the tenant through `resupply.admin_users` and
--      `resupply.patients`. Neither is a reliable key: `patients
--      .portal_auth_user_id` has only a non-unique index and the invite flows
--      reuse `resupply_auth.users` rows by `email_lower`, so one person who is
--      a patient at two DMEs is ONE identity with TWO roster rows. The sweep
--      had to drop those rather than risk sending another tenant's brand,
--      sender and portal host. It also left provider-portal invites out
--      entirely, because `provider_portal_accounts` has no org_id at all.
--
-- Recording provenance at mint time answers both exactly, and retires the
-- heuristic and both reverse lookups.
--
-- Nullability is the contract
-- ---------------------------
-- NULL `invite_kind` means "not an invitation" — a forgot-password or
-- sign-up-verify token. The sweep requires a non-NULL kind, so the default
-- for every non-invite writer (which is every writer that does not opt in) is
-- to be ignored. That is the safe direction: a token that forgets to declare
-- itself is never chased.
--
-- No backfill
-- -----------
-- Tokens minted before this migration carry NULL provenance and are not
-- nudged. Deliberate: attributing them would mean re-running exactly the
-- roster guesswork this migration exists to remove, and the tokens are
-- short-lived (7 days) so the set drains on its own. The reminder sweep
-- ships in the same change, so there is no already-running behaviour to
-- regress.
--
-- Per ADR 003 — versioned hand-authored migration, idempotent.

ALTER TABLE "resupply_auth"."email_tokens"
  ADD COLUMN IF NOT EXISTS "invite_org_id" uuid,
  ADD COLUMN IF NOT EXISTS "invite_kind" text;
--> statement-breakpoint

-- Enum guard (Postgres has no ADD CONSTRAINT IF NOT EXISTS). NULL passes,
-- which is the "not an invitation" case.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'email_tokens_invite_kind_chk'
      AND conrelid = 'resupply_auth.email_tokens'::regclass
  ) THEN
    ALTER TABLE "resupply_auth"."email_tokens"
      ADD CONSTRAINT "email_tokens_invite_kind_chk"
      CHECK ("invite_kind" IS NULL
             OR "invite_kind" IN ('staff', 'patient', 'provider'));
  END IF;
END $$;
--> statement-breakpoint

-- An invite always knows its tenant. Keeping the two columns consistent
-- stops a half-stamped row from reaching the sweep as "an invite belonging
-- to nobody", which would be indistinguishable from the ambiguity this
-- migration removes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'email_tokens_invite_provenance_chk'
      AND conrelid = 'resupply_auth.email_tokens'::regclass
  ) THEN
    ALTER TABLE "resupply_auth"."email_tokens"
      ADD CONSTRAINT "email_tokens_invite_provenance_chk"
      CHECK (("invite_kind" IS NULL AND "invite_org_id" IS NULL)
             OR ("invite_kind" IS NOT NULL AND "invite_org_id" IS NOT NULL));
  END IF;
END $$;
--> statement-breakpoint

-- The sweep's scan: live, unconsumed INVITE tokens ordered by expiry.
-- Partial on the invite columns so the index tracks the outstanding-invite
-- backlog rather than every password reset the platform has ever issued.
CREATE INDEX IF NOT EXISTS "auth_email_tokens_live_invite_idx"
  ON "resupply_auth"."email_tokens" ("expires_at", "user_id")
  WHERE "invite_kind" IS NOT NULL AND "consumed_at" IS NULL;
