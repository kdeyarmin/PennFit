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
