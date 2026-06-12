#!/usr/bin/env bash
# Local development database bring-up for PennPaps / resupply-api.
#
# This is a DEV-ONLY convenience for cloud agents / local contributors. It is
# NOT used by Railway (production deploys to Railway, runtime data path is a
# hosted Supabase project). It stands up a local Supabase stack via Docker and
# wires it the way resupply-api expects.
#
# It is idempotent — safe to re-run. Steps:
#   1. supabase start            (local Postgres + PostgREST + Storage + Studio)
#   2. apply app SQL migrations  (lib/resupply-db/scripts/migrate.mjs)
#   3. grant the Supabase data-API roles on the resupply / resupply_auth schemas
#      (migrations create tables as `postgres`; PostgREST queries as
#      service_role and needs table + sequence privileges)
#   4. create the private storage bucket (SUPABASE_STORAGE_BUCKET_PRIVATE)
#   5. bootstrap a dev admin (admin@pennpaps.local / PennFitDev123!) with a
#      verified email so /admin/sign-in works without SendGrid
#
# Prereqs (installed once, persisted in the VM snapshot): Docker daemon
# running, the `supabase` CLI on PATH, Node 24 active, and `pnpm install`
# already run. See AGENTS.md "Cursor Cloud specific instructions".
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
ADMIN_EMAIL="${DEV_ADMIN_EMAIL:-admin@pennpaps.local}"
ADMIN_PASSWORD="${DEV_ADMIN_PASSWORD:-PennFitDev123!}"
BUCKET="${SUPABASE_STORAGE_BUCKET_PRIVATE:-attachments}"

echo "[dev-db] 1/5 supabase start"
supabase start

# The db container name is supabase_db_<project>; this repo pins project_id=workspace.
DB_CONTAINER="supabase_db_workspace"
if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  DB_CONTAINER="$(docker ps --format '{{.Names}}' | grep '^supabase_db_' | head -1)"
fi
if [[ -z "${DB_CONTAINER:-}" ]]; then
  echo "[dev-db] could not find a running Supabase db container (did 'supabase start' succeed?)" >&2
  exit 1
fi
echo "[dev-db] db container: $DB_CONTAINER"

echo "[dev-db] 2/5 apply migrations"
DATABASE_URL="$DB_URL" node lib/resupply-db/scripts/migrate.mjs

echo "[dev-db] 3/5 grant data-API roles on resupply schemas"
for s in resupply resupply_auth; do
  docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d postgres \
    -c "GRANT ALL ON SCHEMA auth TO postgres;" \
    -c "GRANT USAGE ON SCHEMA $s TO anon, authenticated, service_role;" \
    -c "GRANT ALL ON ALL TABLES IN SCHEMA $s TO anon, authenticated, service_role;" \
    -c "GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA $s TO anon, authenticated, service_role;" \
    -c "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA $s TO anon, authenticated, service_role;" \
    -c "ALTER DEFAULT PRIVILEGES IN SCHEMA $s GRANT ALL ON TABLES TO anon, authenticated, service_role;" \
    -c "ALTER DEFAULT PRIVILEGES IN SCHEMA $s GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO anon, authenticated, service_role;" \
    -c "ALTER DEFAULT PRIVILEGES IN SCHEMA $s GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;" >/dev/null
done
docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d postgres -c "NOTIFY pgrst, 'reload schema';" >/dev/null

echo "[dev-db] 4/5 create private storage bucket '$BUCKET'"
docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d postgres \
  -c "INSERT INTO storage.buckets (id, name, public) VALUES ('$BUCKET','$BUCKET', false) ON CONFLICT (id) DO NOTHING;" >/dev/null

echo "[dev-db] 5/5 bootstrap dev admin ($ADMIN_EMAIL)"
SRK="$(supabase status -o env 2>/dev/null | sed -n 's/^SERVICE_ROLE_KEY="\(.*\)"$/\1/p')"
export DATABASE_URL="$DB_URL"
export SUPABASE_URL="http://127.0.0.1:54321"
export SUPABASE_SERVICE_ROLE_KEY="$SRK"
export SUPABASE_STORAGE_BUCKET_PRIVATE="$BUCKET"
export RESUPPLY_LINK_HMAC_KEY="${RESUPPLY_LINK_HMAC_KEY:-local-dev-hmac-key-not-a-secret-0123456789}"
# bootstrap-admin fails if the user already exists; tolerate that on re-run.
pnpm --filter @workspace/scripts auth:bootstrap-admin --email="$ADMIN_EMAIL" --role=admin || true
ADMIN_PASSWORD="$ADMIN_PASSWORD" pnpm --filter @workspace/scripts auth:set-admin-password --email="$ADMIN_EMAIL"
docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d postgres \
  -c "UPDATE resupply_auth.users SET email_verified_at = now() WHERE email_lower='$ADMIN_EMAIL' AND email_verified_at IS NULL;" >/dev/null

echo "[dev-db] done. Admin: $ADMIN_EMAIL / $ADMIN_PASSWORD"
echo "[dev-db] SUPABASE_SERVICE_ROLE_KEY is available via: supabase status -o env"
