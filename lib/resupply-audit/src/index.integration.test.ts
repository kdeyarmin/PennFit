// Integration test for logAudit() against a live Postgres database.
//
// Skip-when-unconfigured contract: this suite needs DATABASE_URL +
// RESUPPLY_DATA_KEY (audit_log is in the resupply schema and the
// shared pool checks for pgcrypto on first use). When either is
// unset we skip the suite entirely so `pnpm -r test` stays green
// in environments without a live db (CI runs that don't set them).
//
// The suite cleans up after itself: every row inserted gets a
// random `requestId` in metadata and a deletion in afterEach. We
// deliberately do not truncate the table — there may be other
// concurrent integration tests we shouldn't blow away.

import {
  __resetDbPoolForTests,
  getDbPool,
  assertPgcryptoEnabled,
} from "@workspace/resupply-db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AuditMetadataPhiError, logAudit } from "./index";

const skip = !process.env.DATABASE_URL || !process.env.RESUPPLY_DATA_KEY;

const describeIfDb = skip ? describe.skip : describe;

describeIfDb("logAudit (live db)", () => {
  // Tag every row we insert here with this run id so cleanup is
  // surgical and parallel test runs (or other suites running
  // against the same db) don't step on each other.
  const runTag = `audit-helper-test-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    // Confirm pgcrypto exists. audit_log itself doesn't need it,
    // but the shared pool's first use should validate the schema is
    // healthy — otherwise a missing pgcrypto would surface as a
    // confusing failure several tests in.
    await assertPgcryptoEnabled(getDbPool());
  });

  afterEach(async () => {
    // Use a json-path filter so we delete exactly the rows we
    // wrote, never anyone else's.
    await getDbPool().query(
      "DELETE FROM resupply.audit_log WHERE metadata->>'_runTag' = $1",
      [runTag],
    );
  });

  afterAll(async () => {
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
      adminClerkId: "user_test123",
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
      "SELECT operator_email, operator_clerk_id, target_table, target_id, ip, user_agent " +
        "FROM resupply.audit_log WHERE metadata->>'_runTag' = $1",
      [runTag],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual({
      operator_email: null,
      operator_clerk_id: null,
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
});
