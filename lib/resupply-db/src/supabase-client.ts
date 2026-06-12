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

// Hard ceiling on a single PostgREST round-trip. Without this, a
// stalled fetch rides undici's default headers timeout (~300s) and
// holds the calling request — and its worker slot — the whole time.
// The raw-pg pool got the equivalent guard (connectionTimeoutMillis)
// after the deploy-gate hang; this is the same fix for the runtime
// data path. 30s is generous for the slowest legitimate queries
// (admin reports/analytics aggregates) while still far below the
// upstream proxy timeouts that would otherwise fire first.
export const DEFAULT_SUPABASE_FETCH_TIMEOUT_MS = 30_000;

/**
 * Resolve the per-request fetch timeout from a raw env value
 * (`SUPABASE_FETCH_TIMEOUT_MS`). Invalid, zero, or negative values
 * fall back to the default — same posture as `resolvePgBossPoolMax`
 * / `DB_POOL_MAX`.
 */
export function resolveSupabaseFetchTimeoutMs(
  raw: string | undefined,
  fallback: number = DEFAULT_SUPABASE_FETCH_TIMEOUT_MS,
): number {
  const parsed = parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Wrap a fetch implementation so every call carries a timeout
 * AbortSignal, composed with any signal the caller already passed
 * (whichever aborts first wins). Exported for direct unit testing.
 */
export function createTimeoutFetch(
  timeoutMs: number,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  return (input, init) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    return baseFetch(input, { ...init, signal });
  };
}

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
  if (
    cachedClient &&
    !options.url &&
    !options.serviceRoleKey &&
    !options.schema
  ) {
    return cachedClient;
  }

  // Treat empty string the same as unset. `process.env.X=""` is a
  // common shape from `.env` files / CI configs (Node populates the
  // var as `""` rather than leaving it undefined), and the bare
  // `!url` falsy check below catches both — but a future refactor
  // could accidentally rely on `typeof url === "string"` and silently
  // pass an empty value through to `createClient`, which would
  // construct a useless client whose every request 401s. Normalize
  // up front so the misconfig becomes a single, clear boot error.
  const rawUrl = options.url ?? process.env.SUPABASE_URL ?? "";
  const rawKey =
    options.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const url = rawUrl.trim();
  const serviceRoleKey = rawKey.trim();

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
  const rawClient = createClient<
    Database,
    "resupply" | "resupply_auth" | "public"
  >(url, serviceRoleKey, {
    db: { schema: options.schema ?? "resupply" },
    auth: {
      // Server context: never persist or refresh sessions; every
      // request authenticates fresh via the in-house cookie pipeline.
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      fetch: createTimeoutFetch(
        resolveSupabaseFetchTimeoutMs(process.env.SUPABASE_FETCH_TIMEOUT_MS),
      ),
    },
  });
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
  // Treat empty / whitespace-only values as missing. Node populates
  // `process.env.X=""` for `.env` files that declare X with no value
  // — without the trim+empty check, validateSupabaseEnv() would
  // claim the env is healthy and the client builder would then
  // throw at first use.
  const url = (process.env.SUPABASE_URL ?? "").trim();
  if (!url) missing.push("SUPABASE_URL");
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!key) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  return missing;
}

/** Reset the cached client. Tests only. */
export function __resetSupabaseClientForTests(): void {
  cachedClient = null;
}
