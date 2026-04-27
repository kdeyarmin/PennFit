// @workspace/resupply-db
// Drizzle schema + Postgres connection for the CPAP resupply system.
//
// Public surface:
//   - The `resupply.*` schema and every table defined under `./schema/`.
//   - The pgcrypto-backed encryption helpers (`encryptedText`,
//     `encryptedJson`, plus the `encrypt` / `decrypt` SQL helpers used at
//     query sites). See ADR 007.
//
// Phase 1: schema + encryption only. The Postgres connection / pool is
// owned by `@workspace/db` (Penn Fit's package); the resupply api and
// worker import that pool directly so we don't run two pools against the
// same DB.

export * from "./schema/index";
export {
  encryptedText,
  encryptedJson,
  encrypt,
  encryptJson,
  decrypt,
  decryptJson,
} from "./encryption";
