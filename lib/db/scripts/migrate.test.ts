import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Integration test for `lib/db/scripts/migrate.mjs` — the storefront
// migrator that now sits on the api-server / cpap-fitter deploy path
// in place of the prior `drizzle-kit push` flow (see ADR 003).
//
// Skips automatically when `DATABASE_URL` is not set so this file is
// safe to run in CI or local environments without a Postgres instance.
//
// Asserts:
//   1. Running the migrate script against the live DB succeeds (exit 0).
//   2. Re-running it is a no-op (idempotent — the cutover problem
//      that kicked off ADR 003 in the first place: `push` would
//      happily re-diff and rewrite columns on every deploy, the
//      migrator must not).
//   3. The `drizzle.storefront_migrations` history table exists with
//      at least one row after a run, and the row count does not
//      change on a second run (proves we're not silently
//      re-applying migrations).
//
// Mirrors `lib/resupply-db/scripts/migrate.test.ts`. Kept narrowly
// scoped to the storefront migrator's own contract; the resupply
// pgcrypto regression test is intentionally not duplicated here
// because the storefront schema does not (and never did) depend on
// pgcrypto.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATE_SCRIPT = path.resolve(__dirname, "migrate.mjs");
const execFile = promisify(execFileCb);

const dbUrl = process.env.DATABASE_URL;

describe.skipIf(!dbUrl)("storefront db migrate.mjs", () => {
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
        "SELECT count(*)::text AS count FROM drizzle.storefront_migrations",
      );
      const beforeCount = Number(before.rows[0]!.count);
      expect(beforeCount).toBeGreaterThan(0);

      const second = await runMigrate();
      expect(second.stdout).toMatch(/migrations applied/);

      const after = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM drizzle.storefront_migrations",
      );
      expect(Number(after.rows[0]!.count)).toBe(beforeCount);
    },
    30_000,
  );
});
