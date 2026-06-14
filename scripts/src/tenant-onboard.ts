// tenant:onboard — stand up a NEW tenant (DME company) in one command:
// create the `resupply.organizations` row, create its first admin auth
// user, link that admin to the new tenant, and issue a set-password link.
//
// This is the operator counterpart to the per-tenant storefront-branding /
// custom-domain feature (docs/runbooks/tenant-custom-domain.md): once a
// tenant exists, its admin signs in, sets their storefront name / logo,
// and wires up their domain from Settings → Storefront branding.
//
// It composes the two existing single-purpose scripts:
//   * auth:bootstrap-admin — creates the auth user + set-password link.
//   * auth:grant-super-admin — upserts the granular admin_users row.
// …and adds the missing piece: creating the `organizations` row and
// stamping the new admin's `admin_users.org_id` so requireAdmin resolves
// them to the right tenant (it reads admin_users.org_id by auth_user_id).
//
// Usage:
//   SUPABASE_URL=https://... SUPABASE_SERVICE_ROLE_KEY=... \
//   pnpm --filter @workspace/scripts tenant:onboard \
//     --org-slug=acme-dme --org-name="ACME DME Inc." \
//     --admin-email=alice@acme.example [--storefront-name="AcmeSleep"]
//
// Idempotent & safe to re-run:
//   * Organization: reused when the slug already exists (reported), else
//     created. The slug is the stable tenant key.
//   * Auth user: created when absent (role=admin, status=invited) with a
//     1-hour set-password link printed + emailed (when SendGrid is set).
//     An EXISTING auth user is only re-issued a link with --force (the
//     link is an account-takeover credential), and a coarse role change
//     also requires --force.
//   * admin_users: upserted with org_id linkage. If the admin already
//     belongs to a DIFFERENT org, the script REFUSES unless --force, so a
//     re-run can never silently move an admin between tenants.
//
// Exit codes:
//   0 — success
//   1 — invalid args / db error / unexpected
//   2 — SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set

import {
  issueToken,
  normalizeEmail,
  renderTeamInviteEmail,
  supabaseAuthRepository,
} from "@workspace/resupply-auth";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";

interface ParsedArgs {
  orgSlug: string;
  orgName: string;
  adminEmail: string;
  storefrontName: string | null;
  status: "active" | "suspended" | "archived";
  force: boolean;
  sendEmail: boolean;
  productName: string;
  publicBaseUrl: string;
  uiPathPrefix: string;
}

// Mirrors the DB CHECK on organizations.slug
// (0331_organizations_tenant.sql): a URL-safe lowercase label.
const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function fail(message: string, code = 1): never {
  process.stderr.write(`[tenant:onboard] ${message}\n`);
  process.exit(code);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = new Map<string, string>();
  const flags = new Set<string>();
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq === -1) flags.add(raw.slice(2));
    else args.set(raw.slice(2, eq), raw.slice(eq + 1));
  }

  const orgSlug = (args.get("org-slug") ?? "").trim().toLowerCase();
  if (!orgSlug) fail("--org-slug=<slug> is required.");
  if (orgSlug.length > 63 || !SLUG_RE.test(orgSlug)) {
    fail(
      `--org-slug must be a URL-safe lowercase label (a-z, 0-9, hyphens; ` +
        `no leading/trailing hyphen; ≤ 63 chars). Got: '${orgSlug}'.`,
    );
  }

  const orgName = (args.get("org-name") ?? "").trim();
  if (!orgName) fail("--org-name=<legal name> is required.");

  const adminEmail = args.get("admin-email");
  if (!adminEmail) fail("--admin-email=<address> is required.");

  const statusRaw = args.get("status") ?? "active";
  if (
    statusRaw !== "active" &&
    statusRaw !== "suspended" &&
    statusRaw !== "archived"
  ) {
    fail("--status must be 'active', 'suspended', or 'archived'.");
  }

  const storefrontName = (args.get("storefront-name") ?? "").trim() || null;
  const productName = args.get("product") ?? storefrontName ?? orgName;
  const publicBaseUrl = (
    args.get("base-url") ??
    process.env.SHOP_PUBLIC_BASE_URL ??
    "http://localhost:5173"
  ).replace(/\/$/, "");
  const uiPathPrefix = (args.get("ui-path-prefix") ?? "/admin").replace(
    /\/+$/,
    "",
  );

  return {
    orgSlug,
    orgName,
    adminEmail,
    storefrontName,
    status: statusRaw,
    force: flags.has("force"),
    sendEmail: !flags.has("no-email"),
    productName,
    publicBaseUrl,
    uiPathPrefix,
  };
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv);

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.", 2);
  }

  let emailLower: string;
  try {
    emailLower = normalizeEmail(a.adminEmail);
  } catch {
    fail(`Not a valid email address: ${a.adminEmail}`);
  }

  const supabase = getSupabaseServiceRoleClient();
  const repo = supabaseAuthRepository(supabase);
  const nowIso = new Date().toISOString();

  // ── 1. Organization: reuse by slug, else create. ──────────────────
  const { data: existingOrg, error: orgFindErr } = await supabase
    .schema("resupply")
    .from("organizations")
    .select("id, name, status")
    .eq("slug", a.orgSlug)
    .maybeSingle();
  if (orgFindErr) throw orgFindErr;

  let orgId: string;
  let orgAction: "created" | "existing";
  if (existingOrg) {
    orgId = existingOrg.id;
    orgAction = "existing";
  } else {
    const { data: created, error: orgInsErr } = await supabase
      .schema("resupply")
      .from("organizations")
      .insert({
        slug: a.orgSlug,
        name: a.orgName,
        status: a.status,
        storefront_name: a.storefrontName,
      })
      .select("id")
      .single();
    if (orgInsErr) throw orgInsErr;
    orgId = created.id;
    orgAction = "created";
  }

  // ── 2. Auth user: create (with set-password link) or reuse. ────────
  const existingUser = await repo.findUserByEmail(emailLower);
  let userId: string;
  let userAction: "created" | "reused";
  let issuedLink: string | null = null;

  if (!existingUser) {
    const inserted = await repo.insertUser({
      emailLower,
      displayName: null,
      role: "admin",
      status: "invited",
    });
    userId = inserted.id;
    userAction = "created";
  } else {
    userId = existingUser.id;
    userAction = "reused";
    if (existingUser.role !== "admin") {
      if (!a.force) {
        fail(
          `Auth user ${emailLower} exists with role='${existingUser.role}'. ` +
            `Re-run with --force to promote them to 'admin'.`,
        );
      }
      const { error } = await supabase
        .schema("resupply_auth")
        .from("users")
        .update({ role: "admin", updated_at: nowIso })
        .eq("id", userId);
      if (error) throw error;
    }
  }

  // Issue a fresh set-password link for a brand-new user, or for an
  // existing one only with --force (the link is an account-takeover
  // credential — never re-mint it silently for an existing admin).
  if (userAction === "created" || a.force) {
    const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
    const token = issueToken();
    await repo.insertEmailToken({
      tokenHash: token.hash,
      userId,
      purpose: "password_reset",
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    });
    issuedLink = `${a.publicBaseUrl}${a.uiPathPrefix}/reset-password?token=${encodeURIComponent(
      token.raw,
    )}`;

    if (a.sendEmail) {
      const rendered = renderTeamInviteEmail(
        {
          productName: a.productName,
          signatureName: a.orgName,
          publicBaseUrl: a.publicBaseUrl,
          uiPathPrefix: a.uiPathPrefix,
        },
        {
          rawToken: token.raw,
          ttlMs: RESET_TOKEN_TTL_MS,
          email: emailLower,
          displayName: null,
          roleLabel: "Super admin",
        },
      );
      try {
        const client = createSendgridClient();
        await client.sendEmail({
          to: a.adminEmail,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        });
        process.stdout.write(
          `[tenant:onboard] Email sent to ${a.adminEmail}.\n`,
        );
      } catch (err) {
        if (err instanceof EmailConfigError) {
          process.stdout.write(
            `[tenant:onboard] SendGrid not configured (${err.message}). Use the link below.\n`,
          );
        } else {
          process.stderr.write(
            `[tenant:onboard] Email send failed: ${
              err instanceof Error ? err.message : "unknown"
            }\n  Use the link below to finish onboarding.\n`,
          );
        }
      }
    }
  }

  // ── 3. admin_users: link the admin to THIS tenant. ─────────────────
  const { data: existingAdmin, error: adminFindErr } = await supabase
    .schema("resupply")
    .from("admin_users")
    .select("id, role, status, accepted_at, org_id")
    .eq("email_lower", emailLower)
    .maybeSingle();
  if (adminFindErr) throw adminFindErr;

  let adminAction: "created" | "updated";
  if (existingAdmin) {
    // Guard: never silently move an admin who already belongs to a
    // different tenant. Onboarding into the wrong org is the scariest
    // failure mode here, so require an explicit --force.
    if (existingAdmin.org_id && existingAdmin.org_id !== orgId && !a.force) {
      fail(
        `Admin ${emailLower} already belongs to a different organization ` +
          `(org_id=${existingAdmin.org_id}). Re-run with --force to move ` +
          `them to '${a.orgSlug}'.`,
      );
    }
    adminAction = "updated";
    const { error } = await supabase
      .schema("resupply")
      .from("admin_users")
      .update({
        role: "admin",
        status: "active",
        auth_user_id: userId,
        org_id: orgId,
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
        auth_user_id: userId,
        org_id: orgId,
        display_name: existingUser?.displayName ?? null,
        accepted_at: nowIso,
      });
    if (error) throw error;
  }

  // ── Summary. ───────────────────────────────────────────────────────
  process.stdout.write(
    `\n[tenant:onboard] Tenant '${a.orgSlug}' ready.\n` +
      `  organization      = ${a.orgName} (${orgAction}) org_id=${orgId} status=${a.status}\n` +
      `  storefront_name   = ${a.storefrontName ?? "(falls back to name)"}\n` +
      `  admin auth user   = ${emailLower} (${userAction}) role=admin\n` +
      `  admin_users row   = role=admin status=active org_id=${orgId} [${adminAction}]\n`,
  );
  if (issuedLink) {
    process.stdout.write(
      `\n[tenant:onboard] Set-password link for ${emailLower} (valid 1 hour):\n  ${issuedLink}\n`,
    );
  } else {
    process.stdout.write(
      `\n[tenant:onboard] No new set-password link issued (existing user; ` +
        `pass --force to re-issue one).\n`,
    );
  }
  process.stdout.write(
    `\nNext: the admin signs in at ${a.publicBaseUrl}${a.uiPathPrefix}/sign-in, then\n` +
      `opens Settings → Storefront branding to set their name / logo and wire\n` +
      `up a custom domain (docs/runbooks/tenant-custom-domain.md).\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[tenant:onboard] failed: ${
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    }\n`,
  );
  process.exit(1);
});
