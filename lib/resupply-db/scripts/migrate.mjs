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
 * Read every `<NNNN>_*.sql` file directly off disk (sorted by the
 * numeric prefix) and return the migration list. Drizzle's
 * `_journal.json` is FROZEN at 52 entries despite ~180 SQL files
 * on disk; iterating the journal would silently skip every net-new
 * migration. We therefore use the filesystem as the source of
 * truth for "what migrations exist" and rely on the history table's
 * `hash` column to determine "what's already been applied".
 *
 * If a journal entry exists for a given `<tag>.sql`, we preserve
 * its `when` timestamp in `folderMillis` so the history table's
 * `created_at` column stays byte-identical to the values Drizzle
 * wrote on past runs (so a production DB whose rows were inserted
 * by Drizzle still matches). New (non-journaled) files use the
 * extracted numeric prefix interpreted as a timestamp — large
 * enough to sort after any journaled entry, durable across
 * re-clones, and within bigint range.
 *
 * Statement split:
 *   * `sql` — list of statements obtained by splitting the file
 *     contents on the literal string "--> statement-breakpoint".
 *     This split is naive (it does not respect `$$ ... $$` dollar
 *     quotes or SQL string literals). PennFit's checked-in SQL
 *     never contains that literal inside a string or function body
 *     — verified at write time; the pre-commit
 *     `check-resupply-migration-prefix.sh` does NOT enforce this
 *     so authors should avoid the literal inside function bodies.
 *
 * Per-migration transaction opt-out:
 *   * A file whose first non-blank line is the sentinel comment
 *     `-- migrate: no-transaction` is run OUTSIDE the wrapping
 *     BEGIN/COMMIT. Required for statements that refuse to run
 *     inside a transaction block, e.g. `CREATE INDEX CONCURRENTLY`,
 *     `ALTER TYPE … ADD VALUE` (Postgres <12), `VACUUM`,
 *     `REINDEX CONCURRENTLY`.
 */
function readMigrations(folder) {
  const journalPath = path.join(folder, "meta", "_journal.json");
  let journalByTag = new Map();
  if (fs.existsSync(journalPath)) {
    try {
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      for (const entry of journal.entries ?? []) {
        if (entry && typeof entry.tag === "string") {
          journalByTag.set(entry.tag, entry);
        }
      }
    } catch (err) {
      throw new Error(
        `Could not parse ${journalPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const sqlFiles = fs
    .readdirSync(folder)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const migrations = [];
  const seenPrefixes = new Map();
  for (const fileName of sqlFiles) {
    const tag = fileName.slice(0, -".sql".length);
    const prefixMatch = /^(\d+)/.exec(tag);
    if (!prefixMatch) {
      // Skip stray .sql files not following the NNNN_ convention.
      // The pre-commit `check-resupply-migration-prefix.sh` enforces
      // the prefix on committed migrations; ignoring un-prefixed
      // files lets test fixtures live in the same folder safely.
      continue;
    }
    const prefix = prefixMatch[1];
    const prior = seenPrefixes.get(prefix);
    if (prior !== undefined) {
      // Legacy duplicate-prefix pairs exist on disk (e.g. two PRs
      // committed 0157_* concurrently before the prefix check landed).
      // Both have already been applied in production. Surface a clear
      // warning so contributors stop the bleed but don't throw, since
      // refusing to start would brick deploys against the historical
      // tree. The deploy-time gate to PREVENT new duplicate prefixes
      // lives in `scripts/check-resupply-migration-prefix.sh`.
      process.stderr.write(
        `[resupply-db-migrate] WARNING: duplicate migration prefix ${prefix} ("${prior}" and "${tag}") — both will be applied in lexicographic order.\n`,
      );
    }
    seenPrefixes.set(prefix, tag);

    const sqlPath = path.join(folder, fileName);
    const content = fs.readFileSync(sqlPath, "utf8");

    // Sentinel must be the FIRST non-blank line of the file. A
    // looser "anywhere in the first 5 lines" check could match the
    // sentinel inside a leading multi-line block comment OR a
    // header that happens to mention the marker, silently opting
    // OUT of transactionality. Require the strict shape so the
    // opt-out is unambiguous.
    const firstNonBlankLine =
      content.split("\n").find((line) => line.trim() !== "") ?? "";
    const noTransaction = /^--\s*migrate:\s*no-transaction\s*$/i.test(
      firstNonBlankLine,
    );

    const journalEntry = journalByTag.get(tag);
    const prefixNumber = Number(prefix);
    const folderMillis =
      journalEntry && typeof journalEntry.when === "number"
        ? journalEntry.when
        : prefixNumber;

    migrations.push({
      tag,
      sql: content.split("--> statement-breakpoint"),
      hash: crypto.createHash("sha256").update(content).digest("hex"),
      folderMillis,
      prefixNumber,
      hasJournalEntry: Boolean(journalEntry),
      noTransaction,
    });
  }
  // Stable sort by `folderMillis` for journaled migrations, then append
  // disk-only migrations by numeric prefix so fresh databases still run
  // the historical base schema before newer, unjournaled files.
  //
  // This preserves two guarantees:
  //   * journaled migrations keep their `when` timestamps so the
  //     history `created_at` column stays consistent with what
  //     Drizzle wrote;
  //   * unjournaled migrations keep filename order across prefixes.
  migrations.sort((a, b) => {
    if (a.hasJournalEntry !== b.hasJournalEntry) {
      return a.hasJournalEntry ? -1 : 1;
    }
    if (!a.hasJournalEntry && !b.hasJournalEntry) {
      if (a.prefixNumber !== b.prefixNumber) {
        return a.prefixNumber - b.prefixNumber;
      }
      return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
    }
    if (a.folderMillis !== b.folderMillis) {
      return a.folderMillis - b.folderMillis;
    }
    return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
  });
  return migrations;
}

/**
 * Apply every pending migration on the supplied client.
 *
 *   1. CREATE SCHEMA + CREATE TABLE IF NOT EXISTS so the very first
 *      run against a brand-new DB has somewhere to record results.
 *      Table shape matches Drizzle's exactly (id SERIAL PK + hash
 *      text + created_at bigint) so a database whose rows were
 *      written by the legacy Drizzle migrator can be picked up
 *      without rewriting.
 *   2. Load every applied hash from the history table into a set.
 *      Dedup is content-hash-based — a migration is "pending" iff
 *      its sha256 hash is NOT in the set. This is durable across
 *      the frozen `_journal.json` (CLAUDE.md) and across re-clones,
 *      and never silently skips files that exist on disk.
 *   3. Walk migrations in stable order; for each pending one, run
 *      its statements (transactional by default, or out-of-
 *      transaction when the file opts in via `-- migrate: no-
 *      transaction`) and INSERT a row into the history table.
 *
 * Transactional vs not:
 *   * Transactional (default): wrapped per-migration in
 *     BEGIN/COMMIT. A failure rolls back the migration and stops
 *     the run with the partial-batch state preserved up to (but
 *     not including) the failing migration.
 *   * No-transaction (opt-in): statements run outside any
 *     transaction. Required for `CREATE INDEX CONCURRENTLY`,
 *     `ALTER TYPE ... ADD VALUE` (older PG), etc. A failure mid-
 *     migration leaves partial state on the DB; the operator must
 *     diagnose and recover manually (matches Drizzle's previous
 *     behavior when an author dropped CONCURRENTLY to work around
 *     the wrap).
 *
 * Per-migration commit (rather than the historical single
 * transaction across the whole batch) means a long migration list
 * doesn't roll back the early successes when a later one fails —
 * the operator can fix the failing file and re-run.
 */
async function applyPendingMigrations(client, migrations) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" (
       id SERIAL PRIMARY KEY,
       hash text NOT NULL,
       created_at bigint
     )`,
  );

  const appliedRows = await client.query(
    `SELECT hash FROM "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`,
  );
  const appliedHashes = new Set(
    appliedRows.rows
      .map((r) => (typeof r.hash === "string" ? r.hash : null))
      .filter((h) => h !== null),
  );

  let appliedCount = 0;
  for (const migration of migrations) {
    if (appliedHashes.has(migration.hash)) {
      continue;
    }
    if (migration.noTransaction) {
      // No surrounding BEGIN — the SQL author has explicitly opted
      // out for statements that can't run inside a transaction
      // block. Errors leave partial state and are surfaced as-is.
      for (const stmt of migration.sql) {
        await client.query(stmt);
      }
      await client.query(
        `INSERT INTO "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"
         ("hash", "created_at") VALUES ($1, $2)`,
        [migration.hash, migration.folderMillis],
      );
    } else {
      await client.query("BEGIN");
      try {
        for (const stmt of migration.sql) {
          // `query.split("--> statement-breakpoint")` can leave
          // whitespace-only chunks (trailing newline before the
          // next marker). node-postgres tolerates empty statements.
          await client.query(stmt);
        }
        await client.query(
          `INSERT INTO "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"
           ("hash", "created_at") VALUES ($1, $2)`,
          [migration.hash, migration.folderMillis],
        );
        await client.query("COMMIT");
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Pool client will be released regardless; ignore
          // secondary failure during rollback.
        }
        throw new Error(
          `Migration "${migration.tag}" failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
    }
    appliedCount += 1;
    process.stdout.write(
      `[resupply-db-migrate] applied ${migration.tag}${
        migration.noTransaction ? " (no-tx)" : ""
      }\n`,
    );
  }

  return appliedCount;
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

<<<<<<< HEAD
    // Historical resupply migrations (e.g. early CREATE TABLE
    // statements under `resupply.*`) assume the schema already
    // exists. Pre-create idempotently so a fresh DB can replay the
    // full migration history end-to-end in CI.
    await client.query(`CREATE SCHEMA IF NOT EXISTS "resupply"`);

=======
    // Pre-create the `resupply` schema too. Historical migrations
    // assume the schema already exists (it was created in 0000 via
    // the legacy Drizzle path, before the schema-creation step was
    // moved to a separate concern). Without this, a fresh CI / dev
    // database fails the first `CREATE TABLE resupply.*` statement
    // with `schema "resupply" does not exist`. The runtime data path
    // (Supabase service-role client) also expects this schema; the
    // env-check refuses to boot without `resupply` exposed in
    // PostgREST. Idempotent CREATE IF NOT EXISTS is safe everywhere.
    await client.query(`CREATE SCHEMA IF NOT EXISTS "resupply"`);

    // Same rationale for the `resupply_auth` schema, used by the
    // in-house auth library (lib/resupply-auth/src/supabase-
    // repository.ts).
    await client.query(`CREATE SCHEMA IF NOT EXISTS "resupply_auth"`);

>>>>>>> origin/main
    const migrations = readMigrations(MIGRATIONS_FOLDER);
    const appliedCount = await applyPendingMigrations(client, migrations);

    process.stdout.write(
      `[resupply-db-migrate] ${appliedCount} migration${
        appliedCount === 1 ? "" : "s"
      } applied (${migrations.length} on disk).\n`,
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
