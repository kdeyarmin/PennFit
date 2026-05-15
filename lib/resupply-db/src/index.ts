// @workspace/resupply-db
// Schema + Supabase service-role client for the CPAP resupply system.
//
// Public surface:
//   - Drizzle table definitions under `./schema/` — kept as the
//     single source of truth for `drizzle-kit` migration generation.
//     Runtime callers do NOT use these types for queries; they call
//     PostgREST through the Supabase client below. (Phase-out plan:
//     these schemas move off Drizzle once the migration-drift work
//     in docs/migration-drift-status-2026-05-13.md is unblocked.)
//   - `getSupabaseServiceRoleClient()` — the shared, lazily-initialized
//     Supabase JS client used by every resupply package that needs to
//     read/write Postgres at runtime.
//   - The patient_latest_message projection helpers (Supabase-flavored).
//   - `getDbPool` is retained for the migration tooling under
//     `./scripts`. No production runtime path calls it; the legacy
//     `pgAuthRepository` fallback in `@workspace/resupply-auth` was
//     removed in the Drizzle → Supabase migration.
//
// PHI is stored as plaintext (text/jsonb). Earlier revisions used
// pgcrypto column-level encryption; migration 0025 stripped it.

export * from "./schema/index";
export { getDbPool, setPoolErrorLogger, __resetDbPoolForTests } from "./pool";
export {
  getSupabaseServiceRoleClient,
  validateSupabaseEnv,
  __resetSupabaseClientForTests,
  type ResupplySupabaseClient,
  type SupabaseClientOptions,
} from "./supabase-client";
export type { Database, Json } from "./supabase-types";
export {
  PREVIEW_MAX_CHARS,
  buildPreview,
  upsertPatientLatestMessageSb,
  tryUpsertPatientLatestMessageSb,
  setProjectionLogger,
  type LatestMessageDirection,
  type ProjectionLogger,
  type UpsertPatientLatestMessageInput,
} from "./projections/patient-latest-message";
export { escapePostgRESTFilterValue } from "./postgrest-utils";
