// Integration test for /readyz against a real Postgres.
//
// Why a separate test from `readiness.test.ts`:
//   The unit test mocks `getDbPool` and proves the categorization
//   logic for synthetic errors. It cannot prove the readiness probe
//   actually works against a real driver, real network errors, or a
//   real "schema missing" condition — and a regression in either of
//   those would silently lie at the deploy gate.
//
// Why a dedicated test database (not the live `DATABASE_URL`):
//   The Resupply Worker is running in the same dev environment and
//   owns the `pgboss_resupply` schema. The failure cases below need
//   to drop that schema to assert the right failure category — doing
//   that to the live DB would interrupt the worker. So we provision
//   a throwaway database, run the resupply migrations against it,
//   point the API's pool at it, and drop the database when done.
//
// Skips when:
//   - `DATABASE_URL` is unset (no Postgres reachable).
//   - `RESUPPLY_DATA_KEY` is unset (encryption helpers refuse to load).
//   - The connecting role lacks `CREATE DATABASE` (e.g. CI on a
//     restricted DB user). The skip message explains the situation.

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import request from "supertest";
import { __resetDbPoolForTests } from "@workspace/resupply-db";

const { Pool } = pg;
const execFile = promisify(execFileCb);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATE_SCRIPT = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "lib",
  "resupply-db",
  "scripts",
  "migrate.mjs",
);

const baseDbUrl = process.env.DATABASE_URL;
const dataKey = process.env.RESUPPLY_DATA_KEY;

// Pre-flight a CREATE DATABASE permission check synchronously at
// module load so the skip predicate is correct before any beforeAll.
//
// We probe the role-level capability (`pg_roles.rolcreatedb` /
// `rolsuper`) rather than the database-level CREATE privilege —
// `has_database_privilege(..., 'CREATE')` only tests the right to
// create *schemas* inside the current database, not the right to
// `CREATE DATABASE` server-wide. Mismatching the two would let the
// suite reach `beforeAll` on a restricted CI role and fail the entire
// describe with a permission error instead of skipping cleanly.
let canCreateDatabase = false;
let permissionCheckErr: string | null = null;
async function checkCreateDatabasePerm(): Promise<void> {
  if (!baseDbUrl) return;
  // Bound the connect itself, not just queries on it. This probe runs
  // as TOP-LEVEL AWAIT during module import — without a connect timeout
  // an unreachable DATABASE_URL would hang vitest's discovery phase
  // forever (the `describe.skipIf` below never gets a chance to fire
  // because the test file is stuck importing). 5s is generous for a
  // local Postgres and well under any reasonable CI test timeout.
  const probe = new Pool({
    connectionString: baseDbUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
  });
  try {
    const res = await probe.query<{ ok: boolean }>(
      `SELECT (rolcreatedb OR rolsuper) AS ok
         FROM pg_roles
        WHERE rolname = current_user`,
    );
    canCreateDatabase = res.rows[0]?.ok === true;
  } catch (err) {
    permissionCheckErr = err instanceof Error ? err.message : String(err);
  } finally {
    await probe.end();
  }
}
await checkCreateDatabasePerm();

const skipReason = (() => {
  if (!baseDbUrl) return "DATABASE_URL is not set";
  if (!dataKey) return "RESUPPLY_DATA_KEY is not set";
  if (permissionCheckErr) return `permission probe failed: ${permissionCheckErr}`;
  if (!canCreateDatabase) return "connecting role lacks CREATE DATABASE";
  return null;
})();

describe.skipIf(skipReason !== null)("/readyz integration", () => {
  // Throwaway test DB name. Suffix is stable so a crashed prior run
  // leaves an orphan we can detect, but unique per process to avoid
  // collisions in parallel test runs against the same Postgres.
  const testDbName = `resupply_readyz_test_${process.pid}`;
  let adminPool: pg.Pool;
  let testDbUrl: string;
  let originalDatabaseUrl: string | undefined;
  let app: import("express").Express;

  beforeAll(async () => {
    if (!baseDbUrl) throw new Error("unreachable — guarded by skipIf");
    adminPool = new Pool({ connectionString: baseDbUrl, max: 1 });

    // Drop any leftover from a prior crashed run, then create fresh.
    await dropTestDatabase(adminPool, testDbName);
    await adminPool.query(`CREATE DATABASE "${testDbName}"`);

    // Build the test-DB URL by swapping the database segment of the
    // base URL. URL parsing handles passwords, query strings, and
    // alternate ports without us reaching for regex on a connection
    // string.
    const u = new URL(baseDbUrl);
    u.pathname = `/${testDbName}`;
    testDbUrl = u.toString();

    // Apply migrations to the test DB by invoking the same script the
    // post-merge path uses. Using the shipped script (rather than
    // re-implementing it inline) means this test also doubles as a
    // smoke check that the migrate script works end-to-end.
    await execFile("node", [MIGRATE_SCRIPT], {
      env: { ...process.env, DATABASE_URL: testDbUrl },
    });

    // Simulate a fully-bootstrapped pg-boss queue. The readiness
    // probe just looks for the existence of `pgboss_resupply.version`
    // — it does not validate row contents.
    const testPool = new Pool({ connectionString: testDbUrl, max: 1 });
    try {
      await testPool.query("CREATE SCHEMA IF NOT EXISTS pgboss_resupply");
      await testPool.query(
        "CREATE TABLE IF NOT EXISTS pgboss_resupply.version (version int)",
      );
    } finally {
      await testPool.end();
    }

    // Point the resupply DB pool at the test database. We swap
    // DATABASE_URL on the process, then reset the singleton so the
    // next `getDbPool()` call picks up the new URL. Restored in
    // afterAll.
    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = testDbUrl;
    __resetDbPoolForTests();

    // Dynamic import AFTER swapping DATABASE_URL so the app module's
    // CORS allowlist uses the same env it would in dev. The app does
    // not eagerly open a DB connection at import time — that happens
    // on the first /readyz call.
    const mod = await import("../app.js");
    app = mod.default;
  }, 60_000);

  afterAll(async () => {
    // Tear down in reverse order. Restore DATABASE_URL FIRST so any
    // straggler `getDbPool()` call after this point points at the
    // real DB, not the about-to-be-dropped test DB.
    if (originalDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = originalDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
    __resetDbPoolForTests();

    if (adminPool) {
      await dropTestDatabase(adminPool, testDbName);
      await adminPool.end();
    }
  }, 30_000);

  it("returns 200 ready when Postgres and the pg-boss schema are both up", async () => {
    const res = await request(app).get("/resupply-api/readyz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ready",
      checks: { db: "ok", queue: "ok" },
    });
  });

  it("returns 503 with queue=schema_not_initialized when the pg-boss schema is dropped", async () => {
    const testPool = new Pool({ connectionString: testDbUrl, max: 1 });
    try {
      await testPool.query("DROP SCHEMA pgboss_resupply CASCADE");

      const res = await request(app).get("/resupply-api/readyz");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("not_ready");
      expect(res.body.checks).toEqual({ db: "ok", queue: "failed" });
      expect(res.body.errors).toEqual({ queue: "schema_not_initialized" });
    } finally {
      // Restore so subsequent tests start from a clean state.
      await testPool.query("CREATE SCHEMA IF NOT EXISTS pgboss_resupply");
      await testPool.query(
        "CREATE TABLE IF NOT EXISTS pgboss_resupply.version (version int)",
      );
      await testPool.end();
    }
  });

  it("returns 503 with db=connection_refused when the database is unreachable", async () => {
    // Point the pool at an unroutable port. We pick port 1 because
    // it's privileged and almost certainly closed; the OS returns
    // ECONNREFUSED immediately rather than waiting for a timeout.
    const unroutable = "postgresql://nope:nope@127.0.0.1:1/nope";
    process.env.DATABASE_URL = unroutable;
    __resetDbPoolForTests();

    try {
      const res = await request(app).get("/resupply-api/readyz");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("not_ready");
      // Both checks share the same pool, so both should fail when the
      // pool can't open a connection.
      expect(res.body.checks).toEqual({ db: "failed", queue: "failed" });
      expect(res.body.errors?.db).toBe("connection_refused");
    } finally {
      process.env.DATABASE_URL = testDbUrl;
      __resetDbPoolForTests();
    }
  });

  it("never echoes the connection string, password, or DATABASE_URL fragments in the response body", async () => {
    // Force a failure so we exercise the error-rendering path.
    const testPool = new Pool({ connectionString: testDbUrl, max: 1 });
    try {
      await testPool.query("DROP SCHEMA pgboss_resupply CASCADE");
      const res = await request(app).get("/resupply-api/readyz");
      expect(res.status).toBe(503);

      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/postgres(?:ql)?:\/\//i);
      expect(body).not.toContain(testDbUrl);
      const password = new URL(testDbUrl).password;
      // Some local configs use no password. Only assert if there is one.
      if (password.length > 0) {
        expect(body).not.toContain(password);
      }
      // The host is a hostname like "helium" — also should not appear.
      const host = new URL(testDbUrl).hostname;
      if (host.length > 0) {
        expect(body).not.toContain(host);
      }
    } finally {
      await testPool.query("CREATE SCHEMA IF NOT EXISTS pgboss_resupply");
      await testPool.query(
        "CREATE TABLE IF NOT EXISTS pgboss_resupply.version (version int)",
      );
      await testPool.end();
    }
  });
});

async function dropTestDatabase(admin: pg.Pool, name: string): Promise<void> {
  // Force-disconnect any stragglers so DROP DATABASE doesn't fail
  // with "database is being accessed by other users". Idempotent —
  // pg_terminate_backend on a non-existent DB is a no-op.
  await admin.query(
    `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [name],
  );
  await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
}
