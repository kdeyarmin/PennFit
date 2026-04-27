import type { Pool } from "pg";

// Preflight checks for the resupply database.
//
// Encrypted PHI columns (`encryptedText` / `encryptedJson` in
// `./encryption.ts`) are produced and consumed via pgcrypto's
// `pgp_sym_encrypt` / `pgp_sym_decrypt` functions. Those functions
// only exist after the `pgcrypto` extension has been installed in the
// target database. If a fresh environment forgets to enable the
// extension, the schema can be pushed without error and the API/worker
// can boot without complaining — the failure only surfaces on the
// first encrypted write, as a confusing "function pgp_sym_encrypt(...)
// does not exist" error.
//
// To stop that class of incident:
//   - `ensurePgcryptoEnabled` runs `CREATE EXTENSION IF NOT EXISTS
//     pgcrypto` and is intended for deploy / post-merge scripts that
//     have permission to install extensions.
//   - `assertPgcryptoEnabled` is a read-only check that fails with a
//     clear, actionable error message and is intended for process
//     startup (API + worker), where we'd rather refuse to listen than
//     accept traffic and 500 on the first PHI write.
//
// The check uses a parameterized query against `pg_extension` so it's
// safe against any plausible regression in `extname` quoting and so it
// returns even if the user role lacks CREATE EXTENSION privilege
// (read on `pg_extension` is granted to PUBLIC by default).

export class PgcryptoNotInstalledError extends Error {
  constructor() {
    super(
      "pgcrypto extension is not installed in the target database. " +
        "Resupply PHI columns rely on pgp_sym_encrypt / pgp_sym_decrypt. " +
        "Run `CREATE EXTENSION IF NOT EXISTS pgcrypto;` against the " +
        "database (the resupply-db preflight script does this for you), " +
        "then restart this process.",
    );
    this.name = "PgcryptoNotInstalledError";
  }
}

export async function isPgcryptoEnabled(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = $1) AS exists",
    ["pgcrypto"],
  );
  return result.rows[0]?.exists === true;
}

export async function assertPgcryptoEnabled(pool: Pool): Promise<void> {
  if (!(await isPgcryptoEnabled(pool))) {
    throw new PgcryptoNotInstalledError();
  }
}

export async function ensurePgcryptoEnabled(pool: Pool): Promise<void> {
  // Idempotent. Requires the connecting role to have CREATE on the
  // current database, which is the default for the role that owns the
  // DB. If this throws a permission error in production, the deploy
  // role needs `GRANT CREATE ON DATABASE <name> TO <role>`, OR the
  // extension should be pre-installed by a one-time bootstrap step.
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
}
