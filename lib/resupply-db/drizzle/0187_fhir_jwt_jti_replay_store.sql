-- 0187_fhir_jwt_jti_replay_store — single-use enforcement for inbound
-- SMART-on-FHIR Backend Services JWTs.
--
-- requireSmartFhirAccess verifies a partner JWT's signature + iss/sub/aud +
-- iat-window, but until now did NOT enforce the `jti` (token id) as single-use.
-- A captured-but-still-valid JWT could therefore be replayed within its ~6 min
-- iat window carrying a DIFFERENT FHIR Bundle to land additional forged
-- referrals (the route's body-sha256 dedupe only blocks IDENTICAL replays). The
-- jose/SMART backend-services spec treats `jti` as single-use; this table is the
-- replay store the verifier's docstring delegates to.
--
-- A row per accepted token. `expires_at` mirrors the JWT `exp`, so a periodic
-- prune can delete rows past expiry (an expired jti is harmless — the iat/exp
-- check rejects the token before the jti check is reached). RLS on; the
-- service-role data path reaches it via the schema's default privileges.

CREATE TABLE IF NOT EXISTS "resupply"."fhir_jwt_jti_seen" (
  "jti" text PRIMARY KEY,
  "tenant_id" uuid NOT NULL REFERENCES "resupply"."ehr_fhir_tenants"("id") ON DELETE CASCADE,
  "expires_at" timestamp with time zone NOT NULL,
  "seen_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "fhir_jwt_jti_seen_expires_idx"
  ON "resupply"."fhir_jwt_jti_seen" ("expires_at");

ALTER TABLE "resupply"."fhir_jwt_jti_seen" ENABLE ROW LEVEL SECURITY;
