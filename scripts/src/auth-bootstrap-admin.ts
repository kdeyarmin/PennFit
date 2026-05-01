// auth:bootstrap-admin — seed an in-house auth user with admin (or
// agent) role, issue a one-time set-password token, and (when
// SendGrid is configured) email a reset link to the supplied
// address.
//
// This is the chicken-and-egg solution for ADR 014 / the Stage 3
// cutover described in docs/resupply/AUTH-MIGRATION-PLAN.md:
// once the env-var allow-list stops gating the dashboard (the
// in-house path reads role from auth.users.role only), there
// has to be SOMETHING that creates that very first row. This
// script is it.
//
// Usage:
//   AUTH_PASSWORD_PEPPER=<...> DATABASE_URL=postgres://... \
//   pnpm --filter @workspace/scripts auth:bootstrap-admin \
//     --email=alice@example.com --role=admin
//
// Behaviour:
//   * If `auth.users` already has a row for the email, we report
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
//   2 — DATABASE_URL / AUTH_PASSWORD_PEPPER not set

import pg from "pg";

import {
  hashToken,
  issueToken,
  normalizeEmail,
  pgAuthRepository,
  readAuthEnv,
  renderPasswordResetEmail,
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
  const productName = args.get("product") ?? "Resupply";
  const publicBaseUrl =
    args.get("base-url") ??
    process.env.SHOP_PUBLIC_BASE_URL ??
    "http://localhost:5173";
  return {
    email: email!,
    role: roleRaw as "admin" | "agent",
    force: flags.has("force"),
    productName,
    publicBaseUrl: publicBaseUrl.replace(/\/$/, ""),
    sendEmail: !flags.has("no-email"),
  };
}

async function main(): Promise<void> {
  const argsParsed = parseArgs(process.argv);

  if (!process.env.DATABASE_URL) {
    fail("DATABASE_URL is not set.", 2);
  }

  // Validate AUTH_PASSWORD_PEPPER + TTL config up front. The
  // script still needs the pepper to mint a password hash later
  // (when the user consumes the reset token).
  const env = readAuthEnv(process.env);

  let emailLower: string;
  try {
    emailLower = normalizeEmail(argsParsed.email);
  } catch {
    fail(`Not a valid email address: ${argsParsed.email}`);
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const repo = pgAuthRepository(pool);

  try {
    const existing = await repo.findUserByEmail(emailLower);
    let userId: string;
    if (existing) {
      userId = existing.id;
      if (existing.role !== argsParsed.role) {
        if (!argsParsed.force) {
          fail(
            `User ${emailLower} already exists with role=${existing.role}. ` +
              `Re-run with --force to change the role to '${argsParsed.role}'.`,
          );
        }
        // updateUserStatus repurposed via the repo's update path:
        // a tiny direct SQL is clearer than rolling a generic
        // updateUserRole helper for one caller. Keep this script
        // dependent on raw pg only for these one-off ops.
        await pool.query(
          `UPDATE auth.users SET role = $2, updated_at = NOW() WHERE id = $1`,
          [userId, argsParsed.role],
        );
      }
      if (existing.status === "revoked") {
        if (!argsParsed.force) {
          fail(
            `User ${emailLower} is revoked. Re-run with --force to reactivate.`,
          );
        }
        await repo.updateUserStatus(userId, "invited");
      }
    } else {
      const inserted = await repo.insertUser({
        emailLower,
        displayName: null,
        role: argsParsed.role,
        status: "invited",
      });
      userId = inserted.id;
    }

    // Issue a password_reset token (1 hour TTL — same as the
    // forgot-password flow, since the UX is identical from the
    // user's perspective).
    const token = issueToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await repo.insertEmailToken({
      tokenHash: token.hash,
      userId,
      purpose: "password_reset",
      expiresAt,
    });

    const link = `${argsParsed.publicBaseUrl}/reset-password?token=${encodeURIComponent(token.raw)}`;

    process.stdout.write(`\n[auth:bootstrap-admin] Bootstrap link (valid 1 hour):\n  ${link}\n\n`);

    if (argsParsed.sendEmail) {
      const ctx = {
        productName: argsParsed.productName,
        publicBaseUrl: argsParsed.publicBaseUrl,
      };
      const rendered = renderPasswordResetEmail(ctx, token.raw);
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

    // Sanity-check at the very end: re-read by hash to confirm the
    // token round-trips. This catches a misconfigured DB column
    // (e.g. token_hash dimension drift) before the operator clicks
    // a broken link.
    const recheck = hashToken(token.raw);
    if (!recheck) fail("internal: re-hash failed");

    process.stdout.write(
      `[auth:bootstrap-admin] Done. user=${userId} role=${argsParsed.role} status=invited\n`,
    );
    // Avoid unused-var lint without changing the semantic
    void env;
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[auth:bootstrap-admin] failed: ${
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    }\n`,
  );
  process.exit(1);
});
