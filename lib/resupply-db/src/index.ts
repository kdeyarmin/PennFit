// @workspace/resupply-db
// Supabase service-role client + pure types for the CPAP resupply system.
//
// Public surface:
//   - Pure types and constants from `./types` (AdminRole,
//     EmailTokenPurpose, CommunicationPreferences, etc.). These were
//     extracted out of the per-table Drizzle schema files when the
//     Drizzle tooling was retired so this package's public boundary
//     no longer depends on `drizzle-orm`.
//   - `getSupabaseServiceRoleClient()` — the shared, lazily-initialized
//     Supabase JS client used by every resupply package that needs
//     to read/write Postgres at runtime.
//   - The `Database` and `Json` types from `./supabase-types` —
//     authoritative row shapes for every PostgREST query.
//   - The patient_latest_message projection helpers (Supabase-flavored).
//   - `getDbPool` is retained for the migration tooling under
//     `./scripts`. No production runtime path calls it.
//
// The Drizzle schema TS files under `./schema/**` are NOT re-exported
// here anymore — they're now an internal implementation detail of
// the historical migration generation, kept around because the SQL
// files in `./drizzle/*.sql` remain the source of truth for
// migration history. Consumers should never need to import from
// `./schema/**`.
//
// PHI is stored as plaintext (text/jsonb). Earlier revisions used
// pgcrypto column-level encryption; migration 0025 stripped it.

export * from "./types";
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
