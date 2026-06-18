// Self-serve tenant provisioning for the public Breathe "create your
// account" flow. Composes the SAME battle-tested primitives the
// operator CLI (`tenant:onboard`) and the platform tenant API use, so a
// new DME can create their organization + first admin login themselves:
//
//   1. organizations row (slug unique)               — resupply schema
//   2. feature_flags copied from the seed tenant      — resupply schema
//   3. auth user (role=admin, status=invited) + their chosen password
//   4. email-verification token + verification email  — resupply_auth
//   5. admin_users row linking the admin to the org   — resupply schema
//
// Security posture:
//   * The admin cannot reach the console until they VERIFY their email
//     (the auth user stays status='invited'; sign-in gates on verified).
//   * Password policy (>=12 chars) is enforced at the route Zod boundary
//     and re-checked here.
//   * Already-verified email → rejected ("sign in instead") rather than
//     silently moving an existing admin between orgs.
//   * Global tables are written through the seed-org chokepoint
//     (getOrgScopedClient(seed).raw()) — never a direct service-role
//     acquisition (tenant-isolation guard).
//   * The route in front of this adds the honeypot, per-IP rate limit,
//     and optional Turnstile. PHI/PII: the email + password are never
//     logged; failures log only a shape.

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";
import {
  hashPassword,
  issueToken,
  normalizeEmail,
  renderVerifyEmail,
  writeUserChosenPassword,
  type AuthEmailContext,
} from "@workspace/resupply-auth";

import { getAuthDeps } from "./auth-deps.js";
import { logger } from "./logger.js";

const PRODUCT_NAME = "CareMetric Breathe";
// New tenants verify + sign in on the platform's admin surface; the
// admin console resolves them to their own org via admin_users.org_id,
// so a custom subdomain is a nicety, not a requirement, for access.
const UI_PATH_PREFIX = "/admin";

export type SelfServeSignupInput = {
  orgName: string;
  slug: string;
  adminEmail: string;
  password: string;
};

export type SelfServeSignupFailure =
  | "weak_password"
  | "invalid_email"
  | "slug_taken"
  | "email_taken"
  | "unavailable";

export type SelfServeSignupResult =
  | { ok: true; slug: string; signInUrl: string }
  | { ok: false; reason: SelfServeSignupFailure; message: string };

/** Turn a free-text organization name into a URL-safe slug. */
export function slugifyOrgName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

type RawClient = ReturnType<ReturnType<typeof getOrgScopedClient>["raw"]>;

/** Copy the seed tenant's feature-flag catalog onto the new org. */
async function provisionFeatureFlags(
  raw: RawClient,
  seedOrgId: string,
  newOrgId: string,
): Promise<number> {
  const { data: seedFlags, error } = await raw
    .schema("resupply")
    .from("feature_flags")
    .select("key, enabled, description, category")
    .eq("org_id", seedOrgId);
  if (error) throw error;
  const rows = (seedFlags ?? []).map((f) => ({
    org_id: newOrgId,
    key: (f as { key: string }).key,
    enabled: (f as { enabled: boolean }).enabled,
    description: (f as { description: string | null }).description,
    category: (f as { category: string | null }).category,
  }));
  if (rows.length === 0) return 0;
  const { error: insErr } = await raw
    .schema("resupply")
    .from("feature_flags")
    .upsert(rows, { onConflict: "org_id,key", ignoreDuplicates: true });
  if (insErr) throw insErr;
  return rows.length;
}

export async function createSelfServeTenant(
  input: SelfServeSignupInput,
): Promise<SelfServeSignupResult> {
  const deps = getAuthDeps();

  // Password policy mirrors the auth lib (length beats complexity:
  // >= 12 chars). The route also enforces this at the Zod boundary; the
  // guard here keeps the service safe for any other caller.
  if (input.password.length < 12 || input.password.length > 1024) {
    return {
      ok: false,
      reason: "weak_password",
      message: "Password must be at least 12 characters.",
    };
  }

  let emailLower: string;
  try {
    emailLower = normalizeEmail(input.adminEmail);
  } catch {
    return {
      ok: false,
      reason: "invalid_email",
      message: "Please enter a valid email address.",
    };
  }

  const seedOrgId = await resolveSeedOrgId();
  if (!seedOrgId) {
    logger.error(
      { event: "tenant_signup_no_seed_org" },
      "tenant signup: seed org unresolved",
    );
    return {
      ok: false,
      reason: "unavailable",
      message: "Signup is temporarily unavailable. Please try again shortly.",
    };
  }
  const raw = getOrgScopedClient(seedOrgId).raw();

  // 1. Reject an already-verified account before creating anything, so a
  //    bounced signup never leaves an orphan org behind.
  const existing = await deps.repo.findUserByEmail(emailLower);
  if (existing && existing.emailVerifiedAt) {
    return {
      ok: false,
      reason: "email_taken",
      message: "An account with this email already exists. Sign in instead.",
    };
  }

  // 2. Create the organization. The unique slug index turns a duplicate
  //    into a 23505 we surface as a friendly "name taken".
  const { data: created, error: insErr } = await raw
    .schema("resupply")
    .from("organizations")
    .insert({
      slug: input.slug,
      name: input.orgName,
      storefront_name: input.orgName,
    })
    .select("id, slug")
    .limit(1)
    .maybeSingle();
  if (insErr) {
    if ((insErr as { code?: string }).code === "23505") {
      return {
        ok: false,
        reason: "slug_taken",
        message: "That workspace address is already taken. Try another name.",
      };
    }
    logger.error(
      {
        event: "tenant_signup_org_create_failed",
        pgCode: (insErr as { code?: string }).code ?? null,
      },
      "tenant signup: org create failed",
    );
    return {
      ok: false,
      reason: "unavailable",
      message: "Could not create your workspace. Please try again.",
    };
  }
  if (!created) {
    return {
      ok: false,
      reason: "unavailable",
      message: "Could not create your workspace. Please try again.",
    };
  }
  const orgId = (created as { id: string }).id;

  // 3. Feature flags — best-effort (the operator can re-provision).
  try {
    await provisionFeatureFlags(raw, seedOrgId, orgId);
  } catch (err) {
    logger.warn(
      { event: "tenant_signup_flag_provision_failed", orgId, err },
      "tenant signup: feature-flag provisioning failed",
    );
  }

  // 4. Auth user: create, or re-attach an unverified prior attempt, then
  //    persist the password they just chose.
  let userId: string;
  if (existing) {
    userId = existing.id;
  } else {
    const inserted = await deps.repo.insertUser({
      emailLower,
      displayName: input.orgName,
      role: "admin",
      status: "invited",
    });
    userId = inserted.id;
  }
  const passwordHash = await hashPassword(
    input.password,
    deps.passwordHashParams,
  );
  await writeUserChosenPassword(deps.repo, {
    userId,
    passwordHash,
    mustChange: false,
  });

  // 5. Verification token + email. Only the most recent link stays valid.
  const ttlMs = deps.env.emailTokenTtlHours * 60 * 60 * 1000;
  const token = issueToken();
  await deps.repo.expireUnconsumedEmailTokens({
    userId,
    purpose: "signup_verify",
    at: new Date(),
  });
  await deps.repo.insertEmailToken({
    tokenHash: token.hash,
    userId,
    purpose: "signup_verify",
    expiresAt: new Date(Date.now() + ttlMs),
  });
  const ctx: AuthEmailContext = {
    productName: PRODUCT_NAME,
    signatureName: PRODUCT_NAME,
    publicBaseUrl: deps.publicBaseUrl,
    uiPathPrefix: UI_PATH_PREFIX,
  };
  const rendered = renderVerifyEmail(ctx, token.raw, ttlMs);
  try {
    await deps.email({
      to: input.adminEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
  } catch {
    // Swallow — a SendGrid blip must not fail signup; the user can
    // re-request verification via /admin/forgot-password.
  }

  // 6. Link admin_users to THIS org (active, admin).
  const nowIso = new Date().toISOString();
  const { data: existingAdmin } = await raw
    .schema("resupply")
    .from("admin_users")
    .select("id, accepted_at")
    .eq("email_lower", emailLower)
    .maybeSingle();
  const adminErr = existingAdmin
    ? (
        await raw
          .schema("resupply")
          .from("admin_users")
          .update({
            role: "admin",
            status: "active",
            auth_user_id: userId,
            org_id: orgId,
            revoked_at: null,
            revoked_by: null,
            accepted_at:
              (existingAdmin as { accepted_at: string | null }).accepted_at ??
              nowIso,
            updated_at: nowIso,
          })
          .eq("email_lower", emailLower)
      ).error
    : (
        await raw.schema("resupply").from("admin_users").insert({
          email_lower: emailLower,
          role: "admin",
          status: "active",
          auth_user_id: userId,
          org_id: orgId,
          display_name: input.orgName,
          accepted_at: nowIso,
        })
      ).error;
  if (adminErr) {
    logger.error(
      {
        event: "tenant_signup_admin_link_failed",
        orgId,
        pgCode: (adminErr as { code?: string }).code ?? null,
      },
      "tenant signup: admin_users link failed",
    );
    return {
      ok: false,
      reason: "unavailable",
      message:
        "Your workspace was created but we hit a snag finishing setup. Our team will reach out.",
    };
  }

  deps.audit({
    action: "auth.tenant_self_signup",
    adminEmail: emailLower,
    adminUserId: userId,
    ip: null,
    metadata: { slug: input.slug, orgId },
  });

  return {
    ok: true,
    slug: input.slug,
    signInUrl: `${deps.publicBaseUrl}${UI_PATH_PREFIX}/sign-in`,
  };
}
