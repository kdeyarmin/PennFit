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
//   * Ensures a tenant-bound `admin_users` row (seed org) so
//     requireAdmin can resolve org_id under its fail-closed gate —
//     the e2e CI seed path uses this script, not bootstrap-admin.
//     Linking is REQUIRED: a failure exits non-zero so operators are
//     never told recovery succeeded while requireAdmin would 403.
//   * Exit codes: 0 ok, 1 usage/db error, 2 supabase env not set.

import {
  getSupabaseServiceRoleClient,
  resolveSeedOrgId,
} from "@workspace/resupply-db";
import {
  hashPassword,
  normalizeEmail,
  supabaseAuthRepository,
  writeUserChosenPassword,
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
  // CLI is an out-of-band recovery tool — not the team-invite
  // "set their password for them" flow — so the operator-set
  // expiry clock shouldn't fire. writeUserChosenPassword clears
  // set_by_admin_at explicitly in case this user previously had
  // an expired admin-typed credential.
  await writeUserChosenPassword(repo, {
    userId,
    passwordHash,
    mustChange: false,
  });

  // Ensure a tenant-bound admin_users row exists so requireAdmin can resolve
  // this admin's org under the fail-closed gate (missing / NULL org_id →
  // 403 tenant_context_missing). Bind to the seed org for this recovery /
  // e2e seed path; never clobber an existing non-NULL org_id. REQUIRED —
  // a link failure must not report success while the account remains
  // unusable behind requireAdmin.
  const seedOrgId = await resolveSeedOrgId();
  if (!seedOrgId) {
    throw new Error(
      "could not resolve seed org for admin_users linkage; requireAdmin would reject this session",
    );
  }
  const { data: existingAdminRow, error: findErr } = await supabase
    .schema("resupply")
    .from("admin_users")
    .select("id, org_id, auth_user_id, role, status")
    .eq("email_lower", emailLower)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!existingAdminRow) {
    const { error: insertErr } = await supabase
      .schema("resupply")
      .from("admin_users")
      .insert({
        email_lower: emailLower,
        role: finalRole,
        status: "active",
        auth_user_id: userId,
        org_id: seedOrgId,
        accepted_at: new Date().toISOString(),
      });
    if (insertErr) throw insertErr;
  } else if (!existingAdminRow.org_id || !existingAdminRow.auth_user_id) {
    const { error: updateErr } = await supabase
      .schema("resupply")
      .from("admin_users")
      .update({
        org_id: existingAdminRow.org_id ?? seedOrgId,
        auth_user_id: existingAdminRow.auth_user_id ?? userId,
        updated_at: new Date().toISOString(),
      })
      .eq("email_lower", emailLower);
    if (updateErr) throw updateErr;
  }

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
