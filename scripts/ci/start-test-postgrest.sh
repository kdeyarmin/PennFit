#!/usr/bin/env bash
# Bring up a standalone PostgREST (no Docker) in front of an
# already-migrated Postgres so the DB-backed Supabase integration
# tests can run against a real PostgREST surface in CI or locally.
#
# Prerequisites (caller's responsibility):
#   * DATABASE_URL points at a Postgres the migrations have been applied
#     to, reachable by a SUPERUSER (so we can GRANT + SET ROLE).
#   * The anon/authenticated/service_role roles exist (we create them
#     idempotently below in case they don't).
#   * `psql` on PATH; Node available; network egress to GitHub Releases.
#
# What it does:
#   1. Creates the Supabase platform roles (idempotent) and grants
#      service_role the privileges + BYPASSRLS that managed Supabase
#      gives it (migrations 0170+ enable RLS, which service_role bypasses
#      on real Supabase).
#   2. Downloads a pinned PostgREST static binary (cached, with retries).
#   3. Mints a service_role JWT and starts PostgREST + the /rest/v1
#      proxy in the background, then waits for both to be ready.
#   4. Exports SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (to $GITHUB_ENV
#      when set, and always prints export lines for local `eval`).
#
# TEST/CI harness only — not a production gateway.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set (superuser, migrated DB)}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGREST_VERSION="${PGREST_VERSION:-v12.2.3}"
PGRST_PORT="${PGRST_PORT:-33001}"
PROXY_PORT="${PROXY_PORT:-54321}"
CACHE_DIR="${RUNNER_TEMP:-/tmp}/pennfit-postgrest"
BIN="${CACHE_DIR}/postgrest"
JWT_SECRET="${PGRST_JWT_SECRET:-pennfit-ci-postgrest-jwt-secret-0123456789}"

log() { printf '[start-test-postgrest] %s\n' "$*" >&2; }

# 1. Roles + grants (idempotent).
log "ensuring Supabase roles + grants"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END $$;
ALTER ROLE service_role BYPASSRLS;
GRANT USAGE ON SCHEMA resupply, resupply_auth TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA resupply, resupply_auth TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA resupply, resupply_auth TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA resupply, resupply_auth TO service_role;
SQL

# 2. PostgREST binary (cached + retried).
mkdir -p "$CACHE_DIR"
if [ ! -x "$BIN" ]; then
  url="https://github.com/PostgREST/postgrest/releases/download/${PGREST_VERSION}/postgrest-${PGREST_VERSION}-linux-static-x64.tar.xz"
  log "downloading PostgREST ${PGREST_VERSION}"
  ok=0
  for attempt in 1 2 3 4; do
    if curl -fsSL --max-time 120 -o "${CACHE_DIR}/postgrest.tar.xz" "$url"; then ok=1; break; fi
    log "download attempt ${attempt} failed; retrying"
    sleep $((attempt * 2))
  done
  [ "$ok" = 1 ] || { log "FATAL: could not download PostgREST"; exit 1; }
  tar -xf "${CACHE_DIR}/postgrest.tar.xz" -C "$CACHE_DIR"
  chmod +x "$BIN"
fi

# 3. Mint the service_role JWT and start PostgREST + proxy.
SERVICE_ROLE_JWT="$(node "${REPO_ROOT}/scripts/ci/gen-service-role-jwt.mjs" "$JWT_SECRET")"

log "starting PostgREST on :${PGRST_PORT}"
PGRST_DB_URI="$DATABASE_URL" \
PGRST_DB_SCHEMAS="resupply,resupply_auth" \
PGRST_DB_ANON_ROLE="anon" \
PGRST_JWT_SECRET="$JWT_SECRET" \
PGRST_SERVER_PORT="$PGRST_PORT" \
PGRST_DB_POOL="4" \
  nohup "$BIN" >"${CACHE_DIR}/postgrest.log" 2>&1 &

log "starting /rest/v1 proxy on :${PROXY_PORT}"
PROXY_PORT="$PROXY_PORT" PGRST_PORT="$PGRST_PORT" \
  nohup node "${REPO_ROOT}/scripts/ci/rest-v1-proxy.mjs" >"${CACHE_DIR}/proxy.log" 2>&1 &

# 4. Wait for readiness (proxy -> PostgREST -> Postgres end to end).
log "waiting for PostgREST via proxy"
ready=0
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    -H "Authorization: Bearer ${SERVICE_ROLE_JWT}" \
    -H "apikey: ${SERVICE_ROLE_JWT}" \
    -H "Accept-Profile: resupply" \
    "http://127.0.0.1:${PROXY_PORT}/rest/v1/" || true)"
  if [ "$code" = "200" ]; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != 1 ]; then
  log "FATAL: PostgREST did not become ready"
  log "--- postgrest.log ---"; tail -20 "${CACHE_DIR}/postgrest.log" >&2 || true
  log "--- proxy.log ---"; tail -20 "${CACHE_DIR}/proxy.log" >&2 || true
  exit 1
fi
log "PostgREST ready"

SUPABASE_URL="http://127.0.0.1:${PROXY_PORT}"
if [ -n "${GITHUB_ENV:-}" ]; then
  {
    echo "SUPABASE_URL=${SUPABASE_URL}"
    echo "SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_JWT}"
  } >>"$GITHUB_ENV"
fi
# Always print export lines so a local caller can `eval "$(...)"`.
echo "export SUPABASE_URL='${SUPABASE_URL}'"
echo "export SUPABASE_SERVICE_ROLE_KEY='${SERVICE_ROLE_JWT}'"
