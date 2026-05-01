import { pgSchema } from "drizzle-orm/pg-core";

/**
 * The Postgres schema that holds every in-house auth table.
 *
 * Living in its own schema (separate from `resupply.*` and `public.*`)
 * makes the privilege boundary explicit: the only code that should
 * touch `auth.*` is `lib/resupply-auth`. Future DB roles can be
 * granted SELECT on `resupply.*` while being denied any access to
 * `auth.password_credentials` or `auth.sessions`.
 *
 * See ADR 014 and `docs/resupply/AUTH-MIGRATION-PLAN.md`.
 */
export const authSchema = pgSchema("auth");
