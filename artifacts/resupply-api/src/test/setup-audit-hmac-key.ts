// Vitest global setup: ensure `RESUPPLY_AUDIT_HMAC_KEY` is set.
//
// Migration 0116 introduced an HMAC chain on `resupply.audit_log`,
// and `@workspace/resupply-audit` now requires the env var (or a
// test-registered key) at every write. Tests that mock the audit
// module entirely are unaffected; tests that exercise the real
// call chain (e.g. worker jobs that audit through the live module)
// would otherwise throw `AuditHmacKeyError` mid-run.
//
// We deliberately seed the env var rather than importing the audit
// module and calling `registerAuditHmacKeyForTesting` here — eager
// import would bind the real `getSupabaseServiceRoleClient` into
// the audit module before per-test `vi.mock` calls can replace it,
// which silently breaks any test that relies on the supabase mock.

if (
  process.env.RESUPPLY_AUDIT_HMAC_KEY === undefined ||
  process.env.RESUPPLY_AUDIT_HMAC_KEY.trim() === ""
) {
  // 32 deterministic bytes, base64-encoded — meets the lib's
  // minimum-length gate while keeping the test value obvious.
  process.env.RESUPPLY_AUDIT_HMAC_KEY = Buffer.alloc(32, 0xa5).toString(
    "base64",
  );
}
