// @workspace/resupply-db
// Supabase service-role client + pure types for the CPAP resupply system.
//
// Public surface:
//   - Pure types and constants from `./types` (AdminRole,
//     EmailTokenPurpose, CommunicationPreferences, etc.). The
//     `./schema/` directory of Drizzle table definitions was
//     deleted when the Drizzle tooling was retired — these types
//     are now declared directly in `./types.ts`.
//   - `getSupabaseServiceRoleClient()` — the shared, lazily-initialized
//     Supabase JS client used by every resupply package that needs
//     to read/write Postgres at runtime.
//   - The `Database` and `Json` types from `./supabase-types` —
//     authoritative row shapes for every PostgREST query.
//   - The patient_latest_message projection helpers (Supabase-flavored).
//   - `getDbPool` is retained for the migration tooling under
//     `./scripts`. No production runtime path calls it.
//
// Migration history lives in the SQL files under `./drizzle/*.sql`.
// The directory name is historical — new migrations are hand-written
// SQL (no drizzle-kit involved). The directory will be renamed in
// a separate operational change.
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
export type { Database, Json, TemplateLine } from "./supabase-types";
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
