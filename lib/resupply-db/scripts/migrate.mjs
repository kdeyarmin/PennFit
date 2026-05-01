#!/usr/bin/env node
// Resupply database migrator.
//
// Applies every pending migration in `lib/resupply-db/drizzle/` to the
// database pointed to by DATABASE_URL, idempotently. Replaces the
// prior `drizzle-kit push:force` deploy step (see ADR 003).
//
// Why migrations and not `push`?
//   `push` diffs the live DB against the schema and silently rewrites
//   columns to make them match. That's fine while every table is empty;
//   it stops being fine the second any synthetic or real PHI lands in
//   the resupply schema. Versioned migrations are reviewable, ordered,
//   and the migrator refuses to re-apply them once they've run.
//
// Why a `.mjs` and not a tsx import of the library?
//   This runs as part of `scripts/post-merge.sh`, which executes
//   BEFORE the workspace is built. Keeping the deploy path free of
//   compile tooling matches the existing `preflight.mjs` precedent.
//
// Why the advisory lock?
//   `scripts/post-merge.sh` runs on every merge into main, and we may
//   one day kick it off from multiple deploy slots in parallel. Two
//   migrators racing would each see the same "missing migration" set
//   and try to apply it; one would win and the other would error
//   half-way through, leaving the migration history inconsistent.
//   `pg_advisory_lock` is a session-scoped, exclusive Postgres lock
//   that serializes contenders without holding any table locks — the
//   second migrator simply waits until the first releases. We hold the
//   lock for the lifetime of the migrate() call and release it in
//   `finally` so a crash never strands the lock.
//
// Migration history is stored in `drizzle.resupply_migrations` so it
// never collides with the PennPaps fitter's `public.*` tables. The `drizzle`
// schema is created on demand below — drizzle-orm's migrator does not
// auto-create it.
//
// Exit codes:
//   0 — migrations applied (or already up to date).
//   1 — migration failed for any reason.
//   2 — DATABASE_URL is not set.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "..", "drizzle");
const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "resupply_migrations";

// Constant 64-bit signed int chosen at random; never overlap with any
// other advisory lock used by the project. Stored as a bigint literal
// so the driver round-trips it as a single int8 argument.
const ADVISORY_LOCK_KEY = 7427398427542000001n;

async function main() {
  if (!process.env.DATABASE_URL) {
    process.stderr.write(
      "[resupply-db-migrate] DATABASE_URL is not set — refusing to run.\n",
    );
    process.exit(2);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5_000,
  });

  // Pin a single connection so the advisory lock stays on the same
  // session as the migration. drizzle-orm's `migrate()` accepts a
  // PoolClient directly, so we hand it the same pinned client.
  const client = await pool.connect();
  let lockAcquired = false;
  try {
    // Bound how long we will wait for the advisory lock. Without a
    // timeout, a wedged or zombie holder (Replit hibernation, a dev
    // process killed mid-migrate whose connection hasn't yet timed
    // out server-side) can block a deploy indefinitely with no
    // visible failure mode. 60 seconds is long enough that two
    // normal migrators racing serialize cleanly (a real migration
    // typically runs in well under a second), and short enough
    // that a stuck deploy fails AUDIBLY at the deploy gate instead
    // of hanging silently.
    //
    // We deliberately scope `lock_timeout` to the advisory-lock
    // acquisition only, then reset it before running migrations.
    // `lock_timeout` is session-wide and applies to ALL lock waits
    // (including the heavyweight DDL locks Drizzle takes during
    // CREATE/ALTER), so leaving it at 60s would cap legitimate
    // long-running migrations. Resetting to 0 (no timeout) for the
    // migrate phase keeps DDL behavior identical to pre-change.
    await client.query("SET lock_timeout = '60s'");
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    lockAcquired = true;
    await client.query("SET lock_timeout = 0");

    // drizzle-orm's migrator inserts into <schema>.<table> the moment it
    // begins — but it never issues `CREATE SCHEMA`. If the schema is
    // missing, the very first migrate() call fails with `schema "drizzle"
    // does not exist`. Pre-create it idempotently.
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${MIGRATIONS_SCHEMA}"`);

    const db = drizzle(client);
    await migrate(db, {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsSchema: MIGRATIONS_SCHEMA,
      migrationsTable: MIGRATIONS_TABLE,
    });

    process.stdout.write(
      "[resupply-db-migrate] migrations applied (or already up to date).\n",
    );
  } finally {
    if (lockAcquired) {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [
          ADVISORY_LOCK_KEY,
        ]);
      } catch {
        // Best-effort. The lock is session-scoped, so closing the
        // connection below releases it regardless.
      }
    }
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  process.stderr.write(
    `[resupply-db-migrate] unexpected failure: ${
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    }\n`,
  );
  process.exit(1);
});
