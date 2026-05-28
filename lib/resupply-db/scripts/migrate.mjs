#!/usr/bin/env node
// Resupply database migrator.
//
// Applies every pending migration in `lib/resupply-db/drizzle/` to
// the database pointed to by DATABASE_URL, idempotently. Invoked by
// `scripts/post-merge.sh` as the deploy-time DB sync step.
//
// History: this script used to delegate the apply phase to
// `drizzle-orm/node-postgres/migrator`. When the Drizzle tooling was
// retired the dependency was dropped, and this file inlined the same
// algorithm with raw `pg`. The on-disk migration format (the
// `_journal.json` index + `<tag>.sql` files split on
// `--> statement-breakpoint`) and the on-DB history-table format
// (`drizzle.resupply_migrations(id SERIAL PK, hash text, created_at
// bigint)`) match Drizzle's so a fresh checkout points at a
// production DB and the migrator considers every already-applied row
// up-to-date — no re-run, no schema rewrite. See ADR 003 for the
// "checked-in versioned migrations, never `push`" rationale.
//
// Why a `.mjs` and not a tsx import of the library?
//   This runs as part of `scripts/post-merge.sh`, which executes
//   BEFORE the workspace is built. Keeping the deploy path free of
//   compile tooling means no tsx / tsconfig dance just to apply DB
//   migrations.
//
// Why the advisory lock?
//   `scripts/post-merge.sh` runs on every merge into main, and we
//   may one day kick it off from multiple deploy slots in parallel.
//   Two migrators racing would each see the same "missing migration"
//   set and try to apply it; one would win and the other would error
//   half-way through, leaving the migration history inconsistent.
//   `pg_advisory_lock` is a session-scoped, exclusive Postgres lock
//   that serializes contenders without holding any table locks — the
//   second migrator simply waits until the first releases. We hold
//   the lock for the lifetime of the apply phase and release it in
//   `finally` so a crash never strands the lock.
//
// Migration history is stored in `drizzle.resupply_migrations` so it
// never collides with the PennPaps fitter's `public.*` tables. The
// `drizzle` schema is created on demand below. The schema + table
// name are historical (Drizzle's defaults) and stay unchanged so the
// existing production rows continue to gate new migrations cleanly.
//
// Exit codes:
//   0 — migrations applied (or already up to date).
//   1 — migration failed for any reason.
//   2 — DATABASE_URL is not set.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "..", "drizzle");
const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "resupply_migrations";

// Constant 64-bit signed int chosen at random; never overlap with
// any other advisory lock used by the project. Stored as a bigint
// literal so the driver round-trips it as a single int8 argument.
const ADVISORY_LOCK_KEY = 7427398427542000001n;

/**
 * Acquire a single client from the supplied pool, retrying on the
 * narrow set of node-postgres errors we know mean "Postgres isn't
 * accepting connections yet" (ECONNREFUSED, ENOTFOUND on the
 * resolution path, the libpq-style "starting up" SQLSTATE, and a
 * driver-level connect timeout). Any other failure — auth error,
 * bad database name, query error — surfaces on the first attempt
 * and propagates so a real misconfig doesn't get masked by retries.
 */
async function connectWithRetry(pool, { attempts, backoffMs }) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await pool.connect();
    } catch (err) {
      lastErr = err;
      const code = err && typeof err === "object" ? err.code : undefined;
      const transient =
        code === "ECONNREFUSED" ||
        code === "ENOTFOUND" ||
        code === "ETIMEDOUT" ||
        // Postgres `cannot_connect_now` — server is still in
        // recovery/startup mode.
        code === "57P03";
      if (!transient || i === attempts - 1) throw err;
      process.stderr.write(
        `[resupply-db-migrate] connect attempt ${i + 1}/${attempts} ` +
          `failed (${code}); retrying in ${backoffMs}ms\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  // Unreachable — the loop either returns or throws above.
  throw lastErr;
}

/**
 * Read `_journal.json` + every `<tag>.sql` file referenced by it,
 * compute the same content hash Drizzle does, and return the list
 * of migrations in journal order. Matches
 * `drizzle-orm/migrator.js:readMigrationFiles` exactly:
 *
 *   * `sql` — array of statements obtained by splitting the file
 *     contents on the literal string "--> statement-breakpoint".
 *   * `hash` — sha256(<full file contents as text>) hex-encoded.
 *   * `folderMillis` — `entries[i].when` from `_journal.json`.
 *
 * This is the function whose output formatting MUST match Drizzle's
 * — the apply phase below assumes `folderMillis` is what got
 * written into the history table's `created_at` column on every
 * past migration, and the schema/table format is what Drizzle's
 * `migrate()` created.
 */
function readMigrations(folder) {
  const journalPath = path.join(folder, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) {
    throw new Error(`Can't find meta/_journal.json file at ${journalPath}`);
  }
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const migrations = [];
  for (const entry of journal.entries) {
    const sqlPath = path.join(folder, `${entry.tag}.sql`);
    let content;
    try {
      content = fs.readFileSync(sqlPath, "utf8");
    } catch {
      throw new Error(`No file ${entry.tag}.sql found in ${folder}`);
    }
    migrations.push({
      tag: entry.tag,
      sql: content.split("--> statement-breakpoint"),
      hash: crypto.createHash("sha256").update(content).digest("hex"),
      folderMillis: entry.when,
    });
  }
  return migrations;
}

/**
 * Apply every pending migration on the supplied client. Mirrors the
 * algorithm in `drizzle-orm/pg-core/dialect.js:migrate`:
 *
 *   1. CREATE SCHEMA + CREATE TABLE IF NOT EXISTS so the very first
 *      run against a brand-new DB has somewhere to record results.
 *      The table shape matches Drizzle's exactly (id SERIAL PK +
 *      hash text + created_at bigint).
 *   2. Read the most-recently-applied migration's `created_at` —
 *      gates the "is this entry newer than what's already applied?"
 *      check below. NULL on a fresh DB.
 *   3. In a single transaction, walk the migrations list in journal
 *      order. For each entry whose `folderMillis` is strictly
 *      greater than the last applied `created_at`, execute every
 *      statement and INSERT a row into the history table.
 *
 * The "strictly greater" check is what makes the migrator idempotent
 * on re-run — once an entry is applied its `folderMillis` becomes
 * the new lastDbMigration.created_at, so the next run sees it as
 * "not strictly greater" and skips.
 */
async function applyPendingMigrations(client, migrations) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" (
       id SERIAL PRIMARY KEY,
       hash text NOT NULL,
       created_at bigint
     )`,
  );

  const lastRow = await client.query(
    `SELECT created_at FROM "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"
     ORDER BY created_at DESC NULLS LAST LIMIT 1`,
  );
  const lastCreatedAt =
    lastRow.rows.length > 0 && lastRow.rows[0].created_at != null
      ? Number(lastRow.rows[0].created_at)
      : null;

  // Single transaction across every pending migration. If any
  // statement fails, the whole pending batch rolls back together —
  // matching Drizzle's existing behaviour and what production has
  // always seen.
  await client.query("BEGIN");
  try {
    for (const migration of migrations) {
      if (lastCreatedAt !== null && lastCreatedAt >= migration.folderMillis) {
        continue;
      }
      for (const stmt of migration.sql) {
        // `query.split("--> statement-breakpoint")` can leave
        // whitespace-only chunks (trailing newline before the next
        // marker). Drizzle's migrator hands them straight to the
        // driver and node-postgres tolerates empty statements; we
        // do the same to stay byte-compatible.
        await client.query(stmt);
      }
      await client.query(
        `INSERT INTO "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"
         ("hash", "created_at") VALUES ($1, $2)`,
        [migration.hash, migration.folderMillis],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Pool client will be released regardless; ignore secondary
      // failure during rollback.
    }
    throw err;
  }
}

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
  // session as the migration.
  //
  // Connection retry: a freshly-started Postgres instance (CI
  // service container, local docker-compose, Railway cold start)
  // can briefly accept TCP connections while still rejecting them
  // at the libpq layer, surfacing as ECONNREFUSED. We retry up to
  // 5 times with a 1 s linear backoff so a transient unavailability
  // at startup does not fail the whole migrate. Real configuration
  // errors (auth failure, no such database) surface on the second
  // attempt with the same SQLSTATE and propagate.
  const client = await connectWithRetry(pool, {
    attempts: 5,
    backoffMs: 1_000,
  });
  let lockAcquired = false;
  try {
    // Bound how long we will wait for the advisory lock. Without a
    // timeout, a wedged or zombie holder (a sleeping deploy
    // container, a dev process killed mid-migrate whose connection
    // hasn't yet timed
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
    // (including the heavyweight DDL locks migrations take during
    // CREATE/ALTER), so leaving it at 60s would cap legitimate
    // long-running migrations. Resetting to 0 (no timeout) for the
    // apply phase keeps DDL behavior identical to the prior
    // Drizzle-based implementation.
    await client.query("SET lock_timeout = '60s'");
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    lockAcquired = true;
    await client.query("SET lock_timeout = 0");

    // (Historical: this block used to read RESUPPLY_DATA_KEY and
    // set `app.data_key` so migration 0025_strip_phi_encryption
    // could decrypt the legacy pgcrypto-encrypted PHI columns on
    // the way out. 0025 has long since been applied to every active
    // environment, so the assist is gone. The active resupply
    // schema no longer requires the pgcrypto extension at all
    // (task #32): 0000 tolerates pgcrypto being unavailable, and
    // 0025 only resolves pgp_sym_decrypt when there are real
    // encrypted rows to decrypt — i.e. never on a fresh DB. If you
    // ever need to replay against a database rebuilt from a
    // pre-0025 PHI dump, restore both this block and the pgcrypto
    // extension before running.)

    // The migration apply phase inserts into <schema>.<table> the
    // moment it begins — but our prior implementation never issued
    // `CREATE SCHEMA`. If the schema is missing, the very first
    // INSERT fails with `schema "drizzle" does not exist`.
    // Pre-create it idempotently.
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${MIGRATIONS_SCHEMA}"`);

    // Migration 0059 (when it lands in the journal) creates
    // `auth.set_updated_at()` without first creating the `auth`
    // schema — the migration was authored against a deployed DB
    // that already had it. Pre-create idempotently so fresh local
    // + CI databases can eventually apply the historical migrations
    // end-to-end. No-op on production where the schema already
    // exists; no-op today because 0059 isn't in `_journal.json`
    // yet (see docs/migration-state-investigation-2026-05-08.md).
    // Cheap pre-work so the gating drift-fix doesn't trip on this
    // when it lands.
    await client.query(`CREATE SCHEMA IF NOT EXISTS "auth"`);

    // Historical resupply migrations (e.g. early CREATE TABLE
    // statements under `resupply.*`) assume the schema already
    // exists. Pre-create idempotently so a fresh DB can replay the
    // full migration history end-to-end in CI.
    await client.query(`CREATE SCHEMA IF NOT EXISTS "resupply"`);

    const migrations = readMigrations(MIGRATIONS_FOLDER);
    await applyPendingMigrations(client, migrations);

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
