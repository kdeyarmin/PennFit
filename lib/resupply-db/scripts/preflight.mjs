#!/usr/bin/env node
// Resupply database preflight.
//
// Idempotently enables the pgcrypto extension and verifies it is
// installed against the database pointed to by DATABASE_URL. Intended
// for the post-merge / deploy path so a fresh environment never ships
// with a half-broken DB (schema present, encryption functions missing).
//
// Why a separate script and not just a startup check?
//   The startup check (`assertPgcryptoEnabled` in the API and worker)
//   refuses to listen if pgcrypto is missing — that's the right
//   behavior for a service process. But it also means a deploy that
//   forgot to enable the extension will leave the service crash-
//   looping until someone fixes it. Running this script EARLIER, in
//   the deploy / post-merge step, fixes the missing-extension case
//   automatically before the service is even started.
//
// Exit codes:
//   0 — pgcrypto is enabled (either already, or after this run).
//   1 — couldn't install pgcrypto AND the extension is still missing.
//   2 — DATABASE_URL is not set.
//
// Why a plain .mjs and not a tsx import of the library helpers?
//   This script runs as the very first DB-touching step in
//   `scripts/post-merge.sh`, BEFORE `pnpm --filter db push`. At that
//   moment the resupply-db library may not yet be built (no `dist/`),
//   workspace TS may not yet typecheck, and we want zero compile
//   tooling in the critical deploy path. The two SQL strings below
//   (`CREATE EXTENSION IF NOT EXISTS pgcrypto` and the
//   `pg_extension`-based existence query) intentionally mirror the
//   library helpers in `../src/preflight.ts`; if those change, update
//   here too. The library tests guard their side; this script's
//   correctness is exercised by the post-merge step.

import pg from "pg";

const { Pool } = pg;

async function main() {
  if (!process.env.DATABASE_URL) {
    process.stderr.write(
      "[resupply-db-preflight] DATABASE_URL is not set — refusing to run.\n",
    );
    process.exit(2);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5_000,
  });

  try {
    try {
      await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    } catch (err) {
      // CREATE may fail if the role lacks CREATE on the database. We
      // still try the read-only check below — if pgcrypto was already
      // installed by an admin, the assertion will pass.
      process.stderr.write(
        `[resupply-db-preflight] CREATE EXTENSION attempt failed: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }

    const result = await pool.query(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = $1) AS exists",
      ["pgcrypto"],
    );

    if (result.rows[0]?.exists !== true) {
      process.stderr.write(
        "[resupply-db-preflight] pgcrypto extension is not installed and could " +
          "not be enabled by the connecting role. Have a database " +
          "administrator run `CREATE EXTENSION pgcrypto;` against this " +
          "database, then re-run.\n",
      );
      process.exit(1);
    }

    process.stdout.write(
      "[resupply-db-preflight] pgcrypto extension is enabled.\n",
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  process.stderr.write(
    `[resupply-db-preflight] unexpected failure: ${
      err instanceof Error ? err.stack ?? err.message : String(err)
    }\n`,
  );
  process.exit(1);
});
