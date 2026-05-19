// auth:set-admin-password — create-or-update an in-house auth user
// with the given role and set their password directly (argon2id).
//
// This is a sibling to auth-bootstrap-admin.ts. The bootstrap script
// only issues a password-reset email/link and requires the operator
// to click through the reset flow. This script is for the case where
// the operator knows the password they want and just wants the
// account usable immediately (e.g. seeding the first internal admin,
// recovering an account whose reset email never arrived).
//
// Usage:
//   DATABASE_URL=postgres://... \
//   ADMIN_PASSWORD='…' \
//   pnpm --filter @workspace/scripts auth:set-admin-password \
//     --email=alice@example.com --role=admin
//
// The password is read from the ADMIN_PASSWORD env var rather than
// an argv flag so it does NOT appear in `ps`, shell history, or
// process listings. The script never prints the password or its
// hash to stdout/stderr.
//
// Why raw SQL via the pg pool instead of the Supabase PostgREST
// repository: the `resupply_auth` schema is not always in the
// PostgREST exposed-schemas allowlist (PGRST125 "Invalid path
// specified in request URL"), so the auth-bootstrap-admin path can
// fail in environments where SQL access still works. Going through
// the shared pg pool sidesteps that and matches how the migration
// tooling reaches these tables.
//
// Behaviour:
//   * Creates the user if absent. If present, sets status to
//     'active' so sign-in is immediately allowed.
//   * Updates role when --force is passed and the role differs.
//   * Always upserts the password credential — running the script
//     twice rotates the password to the new value.
//   * Exit codes: 0 ok, 1 usage/db error, 2 DATABASE_URL not set.

import { getDbPool } from "@workspace/resupply-db";
import { hashPassword, normalizeEmail } from "@workspace/resupply-auth";

interface ParsedArgs {
  email: string;
  role: "admin" | "agent";
  force: boolean;
}

function fail(message: string, code = 1): never {
  process.stderr.write(`[auth:set-admin-password] ${message}\n`);
  process.exit(code);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = new Map<string, string>();
  const flags = new Set<string>();
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq === -1) {
      flags.add(raw.slice(2));
    } else {
      args.set(raw.slice(2, eq), raw.slice(eq + 1));
    }
  }
  const email = args.get("email");
  if (!email) fail("--email=<address> is required.");
  const roleRaw = args.get("role") ?? "admin";
  if (roleRaw !== "admin" && roleRaw !== "agent") {
    fail("--role must be 'admin' or 'agent' (default: admin).");
  }
  return {
    email: email!,
    role: roleRaw as "admin" | "agent",
    force: flags.has("force"),
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  if (!process.env.DATABASE_URL) {
    fail("DATABASE_URL is required.", 2);
  }
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < 8) {
    fail(
      "ADMIN_PASSWORD env var is required and must be at least 8 characters.",
    );
  }

  let emailLower: string;
  try {
    emailLower = normalizeEmail(parsed.email);
  } catch {
    fail(`Not a valid email address: ${parsed.email}`);
  }

  const pool = getDbPool();
  const client = await pool.connect();
  let userId: string;
  let finalRole = parsed.role;
  let finalStatus = "active";

  try {
    await client.query("BEGIN");

    const existing = await client.query<{
      id: string;
      role: string;
      status: string;
    }>(
      `SELECT id, role, status FROM resupply_auth.users
        WHERE email_lower = $1
        LIMIT 1`,
      [emailLower],
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0]!;
      userId = row.id;
      finalRole = row.role as "admin" | "agent";

      if (row.role !== parsed.role && !parsed.force) {
        await client.query("ROLLBACK");
        fail(
          `User ${emailLower} already exists with role=${row.role}. ` +
            `Re-run with --force to change the role to '${parsed.role}'.`,
        );
      }

      const newRole = parsed.force ? parsed.role : row.role;
      await client.query(
        `UPDATE resupply_auth.users
            SET role = $2,
                status = 'active',
                updated_at = now()
          WHERE id = $1`,
        [userId, newRole],
      );
      finalRole = newRole as "admin" | "agent";
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO resupply_auth.users (email_lower, role, status)
         VALUES ($1, $2, 'active')
         RETURNING id`,
        [emailLower, parsed.role],
      );
      userId = inserted.rows[0]!.id;
    }

    const passwordHash = await hashPassword(password);
    await client.query(
      `INSERT INTO resupply_auth.password_credentials
         (user_id, password_hash, algo, must_change, updated_at)
       VALUES ($1, $2, 'argon2id-v1', false, now())
       ON CONFLICT (user_id) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             algo = EXCLUDED.algo,
             must_change = false,
             updated_at = now()`,
      [userId, passwordHash],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  process.stdout.write(
    `[auth:set-admin-password] Done. user=${userId} email=${emailLower} ` +
      `role=${finalRole} status=${finalStatus}\n`,
  );

  await pool.end();
}

main().catch((err: unknown) => {
  let msg: string;
  if (err instanceof Error) {
    msg = err.stack ?? err.message;
  } else if (err && typeof err === "object") {
    try {
      msg = JSON.stringify(err, null, 2);
    } catch {
      msg = String(err);
    }
  } else {
    msg = String(err);
  }
  process.stderr.write(`[auth:set-admin-password] failed: ${msg}\n`);
  process.exit(1);
});
