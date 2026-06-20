-- 0149_clinician_share_tokens — Phase 6 (clinician share link only;
-- PWA portions of Phase 6 are out of scope per the implementation
-- plan revision).
--
-- Adds:
--   clinician_share_tokens — one row per share link an admin minted
--   for a referral. The HMAC token format (see lib/clinician-share-
--   token.ts) carries the row id + expiry; the DB row carries
--   created_by_email, revoked_at, view counters, and audit-trail
--   timestamps. This combination lets us:
--     * verify a token cheaply (HMAC + one cached row lookup)
--     * revoke without rotating the HMAC key
--     * surface "this link was viewed 4 times by IP 1.2.3.4" to the
--       CSR in the timeline ribbon
--
-- Use case: EHR partners that don't consume our webhook callbacks
-- can paste this link into their portal. The clinician clicks
-- through and sees the lifecycle ribbon (received → triaged →
-- accepted → shipped) for the order they sent us.
--
-- PHI posture: the public read endpoint returns ONLY status events
-- and HCPCS code COUNTS — never patient name, dob, address, phone,
-- or member id. The clinician's own EHR is the source of record for
-- the patient identity; we just ack progress.
--
-- Per ADR 003 — versioned hand-authored migration. Forward-deploy-
-- safe via IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "resupply"."clinician_share_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "referral_id" uuid NOT NULL
    REFERENCES "resupply"."inbound_referral_orders"("id") ON DELETE CASCADE,
  -- When the token expires. Tokens default to 30-day TTL; the admin
  -- can shorten on mint. Past-expiry tokens return 410 Gone.
  "expires_at" timestamp with time zone NOT NULL,
  -- Manual revoke — flipped non-null when an admin invalidates the
  -- token explicitly. View endpoint short-circuits on either
  -- revoked_at IS NOT NULL or expires_at <= now().
  "revoked_at" timestamp with time zone,
  -- Audit columns.
  "last_viewed_at" timestamp with time zone,
  "last_viewed_ip" inet,
  "view_count" integer NOT NULL DEFAULT 0,
  "created_by_email" varchar(180) NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "clinician_share_tokens_view_count_nonneg"
    CHECK ("view_count" >= 0)
);
--> statement-breakpoint

-- Detail page lookup — "all active share tokens for this referral".
CREATE INDEX IF NOT EXISTS "clinician_share_tokens_referral_idx"
  ON "resupply"."clinician_share_tokens"
  ("referral_id", "created_at" DESC);
--> statement-breakpoint

-- Active-tokens-only filter for the timeline ribbon.
CREATE INDEX IF NOT EXISTS "clinician_share_tokens_active_idx"
  ON "resupply"."clinician_share_tokens"
  ("referral_id", "expires_at")
  WHERE "revoked_at" IS NULL;
