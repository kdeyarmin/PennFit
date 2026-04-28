// @workspace/resupply-db
// Drizzle schema + Postgres connection for the CPAP resupply system.
//
// Public surface:
//   - The `resupply.*` schema and every table defined under `./schema/`.
//   - The pgcrypto-backed encryption helpers (`encryptedText`,
//     `encryptedJson`, plus the `encrypt` / `decrypt` SQL helpers used at
//     query sites). See ADR 007.
//
// Phase 1: schema + encryption + a single shared Postgres pool used by
// every resupply package that needs to talk to Postgres. See `./pool.ts`
// for sizing/timeout rationale and ADR 003 for the "one pool per
// process" rule.

export * from "./schema/index";
export {
  encryptedText,
  encryptedJson,
  encrypt,
  encryptJson,
  decrypt,
  decryptJson,
} from "./encryption";
export {
  getDbPool,
  setPoolErrorLogger,
  __resetDbPoolForTests,
} from "./pool";
export {
  PgcryptoNotInstalledError,
  isPgcryptoEnabled,
  assertPgcryptoEnabled,
  ensurePgcryptoEnabled,
} from "./preflight";
export { normalizeE164, hmacPhone } from "./phone-hash";
