// Integration test for logAudit() against a live database.
//
// Skip-when-unconfigured contract: this suite exercises the full
// write+read round-trip, so it needs BOTH the Supabase service-role
// client (writes go through PostgREST after the Drizzle → Supabase
// migration) AND a raw `pg` pool (the afterEach cleanup + read-back
// SELECTs talk to Postgres directly so we don't depend on the same
// PostgREST surface we are testing). When any of the three env
// vars is missing we skip the whole suite so `pnpm -r test` stays
// green in environments that don't have all three (e.g. the GitHub
// Actions Tests job, which provides DATABASE_URL but not the
// Supabase vars).
//
// The suite cleans up after itself: every row inserted gets a
// random `requestId` in metadata and a deletion in afterEach. We
// deliberately do not truncate the table — there may be other
// concurrent integration tests we shouldn't blow away.

import { __resetDbPoolForTests, getDbPool } from "@workspace/resupply-db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  AuditMetadataPhiError,
  logAudit,
  registerAuditHmacKeyForTesting,
  registerAuditRequestIdResolver,
} from "./index";

const skip =
  !process.env.DATABASE_URL ||
  !process.env.SUPABASE_URL ||
  !process.env.SUPABASE_SERVICE_ROLE_KEY;

const describeIfDb = skip ? describe.skip : describe;

describeIfDb("logAudit (live db)", () => {
  // Tag every row we insert here with this run id so cleanup is
  // surgical and parallel test runs (or other suites running
  // against the same db) don't step on each other.
  const runTag = `audit-helper-test-${Math.random().toString(36).slice(2)}`;

  beforeAll(() => {
    // Deterministic 32-byte test key so the chain insert path can
    // run without depending on RESUPPLY_AUDIT_HMAC_KEY being set
    // in the integration env.
    registerAuditHmacKeyForTesting(Buffer.alloc(32, 0xab));
  });

  afterEach(async () => {
    registerAuditRequestIdResolver(null);
    // Use a json-path filter so we delete exactly the rows we
    // wrote, never anyone else's.
    await getDbPool().query(
      "DELETE FROM resupply.audit_log WHERE metadata->>'_runTag' = $1",
      [runTag],
    );
  });

  afterAll(async () => {
    registerAuditHmacKeyForTesting(null);
    // Important: explicitly tear down the shared pool so vitest
    // doesn't hang on the open connection. The pool is a singleton
    // for the process lifetime, so resetting is safe — no other
    // test in this file uses it after this point.
    await __resetDbPoolForTests();
  });

  it("inserts a well-formed audit row", async () => {
    await logAudit({
      action: "patient.view",
      adminEmail: "test@example.com",
      adminUserId: "user_test123",
      targetTable: "patients",
      targetId: "00000000-0000-0000-0000-000000000001",
      metadata: { _runTag: runTag, requestId: "req_abc" },
      ip: "127.0.0.1",
      userAgent: "vitest",
    });

    const result = await getDbPool().query(
      "SELECT operator_email, action, target_table, metadata, ip " +
        "FROM resupply.audit_log WHERE metadata->>'_runTag' = $1",
      [runTag],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      operator_email: "test@example.com",
      action: "patient.view",
      target_table: "patients",
      ip: "127.0.0.1",
    });
    expect(result.rows[0].metadata).toMatchObject({
      _runTag: runTag,
      requestId: "req_abc",
    });
  });

  it("defaults nullable fields when omitted", async () => {
    await logAudit({
      action: "system.cron_swept_old_episodes",
      metadata: { _runTag: runTag, count: 7 },
    });

    const result = await getDbPool().query(
      "SELECT operator_email, operator_user_id, target_table, target_id, ip, user_agent " +
        "FROM resupply.audit_log WHERE metadata->>'_runTag' = $1",
      [runTag],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual({
      operator_email: null,
      operator_user_id: null,
      target_table: null,
      target_id: null,
      ip: null,
      user_agent: null,
    });
  });

  it("rejects PHI in metadata WITHOUT writing the row", async () => {
    // Confirms the sanitizer fires BEFORE the INSERT. If the order
    // were reversed (insert, then sanitize), a thrown error would
    // still leave a PHI row in the table — defeating the point.
    await expect(
      logAudit({
        action: "patient.view",
        metadata: { _runTag: runTag, email: "patient@example.com" },
      }),
    ).rejects.toBeInstanceOf(AuditMetadataPhiError);

    const result = await getDbPool().query(
      "SELECT count(*)::int AS n FROM resupply.audit_log WHERE metadata->>'_runTag' = $1",
      [runTag],
    );
    expect(result.rows[0].n).toBe(0);
  });

  it("forces resolver-provided _request_id over caller metadata", async () => {
    registerAuditRequestIdResolver(() => "req_from_resolver");
    await logAudit({
      action: "patient.view",
      metadata: {
        _runTag: runTag,
        _request_id: "spoofed",
        requestId: "req_abc",
      },
    });

    const result = await getDbPool().query(
      "SELECT metadata FROM resupply.audit_log WHERE metadata->>'_runTag' = $1",
      [runTag],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].metadata).toMatchObject({
      _runTag: runTag,
      _request_id: "req_from_resolver",
      requestId: "req_abc",
    });
  });
});
