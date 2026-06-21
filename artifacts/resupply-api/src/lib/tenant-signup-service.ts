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
//   * Only an UNVERIFIED ADMIN INVITE is reusable; any other existing
//     account (verified, non-admin, or locked/revoked) is rejected
//     ("sign in instead") rather than hijacked or left unusable.
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
  renderPasswordResetEmail,
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
  /**
   * Origin the signup was submitted from (e.g. https://cmbreathe.com).
   * Used to build the verification + sign-in links so a new PLATFORM
   * tenant is sent to the platform host — NOT the tenant-pinned
   * `SHOP_PUBLIC_BASE_URL` (pennpaps.com) the shared auth deps default
   * to. Falls back to that default when absent/invalid.
   */
  baseUrl?: string;
  /**
   * When set, email the new admin a SET-PASSWORD link (a `password_reset`
   * token) instead of the default verify-email link. The phone (voice)
   * signup path uses this: the caller never speaks or learns a password (a
   * throwaway is stored), so they finish by setting one via the emailed
   * link — and completing that reset also verifies the email. The web
   * signup form leaves this unset (the user chose their own password in the
   * form and only needs to verify).
   */
  sendSetPasswordLink?: boolean;
  /**
   * Optional self-serve plan `code` (e.g. "mask_fitter" / "launch" /
   * "growth" / "scale") the caller chose during sign-up. When present, the
   * matching plan is assigned as the new tenant's current billing
   * subscription so the platform's product scope reflects their choice
   * immediately (a "mask_fitter" tenant is scoped to the fitter surfaces).
   * The voice/phone signup passes this; the web form leaves it unset and the
   * tenant picks a plan on the billing page after onboarding. Assignment is
   * best-effort + DB-only: only a public, non-custom plan is honored, and
   * Stripe billing is synced later when the tenant completes billing setup.
   */
  plan?: string;
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

/**
 * Strip trailing "/" from a base URL in a single linear pass. The
 * obvious `s.replace(/\/+$/, "")` is a polynomial-ReDoS shape on
 * uncontrolled input (the base URL is derived from the request Host
 * header) — a long run of slashes makes the anchored `+$` backtrack
 * O(n²). A char scan is O(n) with no backtracking.
 */
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return s.slice(0, end);
}

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

/**
 * Assign the chosen self-serve plan as the new tenant's current billing
 * subscription, so the platform's product scope (e.g. the mask_fitter gating)
 * reflects their choice from the first sign-in. DB-only: it records the
 * subscription via the atomic `swap_tenant_subscription` RPC (the same RPC the
 * tenant self-service billing route uses) but does NOT touch Stripe — Stripe is
 * synced when the tenant completes billing onboarding.
 *
 * Best-effort, never throws: only a PUBLIC, NON-CUSTOM plan is honored (custom /
 * Enterprise require platform-admin assignment — mirrors the
 * /admin/billing/subscription guard), and any failure leaves the tenant on the
 * default "full" scope (the account is already created), exactly as if no plan
 * had been chosen.
 */
async function assignSelfServePlan(
  raw: RawClient,
  orgId: string,
  planCode: string,
  updatedByEmail: string,
): Promise<void> {
  try {
    const { data: plan, error } = await raw
      .schema("resupply")
      .from("billing_plans")
      .select("id, is_public, is_custom")
      .eq("code", planCode)
      .maybeSingle();
    if (error) throw error;
    const planRow = plan as {
      id: string;
      is_public: boolean;
      is_custom: boolean;
    } | null;
    if (!planRow || !planRow.is_public || planRow.is_custom) {
      logger.warn(
        { event: "tenant_signup_plan_not_selectable", orgId, planCode },
        "tenant signup: chosen plan not found or not self-selectable; left on default scope",
      );
      return;
    }
    const { error: swapErr } = await raw
      .schema("resupply")
      .rpc("swap_tenant_subscription", {
        p_org_id: orgId,
        p_plan_id: planRow.id,
        p_updated_by_email: updatedByEmail,
      });
    if (swapErr) throw swapErr;
  } catch (err) {
    logger.warn(
      { event: "tenant_signup_plan_assign_failed", orgId, planCode, err },
      "tenant signup: plan assignment failed; tenant left on default scope",
    );
  }
}

export async function createSelfServeTenant(
  input: SelfServeSignupInput,
): Promise<SelfServeSignupResult> {
  const deps = getAuthDeps();
  // Send verify/sign-in links to the host the signup came from (the
  // platform site), not the tenant-pinned auth default.
  const linkBaseUrl =
    input.baseUrl && /^https?:\/\//i.test(input.baseUrl)
      ? stripTrailingSlashes(input.baseUrl)
      : deps.publicBaseUrl;

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

  // 1. Resolve any existing auth user BEFORE creating an org (so a
  //    rejected signup never orphans an org). Only an UNVERIFIED ADMIN
  //    INVITE is reusable: a verified account, a non-admin (e.g. a
  //    storefront customer), or a locked/revoked user would either be
  //    hijacked or yield an unusable tenant (requireAdmin rejects
  //    non-admin roles), so reject those with the same neutral message.
  const existing = await deps.repo.findUserByEmail(emailLower);
  if (existing) {
    const reusableInvite =
      existing.role === "admin" &&
      existing.emailVerifiedAt == null &&
      existing.status !== "locked" &&
      existing.status !== "revoked";
    if (!reusableInvite) {
      return {
        ok: false,
        reason: "email_taken",
        message: "An account with this email already exists. Sign in instead.",
      };
    }
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
      // Payment wall (migration 0427): a brand-new self-serve tenant starts
      // gated until their first invoice is paid. No effect unless the operator
      // has turned the wall on (BILLING_PAYWALL_ENFORCED); the `invoice.paid`
      // webhook clears it. Existing tenants keep the column's `false` default.
      billing_required: true,
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

  // 5. Finish-setup token + email. Default (web signup): a verify-email
  //    link — the user already chose their own password. Voice signup
  //    (sendSetPasswordLink): a SET-PASSWORD link (a `password_reset`
  //    token) instead, because the caller never spoke/knows a password (a
  //    throwaway was stored above) — completing the reset both sets their
  //    password AND verifies the email, so no separate verify mail is
  //    needed. Only the most recent link of either kind stays valid.
  const ttlMs = deps.env.emailTokenTtlHours * 60 * 60 * 1000;
  const tokenPurpose = input.sendSetPasswordLink
    ? "password_reset"
    : "signup_verify";
  const token = issueToken();
  await deps.repo.expireUnconsumedEmailTokens({
    userId,
    purpose: tokenPurpose,
    at: new Date(),
  });
  await deps.repo.insertEmailToken({
    tokenHash: token.hash,
    userId,
    purpose: tokenPurpose,
    expiresAt: new Date(Date.now() + ttlMs),
  });
  const ctx: AuthEmailContext = {
    productName: PRODUCT_NAME,
    signatureName: PRODUCT_NAME,
    publicBaseUrl: linkBaseUrl,
    uiPathPrefix: UI_PATH_PREFIX,
  };
  const rendered = input.sendSetPasswordLink
    ? renderPasswordResetEmail(ctx, token.raw, ttlMs)
    : renderVerifyEmail(ctx, token.raw, ttlMs);
  try {
    await deps.email({
      to: input.adminEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
  } catch {
    // Swallow — a SendGrid blip must not fail signup; the user can
    // re-request the link via /admin/forgot-password.
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

  // 7. Optional plan assignment. The voice/phone signup passes the plan the
  //    caller chose; the web form leaves it unset (plan picked later on the
  //    billing page). Best-effort — a failure leaves the tenant on "full".
  if (input.plan) {
    await assignSelfServePlan(raw, orgId, input.plan, emailLower);
  }

  deps.audit({
    action: "auth.tenant_self_signup",
    adminEmail: emailLower,
    adminUserId: userId,
    ip: null,
    metadata: {
      slug: input.slug,
      orgId,
      ...(input.plan ? { plan: input.plan } : {}),
    },
  });

  return {
    ok: true,
    slug: input.slug,
    signInUrl: `${linkBaseUrl}${UI_PATH_PREFIX}/sign-in`,
  };
}
