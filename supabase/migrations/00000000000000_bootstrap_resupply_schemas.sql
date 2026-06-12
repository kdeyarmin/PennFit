-- Local-dev bootstrap so PostgREST can load the exposed schemas on a fresh
-- `supabase start`. The application migrator
-- (lib/resupply-db/scripts/migrate.mjs) also CREATE SCHEMA IF NOT EXISTS
-- these, so this is purely to satisfy PostgREST's schema-cache health check
-- before the app migrations have been applied.
create schema if not exists resupply;
create schema if not exists resupply_auth;
grant usage on schema resupply to anon, authenticated, service_role;
grant usage on schema resupply_auth to anon, authenticated, service_role;
alter default privileges in schema resupply
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema resupply_auth
  grant all on tables to anon, authenticated, service_role;
