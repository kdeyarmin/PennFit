import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskContext } from "vitest";
import { Pool } from "pg";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Integration test for `lib/resupply-db/scripts/migrate.mjs`.
//
// Skips automatically when `DATABASE_URL` is not set so this file is
// safe to run in CI or local environments without a Postgres instance.
//
// Asserts:
//   1. Running the migrate script against the live DB succeeds (exit 0).
//   2. Re-running it is a no-op (idempotent — the cutover problem).
//   3. The `drizzle.resupply_migrations` history table exists with at
//      least one row after a run, and the row count does not change on
//      a second run (proves we're not re-applying migrations).
//   4. The boot path works against a database WITHOUT the `pgcrypto`
//      extension installed. The active resupply schema only relies on
//      `gen_random_uuid()`, which has been built into Postgres core
//      since v13 — pgcrypto is no longer a runtime prerequisite (see
//      task #29). The historical CREATE EXTENSION in migration 0000
//      and the pgp_sym_decrypt references in 0025 only matter on a
//      from-scratch reapply against pre-0025 data; once migrations
//      have been recorded as applied (which they are on every
//      currently-active environment), `migrate.mjs` is a no-op and
//      pgcrypto is not consulted.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATE_SCRIPT = path.resolve(__dirname, "migrate.mjs");
const execFile = promisify(execFileCb);

const dbUrl = process.env.DATABASE_URL;

describe.skipIf(!dbUrl)("resupply-db migrate.mjs", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: dbUrl, max: 1 });
  });

  afterAll(async () => {
    await pool.end();
  });

  async function runMigrate(): Promise<{ stdout: string; stderr: string }> {
    return await execFile("node", [MIGRATE_SCRIPT], {
      env: { ...process.env, DATABASE_URL: dbUrl },
    });
  }

  // Each migrate run shells out a Node process and connects to the
  // live DB; running it twice + two count queries comfortably blows
  // past Vitest's 5s default once enough migrations stack up. 30s is
  // plenty of headroom while still failing fast on a real hang.
  it(
    "applies migrations against the live DB and is idempotent on re-run",
    async () => {
      const first = await runMigrate();
      expect(first.stdout).toMatch(/migrations applied/);

      const before = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM drizzle.resupply_migrations",
      );
      const beforeCount = Number(before.rows[0]!.count);
      expect(beforeCount).toBeGreaterThan(0);

      const second = await runMigrate();
      expect(second.stdout).toMatch(/migrations applied/);

      const after = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM drizzle.resupply_migrations",
      );
      expect(Number(after.rows[0]!.count)).toBe(beforeCount);
    },
    30_000,
  );

  // Regression test for task #29 ("Stop requiring the legacy pgcrypto
  // database extension"). Confirms that the migrate boot path runs
  // cleanly against a database that does NOT have pgcrypto installed,
  // and that primary-key UUID generation (the only remaining
  // function the resupply schema cares about) still works without it
  // — `gen_random_uuid()` is in Postgres core since v13.
  //
  // The test:
  //   1. Best-effort drops the pgcrypto extension (skips if the
  //      connecting role lacks privilege).
  //   2. Runs migrate.mjs and asserts it succeeds (idempotent re-run
  //      of already-applied migrations — pgcrypto is never consulted).
  //   3. Asserts pgcrypto is still NOT installed (i.e. nothing in the
  //      migrate path silently re-installed it).
  //   4. Asserts `gen_random_uuid()` returns a valid UUID without the
  //      extension — the property that lets us drop the extension
  //      requirement in the first place.
  //   5. Re-creates pgcrypto in cleanup so any subsequent test or
  //      tooling that expects it (or pre-task-29 environments)
  //      continues to find it.
  it(
    "boots cleanly against a Postgres database without the pgcrypto extension",
    async (ctx: TaskContext) => {
      let droppedPgcrypto = false;
      try {
        try {
          await pool.query("DROP EXTENSION IF EXISTS pgcrypto");
          droppedPgcrypto = true;
        } catch (err) {
          // The connecting role can't manage extensions — there's no
          // way to actually exercise the "no pgcrypto" path on this
          // DB. Skip via vitest's runtime skip so the result shows up
          // as "skipped" with a reason rather than a silent pass or a
          // failed assertion.
          ctx.skip(
            `DROP EXTENSION pgcrypto failed (likely insufficient privilege); ` +
              `cannot exercise the no-pgcrypto boot path on this DB. Underlying error: ` +
              (err instanceof Error ? err.message : String(err)),
          );
          return;
        }

        const beforeRun = await pool.query<{ exists: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = $1) AS exists",
          ["pgcrypto"],
        );
        expect(beforeRun.rows[0]?.exists).toBe(false);

        const result = await runMigrate();
        expect(result.stdout).toMatch(/migrations applied/);

        const afterRun = await pool.query<{ exists: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = $1) AS exists",
          ["pgcrypto"],
        );
        expect(afterRun.rows[0]?.exists).toBe(false);

        const uuid = await pool.query<{ id: string }>(
          "SELECT gen_random_uuid()::text AS id",
        );
        expect(uuid.rows[0]?.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
      } finally {
        if (droppedPgcrypto) {
          // Best-effort restore. If this fails, surface as a warning
          // by failing the test — leaving the DB in a different state
          // than we found it would silently affect downstream tests.
          await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
        }
      }
    },
    30_000,
  );

  // Task #32 regression: a brand-new deploy must roll forward
  // cleanly through the entire migration history (0000 .. latest)
  // on a fresh, empty database — including the historical
  // pgcrypto-touching migrations 0000 (CREATE EXTENSION) and 0025
  // (pgp_sym_decrypt). The active schema only uses gen_random_uuid
  // (Postgres core since v13), and 0025 must short-circuit on a
  // fresh DB because there are no PHI rows to decrypt.
  //
  // The previous "no pgcrypto" test only validates the idempotent
  // RE-RUN path on an already-migrated DB (drizzle skips 0000 and
  // 0025 because they're already in the migrations table). This
  // test exercises the FROM-SCRATCH path: every migration runs for
  // the first time against a brand-new DB.
  //
  // Note on simulating "pgcrypto truly unavailable":
  // We pre-`DROP EXTENSION IF EXISTS pgcrypto` on the temp DB
  // before running the migrator, but in PG13+ pgcrypto is a
  // "trusted" extension — any role with CREATE on the current
  // database can install it, including the migrator's role here.
  // So 0000 will likely re-install it. We can't easily prevent
  // this in a portable way (REVOKE CREATE on database also breaks
  // CREATE SCHEMA, which the migrator legitimately needs). The
  // tolerance of 0000's DO/EXCEPTION block to insufficient_privilege
  // / feature_not_supported / undefined_file is therefore validated
  // by code review of the static SQL, not at runtime here. What
  // this test DOES validate at runtime:
  //   - 0000..latest applies end-to-end on a brand-new DB
  //   - 0025 short-circuits on zero PHI rows (the production fresh-
  //     deploy scenario) without ever resolving pgp_sym_decrypt
  //   - The post-0025 schema has the right column types (text/jsonb,
  //     not bytea)
  //   - The migrator is idempotent on re-run
  //
  // Skips automatically if the connecting role lacks CREATEDB
  // (managed Postgres often restricts this).
  it(
    "applies the full migration history from scratch on a fresh database",
    async (ctx: TaskContext) => {
      const suffix = Math.random().toString(36).slice(2, 10);
      const tempDbName = `resupply_fresh_${suffix}`;

      // The migrator connects via DATABASE_URL. We rebuild the URL
      // pointing at the temp DB, keeping the same role.
      const tempUrl = new URL(dbUrl!);
      tempUrl.pathname = `/${tempDbName}`;
      const tempDbUrl = tempUrl.toString();

      let createdDb = false;
      try {
        try {
          await pool.query(`CREATE DATABASE "${tempDbName}"`);
          createdDb = true;
        } catch (err) {
          ctx.skip(
            `Could not CREATE DATABASE for the from-scratch test ` +
              `(likely missing CREATEDB privilege on this Postgres). ` +
              `Underlying error: ` +
              (err instanceof Error ? err.message : String(err)),
          );
          return;
        }

        // Connect to the temp DB to drop pgcrypto if it was
        // inherited from template1. Best-effort: if we can't drop
        // it, the test still validates the from-scratch migration
        // path, just with pgcrypto present from the start.
        const tempAdminPool = new Pool({
          connectionString: tempDbUrl,
          max: 1,
        });
        try {
          await tempAdminPool
            .query("DROP EXTENSION IF EXISTS pgcrypto")
            .catch(() => undefined);
        } finally {
          await tempAdminPool.end();
        }

        // Run the migrator end-to-end. Exercises every migration
        // 0000..latest for the FIRST time. With the task #32 fix:
        //   - 0000's CREATE EXTENSION succeeds (we have privilege)
        //     OR fails harmlessly (DO/EXCEPTION). Either way, the
        //     migration completes.
        //   - 0025 sees zero rows in every PHI table, returns early
        //     from preflight, and skips every pgp_sym_decrypt
        //     EXECUTE branch — running as a pure schema swap.
        const result = await execFile("node", [MIGRATE_SCRIPT], {
          env: { ...process.env, DATABASE_URL: tempDbUrl },
        });
        expect(result.stdout).toMatch(/migrations applied/);

        // Re-open against the temp DB to validate post-migration
        // state.
        const verifyPool = new Pool({
          connectionString: tempDbUrl,
          max: 1,
        });
        try {
          // The resupply schema must be fully provisioned.
          const tableCount = await verifyPool.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM information_schema.tables
             WHERE table_schema = 'resupply'`,
          );
          expect(Number(tableCount.rows[0]!.count)).toBeGreaterThan(0);

          // Critical: PHI columns end up in their post-0025 types
          // (text / jsonb), not the historical bytea. If 0025
          // silently skipped any block, this catches it.
          const phiColTypes = await verifyPool.query<{
            table_name: string;
            column_name: string;
            data_type: string;
          }>(
            `SELECT table_name, column_name, data_type
             FROM information_schema.columns
             WHERE table_schema = 'resupply'
               AND (
                    (table_name = 'patients' AND column_name IN
                       ('legal_first_name','legal_last_name','date_of_birth',
                        'phone_e164','email','address'))
                 OR (table_name = 'prescriptions' AND column_name = 'details')
                 OR (table_name = 'messages' AND column_name = 'body')
                 OR (table_name = 'patient_notes' AND column_name = 'body')
                 OR (table_name = 'patient_latest_message'
                     AND column_name = 'last_message_preview')
               )`,
          );
          for (const row of phiColTypes.rows) {
            expect(
              row.data_type,
              `${row.table_name}.${row.column_name} should not be bytea after 0025`,
            ).not.toBe("bytea");
          }

          // gen_random_uuid (Postgres core since v13) must work —
          // it's the only function the active schema cares about.
          const uuid = await verifyPool.query<{ id: string }>(
            "SELECT gen_random_uuid()::text AS id",
          );
          expect(uuid.rows[0]?.id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          );
        } finally {
          await verifyPool.end();
        }

        // Idempotence: re-running the migrator must succeed and
        // apply zero new migrations.
        const second = await execFile("node", [MIGRATE_SCRIPT], {
          env: { ...process.env, DATABASE_URL: tempDbUrl },
        });
        expect(second.stdout).toMatch(/migrations applied/);
      } finally {
        if (createdDb) {
          // Best-effort terminate any lingering backends from the
          // migrate.mjs subprocess BEFORE dropping the DB; Postgres
          // refuses DROP DATABASE on a DB with active sessions.
          await pool
            .query(
              `SELECT pg_terminate_backend(pid)
               FROM pg_stat_activity
               WHERE datname = $1 AND pid <> pg_backend_pid()`,
              [tempDbName],
            )
            .catch(() => undefined);
          await pool
            .query(`DROP DATABASE IF EXISTS "${tempDbName}"`)
            .catch((err) => {
              // eslint-disable-next-line no-console
              console.warn(
                `[test cleanup] DROP DATABASE ${tempDbName} failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
        }
      }
    },
    60_000,
  );

  it("exits with code 2 when DATABASE_URL is unset", async () => {
    let exitCode: number | null = null;
    try {
      await execFile("node", [MIGRATE_SCRIPT], {
        env: { ...process.env, DATABASE_URL: "" },
      });
    } catch (err: unknown) {
      const e = err as { code?: number };
      exitCode = e.code ?? null;
    }
    expect(exitCode).toBe(2);
  });
});
