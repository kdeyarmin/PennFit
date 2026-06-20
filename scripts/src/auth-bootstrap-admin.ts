// auth:bootstrap-admin — seed an in-house auth user with admin (or
// agent) role, issue a one-time set-password token, and (when
// SendGrid is configured) email a welcome / account-setup link to
// the supplied address.
//
// This is the chicken-and-egg solution for ADR 014 / the Stage 3
// cutover described in docs/resupply/AUTH-MIGRATION-PLAN.md:
// once the env-var allow-list stops gating the dashboard (the
// in-house path reads role from resupply_auth.users.role only), there
// has to be SOMETHING that creates that very first row. This
// script is it.
//
// Usage:
//   SUPABASE_URL=https://... SUPABASE_SERVICE_ROLE_KEY=... \
//   pnpm --filter @workspace/scripts auth:bootstrap-admin \
//     --email=alice@example.com --role=admin
//
// Bootstrapping the FIRST platform super-admin in a fresh environment:
//   add --platform-admin to also grant the platform tier
//   (resupply.platform_admins, migration 0355) at account-creation time:
//
//   pnpm --filter @workspace/scripts auth:bootstrap-admin \
//     --email=owner@example.com --role=admin --platform-admin
//
//   This is the order-correct home for the platform grant: a one-shot
//   data migration that grants by email (e.g. 0383) runs once and is a
//   no-op if the account doesn't exist YET — so it can't grant an admin
//   who is bootstrapped later. Doing it here, where the user row is
//   guaranteed to exist, closes that gap.
//
// Behaviour:
//   * If `resupply_auth.users` already has a row for the email, we report
//     the current role + status and (with --force) update the
//     role to the requested value. We NEVER silently rewrite an
//     existing user's role without --force.
//   * A `password_reset` email-token is issued with a 1-hour TTL.
//     The raw token is printed to stdout AND emailed when
//     SENDGRID_API_KEY + SENDGRID_FROM_EMAIL are set. If SendGrid
//     isn't configured, the printed link is the only delivery
//     path — copy it to the new admin yourself.
//   * Audit-log entry: `auth.bootstrap_admin` with the actor
//     email + chosen role.
//
// Exit codes:
//   0 — success
//   1 — invalid args / db error / unexpected
//   2 — SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set

import {
  getSupabaseServiceRoleClient,
  resolveSeedOrgId,
} from "@workspace/resupply-db";
import {
  hashToken,
  issueToken,
  normalizeEmail,
  readAuthEnv,
  renderTeamInviteEmail,
  supabaseAuthRepository,
} from "@workspace/resupply-auth";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";

interface ParsedArgs {
  email: string;
  role: "admin" | "agent";
  force: boolean;
  platformAdmin: boolean;
  productName: string;
  publicBaseUrl: string;
  uiPathPrefix: string;
  sendEmail: boolean;
}

function fail(message: string, code = 1): never {
  process.stderr.write(`[auth:bootstrap-admin] ${message}\n`);
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
  const platformAdmin = flags.has("platform-admin");
  if (platformAdmin && roleRaw !== "admin") {
    fail(
      "--platform-admin requires --role=admin (the platform tier is admin-only).",
    );
  }
  const productName = args.get("product") ?? "PennPaps";
  const publicBaseUrl =
    args.get("base-url") ??
    process.env.SHOP_PUBLIC_BASE_URL ??
    "http://localhost:5173";
  // Admins land on the /admin SPA pages by default. Pass
  // --ui-path-prefix= (empty) to mint a customer-facing link
  // (e.g. when bootstrapping a customer-role row for testing).
  const uiPathPrefix = (args.get("ui-path-prefix") ?? "/admin").replace(
    /\/+$/,
    "",
  );
  return {
    email: email!,
    role: roleRaw as "admin" | "agent",
    force: flags.has("force"),
    platformAdmin,
    productName,
    publicBaseUrl: publicBaseUrl.replace(/\/$/, ""),
    uiPathPrefix,
    sendEmail: !flags.has("no-email"),
  };
}

/**
 * Idempotently grant the PLATFORM super-admin tier
 * (resupply.platform_admins, migration 0355) to an existing auth user.
 * `ignoreDuplicates` makes a re-run a no-op, so the log says "Ensured"
 * (not "Granted") — the row is present afterward either way.
 */
async function grantPlatformAdmin(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  userId: string,
  emailLower: string,
): Promise<void> {
  const { error } = await supabase
    .schema("resupply")
    .from("platform_admins")
    .upsert(
      { auth_user_id: userId, granted_by_email: "auth:bootstrap-admin" },
      { onConflict: "auth_user_id", ignoreDuplicates: true },
    );
  if (error) throw error;
  process.stdout.write(
    `[auth:bootstrap-admin] Ensured platform super-admin for ${emailLower}.\n`,
  );
}

async function main(): Promise<void> {
  const argsParsed = parseArgs(process.argv);

  // Supabase service-role access is the production data path; the
  // service-role JWT covers every schema this script touches. We
  // gate on both vars up front so the script exits with code 2 (the
  // documented "env not set" code) rather than relying on the
  // resupply-db client's own check, which surfaces a different
  // error class.
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.", 2);
  }

  // The previous version of this script forced the env reader
  // into "in_house" because the env reader required the password
  // pepper. The pepper was removed in the Task #38 follow-up so
  // the AUTH_PROVIDER override is no longer load-bearing — the
  // env reader only validates the optional TTL knobs now.
  const env = readAuthEnv(process.env);

  let emailLower: string;
  try {
    emailLower = normalizeEmail(argsParsed.email);
  } catch {
    fail(`Not a valid email address: ${argsParsed.email}`);
  }

  const supabase = getSupabaseServiceRoleClient();
  const repo = supabaseAuthRepository(supabase);

  const existing = await repo.findUserByEmail(emailLower);
  let userId: string;
  let finalStatus: string;
  if (existing) {
    userId = existing.id;
    finalStatus = existing.status;
    if (existing.role !== argsParsed.role) {
      if (!argsParsed.force) {
        fail(
          `User ${emailLower} already exists with role=${existing.role}. ` +
            `Re-run with --force to change the role to '${argsParsed.role}'.`,
        );
      }
      // The repo doesn't expose a generic updateUserRole; a one-off
      // PostgREST UPDATE is clearer than adding a one-caller helper.
      const { error } = await supabase
        .schema("resupply_auth")
        .from("users")
        .update({
          role: argsParsed.role,
          updated_at: new Date().toISOString(),
        })
        .eq("id", userId);
      if (error) throw error;
    } else if (!argsParsed.force) {
      // Existing user, same role, not revoked — re-running this
      // command would otherwise silently issue a fresh
      // password_reset link (below) and hand whoever ran it an
      // account-takeover link for an existing admin without any
      // explicit confirmation. Refuse unless --force is supplied so
      // the operation is intentional.
      //
      // EXCEPTION: a bare `--platform-admin` invocation for an already-
      // active admin just wants to grant the platform tier — that needs
      // no new password link, so grant it idempotently and exit cleanly
      // without touching credentials. (Without this, granting an admin
      // bootstrapped before this flag would require --force, which DOES
      // reset their password — the case Codex flagged.) A revoked user
      // still falls through to the refusal so the operator clears that
      // with --force first.
      if (argsParsed.platformAdmin && existing.status !== "revoked") {
        await grantPlatformAdmin(supabase, userId, emailLower);
        process.stdout.write(
          `[auth:bootstrap-admin] Done. user=${userId} already exists ` +
            `(role=${argsParsed.role}, status=${existing.status}); no ` +
            `password link issued.\n`,
        );
        return;
      }
      fail(
        `User ${emailLower} already exists with role=${argsParsed.role} and ` +
          `status=${existing.status}. Re-running would issue a new ` +
          `password-reset link, effectively resetting this admin's password. ` +
          `Re-run with --force if that's intended.`,
      );
    }
    if (existing.status === "revoked") {
      if (!argsParsed.force) {
        fail(
          `User ${emailLower} is revoked. Re-run with --force to reactivate.`,
        );
      }
      await repo.updateUserStatus(userId, "invited");
      finalStatus = "invited";
    }
  } else {
    const inserted = await repo.insertUser({
      emailLower,
      displayName: null,
      role: argsParsed.role,
      status: "invited",
    });
    userId = inserted.id;
    finalStatus = inserted.status;
  }

  // Grant the PLATFORM super-admin tier when requested. This is the
  // order-correct home for the grant: the auth user row is guaranteed to
  // exist by this point (we just created it, or found it on a --force
  // role-change / reactivation path), so unlike a one-shot data migration
  // it can never run "too early" in a brand-new environment. The
  // same-role no-force path is handled earlier (it grants and returns
  // without issuing a password link).
  if (argsParsed.platformAdmin) {
    await grantPlatformAdmin(supabase, userId, emailLower);
  }

  // Ensure a tenant-bound admin_users row exists so requireAdmin can resolve
  // this admin's org under the fail-closed gate (a present-but-NULL org_id is
  // rejected). Bootstrap admins are the seed/platform admin → bind to the seed
  // org. BEST-EFFORT: a failure here must NOT abort the bootstrap — the auth
  // user + reset link are the critical output, and requireAdmin still resolves
  // a row-less admin to the seed org — so log and continue. Never clobbers an
  // existing row's role/status.
  try {
    const seedOrgId = await resolveSeedOrgId();
    if (seedOrgId) {
      const { data: existingAdminRow, error: findErr } = await supabase
        .schema("resupply")
        .from("admin_users")
        .select("id, org_id, auth_user_id")
        .eq("email_lower", emailLower)
        .maybeSingle();
      // supabase-js returns { error } rather than throwing, so surface it
      // explicitly to reach the catch (otherwise a failed read looks like
      // "no row" and the link silently skips).
      if (findErr) throw findErr;
      if (!existingAdminRow) {
        const { error: insertErr } = await supabase
          .schema("resupply")
          .from("admin_users")
          .insert({
            email_lower: emailLower,
            role: argsParsed.role,
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
    }
  } catch (err) {
    process.stderr.write(
      `[auth:bootstrap-admin] warning: could not link admin_users row ` +
        `(${err instanceof Error ? err.message : String(err)}); the admin ` +
        `still resolves to the seed org via the row-less fallback.\n`,
    );
  }

  // Issue a short-lived password_reset token. The bootstrap link is a
  // high-privilege admin credential, so it gets a deliberately tight
  // 1-hour TTL (shorter than the public forgot-password flow's
  // AUTH_EMAIL_TOKEN_TTL_HOURS default of 24h).
  const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
  const token = issueToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  // Re-running the bootstrap must not leave earlier links valid.
  await repo.expireUnconsumedEmailTokens({
    userId,
    purpose: "password_reset",
    at: new Date(),
  });
  await repo.insertEmailToken({
    tokenHash: token.hash,
    userId,
    purpose: "password_reset",
    expiresAt,
  });

  const link = `${argsParsed.publicBaseUrl}${argsParsed.uiPathPrefix}/reset-password?token=${encodeURIComponent(token.raw)}`;

  process.stdout.write(
    `\n[auth:bootstrap-admin] Bootstrap link (valid 1 hour):\n  ${link}\n\n`,
  );

  if (argsParsed.sendEmail) {
    const ctx = {
      productName: argsParsed.productName,
      signatureName: "Penn Home Medical Supply",
      publicBaseUrl: argsParsed.publicBaseUrl,
      uiPathPrefix: argsParsed.uiPathPrefix,
    };
    // Welcome / account-setup email, not the password-reset template:
    // this account has never had a password, and "we received a request
    // to reset your password" would be the wrong message to bootstrap
    // the very first admin with. Expiry copy derives from the 1h TTL.
    const rendered = renderTeamInviteEmail(ctx, {
      rawToken: token.raw,
      ttlMs: RESET_TOKEN_TTL_MS,
      email: emailLower,
      displayName: null,
      roleLabel:
        argsParsed.role === "admin" ? "Super admin" : "Customer service rep",
    });
    try {
      const client = createSendgridClient();
      await client.sendEmail({
        to: argsParsed.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      process.stdout.write(
        `[auth:bootstrap-admin] Email sent to ${argsParsed.email}.\n`,
      );
    } catch (err) {
      if (err instanceof EmailConfigError) {
        process.stdout.write(
          `[auth:bootstrap-admin] SendGrid not configured (${err.message}). Use the link above.\n`,
        );
      } else {
        process.stderr.write(
          `[auth:bootstrap-admin] Email send failed: ${err instanceof Error ? err.message : "unknown"}\n` +
            "Use the link above to complete bootstrap.\n",
        );
      }
    }
  }

  // Sanity-check that the token-hash derivation is reproducible
  // before we hand the raw token to the operator. This is purely an
  // in-memory check (`hashToken` is deterministic), so a real DB
  // column-drift bug would NOT surface here — the failure would
  // appear at consume time when the user clicks the link. The check
  // catches the narrow case of `hashToken` itself being misbuilt
  // (e.g. an empty buffer return), which has bitten us once before.
  const recheck = hashToken(token.raw);
  if (!recheck) fail("internal: re-hash failed");

  process.stdout.write(
    `[auth:bootstrap-admin] Done. user=${userId} role=${argsParsed.role} status=${finalStatus}\n`,
  );
  // Avoid unused-var lint without changing the semantic
  void env;
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[auth:bootstrap-admin] failed: ${
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    }\n`,
  );
  process.exit(1);
});
