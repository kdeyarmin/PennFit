// Integration test for /readyz against a real backend.
//
// HISTORY: this test previously stood up a throwaway Postgres database,
// applied the Drizzle migrations, pointed `getDbPool()` at it via
// `__resetDbPoolForTests`, and asserted the readiness probe's
// pgboss-schema lookup against a real `information_schema.tables`
// query. After the Drizzle → Supabase migration the readiness probe:
//
//   * Issues its `db` check through PostgREST against
//     `resupply.audit_log` via `getSupabaseServiceRoleClient()`. The
//     local-Postgres + Drizzle-migrate scaffolding can't simulate that
//     path — Supabase's PostgREST + auth surface is what is actually
//     being probed in production.
//   * Determines `queue` readiness from the in-memory `isWorkerReady()`
//     flag set by `startWorker()`. The schema-existence query is gone.
//
// The unit tests in `readiness.test.ts` cover the categorization and
// response-shape contract that this test used to cover. A genuine
// "real backend" integration test would now need to spin up a Supabase
// project (or supabase-js mocked at the HTTP layer) plus a real
// pg-boss instance — work that's out of scope for the migration.
//
// Re-introducing this test should pick up at the
// `getSupabaseServiceRoleClient()` boundary, not the pg pool. See the
// post-migration plan in the PR description.

import { describe, it } from "vitest";

describe.skip("/readyz integration (replaced by readiness.test.ts after the Drizzle → Supabase migration)", () => {
  it("placeholder", () => {
    /* see file header */
  });
});
