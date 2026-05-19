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
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=... \
//   ADMIN_PASSWORD='…' \
//   pnpm --filter @workspace/scripts auth:set-admin-password \
//     --email=alice@example.com --role=admin
//
// The password is read from the ADMIN_PASSWORD env var rather than
// an argv flag so it does NOT appear in `ps`, shell history, or
// process listings. The script never prints the password or its
// hash to stdout/stderr.
//
// Behaviour:
//   * Creates the user if absent. If present, sets status to
//     'active' so sign-in is immediately allowed.
//   * Updates role when --force is passed and the role differs.
//   * Always upserts the password credential — running the script
//     twice rotates the password to the new value.
//   * Exit codes: 0 ok, 1 usage/db error, 2 supabase env not set.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  hashPassword,
  normalizeEmail,
  supabaseAuthRepository,
} from "@workspace/resupply-auth";

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

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.", 2);
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

  const supabase = getSupabaseServiceRoleClient();
  const repo = supabaseAuthRepository(supabase);

  const existing = await repo.findUserByEmail(emailLower);
  let userId: string;
  let finalRole = parsed.role;

  if (existing) {
    userId = existing.id;
    finalRole = existing.role as "admin" | "agent";

    if (existing.role !== parsed.role && !parsed.force) {
      fail(
        `User ${emailLower} already exists with role=${existing.role}. ` +
          `Re-run with --force to change the role to '${parsed.role}'.`,
      );
    }

    const newRole = parsed.force ? parsed.role : existing.role;
    const { error: updateErr } = await supabase
      .schema("resupply_auth")
      .from("users")
      .update({
        role: newRole,
        status: "active",
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId);
    if (updateErr) throw updateErr;
    finalRole = newRole as "admin" | "agent";
  } else {
    const { data: insertedRow, error: insertErr } = await supabase
      .schema("resupply_auth")
      .from("users")
      .insert({
        email_lower: emailLower,
        role: parsed.role,
        status: "active",
      })
      .select("id")
      .single<{ id: string }>();
    if (insertErr) throw insertErr;
    userId = insertedRow.id;
  }

  const passwordHash = await hashPassword(password);
  await repo.upsertCredential({
    userId,
    passwordHash,
    mustChange: false,
  });

  process.stdout.write(
    `[auth:set-admin-password] Done. user=${userId} email=${emailLower} ` +
      `role=${finalRole} status=active\n`,
  );
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
