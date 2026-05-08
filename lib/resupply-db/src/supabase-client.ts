import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "./supabase-types";

// Server-side Supabase client.
//
// Uses the service-role key, which bypasses Row-Level Security. This
// is the correct choice for the resupply server: every route already
// authenticates the caller via in-house cookie auth (lib/resupply-auth)
// before reaching DB code, and policies-per-route in PostgREST would
// re-implement that authorization layer one level lower for no
// additional safety. The trade-off is that the service-role key MUST
// stay on the server and never reach the browser. Boot-time validation
// in `validateSupabaseEnv()` enforces presence; do not log or echo
// SUPABASE_SERVICE_ROLE_KEY.
//
// Schemas: resupply tables live under `resupply` and `resupply_auth`;
// `public` is empty. PostgREST won't return rows for non-public schemas
// unless they're listed in Studio → Project Settings → API → "Exposed
// schemas" (`resupply, resupply_auth`). A fresh project must have that
// setting flipped before any `.from()` query succeeds; the boot-time
// readiness check catches this.

// We use the default `public` schema at the type level and route
// every actual query through `.schema('resupply')` or
// `.schema('resupply_auth')`. Forcing the second generic to a non-
// `public` schema runs into Supabase's complex defaulting (the
// generic resolves to `string & keyof Database` rather than the
// specific literal), so the lighter typing is the practical choice.
export type ResupplySupabaseClient = SupabaseClient<Database>;

let cachedClient: ResupplySupabaseClient | null = null;

export interface SupabaseClientOptions {
  /** Override the URL (tests). */
  url?: string;
  /** Override the service-role key (tests). */
  serviceRoleKey?: string;
  /**
   * Default schema for unqualified `.from()` calls. Most resupply
   * code lives in `resupply`; `resupply_auth` access is via
   * `client.schema('resupply_auth').from(...)`.
   */
  schema?: "resupply" | "resupply_auth" | "public";
}

export function getSupabaseServiceRoleClient(
  options: SupabaseClientOptions = {},
): ResupplySupabaseClient {
  if (cachedClient && !options.url && !options.serviceRoleKey && !options.schema) {
    return cachedClient;
  }

  const url = options.url ?? process.env.SUPABASE_URL;
  const serviceRoleKey =
    options.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error(
      "SUPABASE_URL must be set for @workspace/resupply-db (getSupabaseServiceRoleClient).",
    );
  }
  if (!serviceRoleKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY must be set for @workspace/resupply-db (getSupabaseServiceRoleClient).",
    );
  }

  // `createClient`'s return type carries the SchemaNameOrClientOptions
  // generic in a way that doesn't unify with `ResupplySupabaseClient`
  // even when both nominally use `Database`. Cast through `unknown` —
  // we only consume the client through `.schema('resupply' |
  // 'resupply_auth').from(...)`, so the runtime shape is correct
  // regardless of the surface the type system shows.
  const rawClient = createClient<Database, "resupply" | "resupply_auth" | "public">(
    url,
    serviceRoleKey,
    {
      db: { schema: options.schema ?? "resupply" },
      auth: {
        // Server context: never persist or refresh sessions; every
        // request authenticates fresh via the in-house cookie pipeline.
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
  const client = rawClient as unknown as ResupplySupabaseClient;

  if (!options.url && !options.serviceRoleKey && !options.schema) {
    cachedClient = client;
  }
  return client;
}

/**
 * Validate that Supabase environment variables are present at boot.
 * Returns a list of missing variable names; an empty list means the
 * Supabase client can be constructed.
 *
 * Service boot code (`artifacts/resupply-api/src/lib/env-check.ts`)
 * combines this with other required-var checks so the process fails
 * fast on misconfiguration rather than 500'ing the first DB-touching
 * request.
 */
export function validateSupabaseEnv(): string[] {
  const missing: string[] = [];
  if (!process.env.SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY)
    missing.push("SUPABASE_SERVICE_ROLE_KEY");
  return missing;
}

/** Reset the cached client. Tests only. */
export function __resetSupabaseClientForTests(): void {
  cachedClient = null;
}
