// auth:grant-super-admin — make an EXISTING in-house auth user an
// explicit super-admin.
//
// Why this exists (and how it differs from auth:bootstrap-admin)
// -------------------------------------------------------------
// `auth:bootstrap-admin` seeds the COARSE identity only: it writes
// `resupply_auth.users.role` ('admin' | 'agent') and issues a
// set-password link. It never touches `resupply.admin_users`, the
// granular Phase-A RBAC surface that the team console reads.
//
// The effective `super_admin` role (the one that holds
// `system.config.manage` — i.e. access to /admin/system/configuration,
// where ElevenLabs / Deepgram / Stripe / … secrets are entered) is
// resolved from `admin_users.role === 'admin'` via
// `toEffectiveRole()` in lib/resupply-auth/src/rbac.ts. When a user has
// NO admin_users row, `requireAdmin` falls back to the coarse role, so a
// bootstrapped `admin` still reaches super_admin — but only by that
// fallback. That's fragile: the day someone adds an admin_users row for
// them with a lower role (e.g. via the team console), they silently lose
// super_admin.
//
// This script makes the super_admin grant EXPLICIT and durable:
//   1. ensures the coarse `resupply_auth.users.role` is 'admin' (needed
//      to reach the admin surface at all, and to pass the admin-only
//      destructive routes), and
//   2. upserts a `resupply.admin_users` row with role='admin'
//      (→ effective super_admin), status='active', linked to the auth
//      user via auth_user_id.
//
// It is idempotent and side-effect-light: it does NOT reset passwords,
// issue tokens, or send email. Safe to re-run.
//
// Usage:
//   SUPABASE_URL=https://... SUPABASE_SERVICE_ROLE_KEY=... \
//   pnpm --filter @workspace/scripts auth:grant-super-admin \
//     --email=alice@example.com
//
// The auth user must already exist (run auth:bootstrap-admin first to
// create it + set a password). A locked or revoked user is refused
// unless --force.
//
// Exit codes:
//   0 — success
//   1 — invalid args / user not found / db error / unexpected
//   2 — SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set

import {
  normalizeEmail,
  supabaseAuthRepository,
} from "@workspace/resupply-auth";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

interface ParsedArgs {
  email: string;
  force: boolean;
}

function fail(message: string, code = 1): never {
  process.stderr.write(`[auth:grant-super-admin] ${message}\n`);
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
  return { email: email!, force: flags.has("force") };
}

async function main(): Promise<void> {
  const argsParsed = parseArgs(process.argv);

  // Gate on the Supabase service-role creds up front so we exit with the
  // documented code 2 rather than a different error class deeper in.
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.", 2);
  }

  let emailLower: string;
  try {
    emailLower = normalizeEmail(argsParsed.email);
  } catch {
    fail(`Not a valid email address: ${argsParsed.email}`);
  }

  const supabase = getSupabaseServiceRoleClient();
  const repo = supabaseAuthRepository(supabase);

  // 1. The auth user must already exist — this script promotes, it does
  //    not create accounts (no password / token side effects).
  const user = await repo.findUserByEmail(emailLower);
  if (!user) {
    fail(
      `No auth user found for ${emailLower}. Create one first with:\n` +
        `  pnpm --filter @workspace/scripts auth:bootstrap-admin --email=${emailLower} --role=admin`,
    );
  }
  // Sign-in (and requireAdmin) refuse BOTH 'locked' and 'revoked' users
  // — see lib/resupply-auth/src/http/sign-in.ts and
  // middlewares/requireAdmin.ts. Granting the role doesn't clear those
  // statuses, so refuse unless --force, and don't claim the user can
  // sign in below when its status still blocks it.
  const canSignIn = user.status !== "locked" && user.status !== "revoked";
  if (!canSignIn && !argsParsed.force) {
    fail(
      `User ${emailLower} is ${user.status} and cannot sign in. Re-run with ` +
        `--force to grant super-admin anyway (they still won't be able to ` +
        `sign in until it's cleared).`,
    );
  }

  const nowIso = new Date().toISOString();

  // 2. Ensure the COARSE role is 'admin'. super_admin needs the coarse
  //    'admin' both to reach the admin surface and to pass the
  //    admin-only destructive routes (requireAdminOnly). The repo has no
  //    generic role updater, so do a one-off PostgREST update — same
  //    approach as auth-bootstrap-admin.ts.
  let coarseChanged = false;
  if (user.role !== "admin") {
    const { error } = await supabase
      .schema("resupply_auth")
      .from("users")
      .update({ role: "admin", updated_at: nowIso })
      .eq("id", user.id);
    if (error) throw error;
    coarseChanged = true;
  }

  // 3. Ensure the GRANULAR admin_users row → role='admin'
  //    (effective super_admin), active, linked. Find-then-write (rather
  //    than a blind upsert) so we preserve an existing accepted_at and
  //    can report created-vs-updated.
  const { data: existingAdmin, error: findErr } = await supabase
    .schema("resupply")
    .from("admin_users")
    .select("id, role, status, accepted_at, revoked_at")
    .eq("email_lower", emailLower)
    .maybeSingle();
  if (findErr) throw findErr;

  let adminAction: "created" | "updated" | "unchanged";
  if (existingAdmin) {
    const alreadyConsistent =
      existingAdmin.role === "admin" &&
      existingAdmin.status === "active" &&
      existingAdmin.revoked_at === null;
    adminAction = alreadyConsistent ? "unchanged" : "updated";
    const { error } = await supabase
      .schema("resupply")
      .from("admin_users")
      .update({
        role: "admin",
        status: "active",
        auth_user_id: user.id,
        // Clearing the revoke stamps keeps the row from being internally
        // inconsistent (active + revoked_*); backfilling accepted_at when
        // it's missing mirrors the team-invite reactivation flow in
        // routes/admin/team.ts.
        revoked_at: null,
        revoked_by: null,
        accepted_at: existingAdmin.accepted_at ?? nowIso,
        updated_at: nowIso,
      })
      .eq("email_lower", emailLower);
    if (error) throw error;
  } else {
    adminAction = "created";
    const { error } = await supabase
      .schema("resupply")
      .from("admin_users")
      .insert({
        email_lower: emailLower,
        role: "admin",
        status: "active",
        auth_user_id: user.id,
        display_name: user.displayName,
        accepted_at: nowIso,
      });
    if (error) throw error;
  }

  process.stdout.write(
    `\n[auth:grant-super-admin] ${emailLower} is now an explicit super-admin.\n` +
      `  auth.users.role   = admin${coarseChanged ? " (changed from " + user.role + ")" : ""}\n` +
      `  admin_users.role  = admin  (effective: super_admin) [${adminAction}]\n` +
      `  status            = active\n` +
      `  auth_user_id      = ${user.id}\n\n` +
      (canSignIn
        ? `They can now open /admin/system/configuration to enter integration\n` +
          `secrets (ElevenLabs, Deepgram, OpenAI, Anthropic, Stripe, …).\n`
        : `NOTE: the auth account status is '${user.status}', which still\n` +
          `blocks sign-in — clear it before they can open\n` +
          `/admin/system/configuration.\n`),
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[auth:grant-super-admin] failed: ${
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    }\n`,
  );
  process.exit(1);
});
