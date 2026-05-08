// @workspace/resupply-db
// Drizzle schema + Postgres connection for the CPAP resupply system.
//
// Public surface:
//   - The `resupply.*` schema and every table defined under `./schema/`.
//   - A single shared Postgres pool used by every resupply package
//     that needs to talk to Postgres. See `./pool.ts` for sizing/
//     timeout rationale and ADR 003 for the "one pool per process"
//     rule.
//   - The patient_latest_message projection helpers.
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
  upsertPatientLatestMessage,
  tryUpsertPatientLatestMessage,
  setProjectionLogger,
  type LatestMessageDirection,
  type ProjectionLogger,
  type UpsertPatientLatestMessageInput,
} from "./projections/patient-latest-message";
