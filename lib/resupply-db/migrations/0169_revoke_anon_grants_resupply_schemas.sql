-- Close the PostgREST exposure on the `resupply` and `resupply_auth`
-- schemas by stripping every privilege held by the `anon` and
-- `authenticated` roles.
--
-- Why: the Supabase security advisor flagged ~50 ERROR-level findings —
-- every table in `resupply` (168) and `resupply_auth` (20) is exposed
-- via PostgREST with RLS disabled, AND the `anon` / `authenticated`
-- roles still hold SELECT/INSERT/UPDATE/DELETE on all of them
-- (including PHI: patients, prescriptions, patient_documents, and the
-- auth tables password_credentials / sessions / email_tokens). These
-- grants are historical leftovers from when the tables were first
-- created; the current per-schema default privileges already grant
-- only to `service_role` (verified against production pg_default_acl),
-- so no future table re-introduces them.
--
-- The application never relies on the anon/authenticated roles: the
-- SPA ships no Supabase anon key and talks only to the Express API,
-- which uses the service-role client (and bypasses RLS). So revoking
-- anon/authenticated access closes the hole with zero impact on the
-- running app. `service_role` keeps every grant it already has.
--
-- We revoke grants instead of enabling deny-all RLS (the other valid
-- mitigation) because the runtime path is service-role-only and RLS
-- carries a per-query cost plus the risk of locking out a path that
-- isn't covered here; a hard REVOKE is the smaller, safer change.
--
-- Idempotent + from-scratch safe: REVOKE on a privilege that isn't
-- held is a no-op (never errors), and ALTER DEFAULT PRIVILEGES ...
-- REVOKE is likewise a no-op when the default isn't present. migrate.mjs
-- dedups by file hash, so this runs exactly once per database; even if
-- re-run, every statement below is harmless.

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "resupply" FROM "anon", "authenticated";
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "resupply_auth" FROM "anon", "authenticated";
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "resupply" FROM "anon", "authenticated";
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "resupply_auth" FROM "anon", "authenticated";
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA "resupply" FROM "anon", "authenticated";
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA "resupply_auth" FROM "anon", "authenticated";
--> statement-breakpoint
REVOKE USAGE ON SCHEMA "resupply" FROM "anon", "authenticated";
--> statement-breakpoint
REVOKE USAGE ON SCHEMA "resupply_auth" FROM "anon", "authenticated";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "resupply" REVOKE ALL ON TABLES FROM "anon", "authenticated";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "resupply_auth" REVOKE ALL ON TABLES FROM "anon", "authenticated";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "resupply" REVOKE ALL ON SEQUENCES FROM "anon", "authenticated";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "resupply_auth" REVOKE ALL ON SEQUENCES FROM "anon", "authenticated";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "resupply" REVOKE ALL ON FUNCTIONS FROM "anon", "authenticated";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "resupply_auth" REVOKE ALL ON FUNCTIONS FROM "anon", "authenticated";
