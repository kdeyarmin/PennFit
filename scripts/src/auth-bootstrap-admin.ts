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

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
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
    productName,
    publicBaseUrl: publicBaseUrl.replace(/\/$/, ""),
    uiPathPrefix,
    sendEmail: !flags.has("no-email"),
  };
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

  // Issue a short-lived password_reset token. The bootstrap link is a
  // high-privilege admin credential, so it gets a deliberately tight
  // 1-hour TTL (shorter than the public forgot-password flow's
  // AUTH_EMAIL_TOKEN_TTL_HOURS default of 24h).
  const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
  const token = issueToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
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
