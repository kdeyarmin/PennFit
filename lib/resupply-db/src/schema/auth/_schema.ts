import { pgSchema } from "drizzle-orm/pg-core";

/**
 * Living in its own schema (separate from `resupply.*` and `public.*`)
 * makes the privilege boundary explicit: the only code that should
 * touch `resupply_auth.*` is `lib/resupply-auth`. Future DB roles can be
 * granted SELECT on `resupply.*` while being denied any access to
 * `resupply_auth.password_credentials` or `resupply_auth.sessions`.
 *
 * Schema name is `resupply_auth` (not `auth`) because Supabase's
 * managed Postgres reserves the `auth` schema for Supabase Auth.
 * See ADR 014 and `docs/resupply/AUTH-MIGRATION-PLAN.md`.
 */
export const authSchema = pgSchema("resupply_auth");
