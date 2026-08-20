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
//     --admin-email=alice@acme.example [--storefront-name="AcmeSleep"] \
//     [--plan=mask_fitter] \
//     [--provision-fax [--fax-area-code=215]] | [--fax-number=+12155551212]
//
// Billing plan (migration 0362 catalog; optional):
//   * --plan=mask_fitter   stands the tenant up as a FITTER-ONLY DME — its
//                          product scope (migration 0419) gates the console
//                          down to the AI mask fitter (send link → get size).
//   * --plan=launch|growth|scale   a full-suite tenant on that plan.
//   Omit to leave the tenant with no subscription (they pick a plan in-app
//   from the billing console). Idempotent: an existing current plan is never
//   silently switched.
//
//   The --plan also drives the tenant's STARTING feature flags: each plan
//   carries a preset "bundle" (lib/resupply-domain/feature-flag-presets.ts,
//   mirroring the marketed tiers) and only that bundle's flags default ON —
//   so the operator reviews nothing at signup and a Launch tenant doesn't get
//   Scale-tier automation. Without --plan, all flags are copied from the seed
//   tenant verbatim (legacy behavior). Every flag stays individually
//   toggleable afterward in the admin Control Center.
//
// Fax number (migration 0368 — per-tenant fax identity):
//   * --provision-fax        auto-orders a fax-capable DID from Telnyx
//                            (needs TELNYX_API_KEY + TELNYX_FAX_CONNECTION_ID)
//                            and attaches it to the fax Application, so the
//                            tenant's inbound/outbound faxes use their own
//                            number. Optional --fax-area-code keeps it local.
//   * --fax-number=<E.164>   sets a ported / pre-existing DID directly.
//   Omit both to onboard without a fax number (add one later from the admin
//   Settings → Fax number page). Provisioning is fail-soft: an error here is
//   reported but does NOT fail the rest of onboarding.
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
import {
  getSupabaseServiceRoleClient,
  SEED_ORG_SLUG,
} from "@workspace/resupply-db";
import {
  isPresetExemptFlag,
  resolvePlanFlagPreset,
} from "@workspace/resupply-domain";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";
import {
  createTelnyxNumberClient,
  TelnyxConfigError,
} from "@workspace/resupply-telecom";

interface ParsedArgs {
  orgSlug: string;
  orgName: string;
  adminEmail: string;
  storefrontName: string | null;
  /** Optional billing-plan code to assign at onboarding (e.g. "mask_fitter"
   *  to stand the tenant up as a fitter-only DME, or "launch"/"growth"/…).
   *  Null leaves the tenant with no subscription (they pick one in-app). */
  plan: string | null;
  status: "active" | "suspended" | "archived";
  force: boolean;
  sendEmail: boolean;
  productName: string;
  publicBaseUrl: string;
  uiPathPrefix: string;
  /** Auto-order a fax-capable DID from Telnyx for the new tenant. */
  provisionFax: boolean;
  /** Optional US area code to keep the auto-provisioned fax number local. */
  faxAreaCode: string | null;
  /** A ported / pre-existing fax DID to set manually (no Telnyx call). */
  faxNumber: string | null;
}

// Mirrors the DB CHECK on organizations.slug
// (0331_organizations_tenant.sql): a URL-safe lowercase label.
const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const E164_RE = /^\+[1-9]\d{6,14}$/;
const AREA_CODE_RE = /^\d{3}$/;

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

  const plan = (args.get("plan") ?? "").trim().toLowerCase() || null;
  if (plan && !/^[a-z0-9_]+$/.test(plan)) {
    fail(
      `--plan must be a billing-plan code (lowercase a-z, 0-9, underscore), ` +
        `e.g. 'mask_fitter' or 'launch'. Got: '${plan}'.`,
    );
  }

  const faxNumber = (args.get("fax-number") ?? "").trim() || null;
  if (faxNumber && !E164_RE.test(faxNumber)) {
    fail(
      `--fax-number must be E.164 (e.g. +12155551212). Got: '${faxNumber}'.`,
    );
  }
  const faxAreaCode = (args.get("fax-area-code") ?? "").trim() || null;
  if (faxAreaCode && !AREA_CODE_RE.test(faxAreaCode)) {
    fail(
      `--fax-area-code must be a 3-digit US area code. Got: '${faxAreaCode}'.`,
    );
  }
  const provisionFax = flags.has("provision-fax");
  if (provisionFax && faxNumber) {
    fail(
      "Pass either --provision-fax (auto-order a number) OR --fax-number=<E.164> " +
        "(set a ported/existing number) — not both.",
    );
  }

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
    plan,
    status: statusRaw,
    force: flags.has("force"),
    sendEmail: !flags.has("no-email"),
    productName,
    publicBaseUrl,
    uiPathPrefix,
    provisionFax,
    faxAreaCode,
    faxNumber,
  };
}

/**
 * Provision (or set) the tenant's own fax number — the companion to the
 * per-tenant SMS / voice identity (migration 0364), now for fax (0368).
 *
 *   * `--fax-number=<E.164>` sets a ported / pre-existing DID directly (no
 *     vendor call).
 *   * `--provision-fax` auto-orders a fax-capable DID from Telnyx (Twilio
 *     retired Programmable Fax) and attaches it to the fax Application, so
 *     inbound faxes route to this tenant and outbound faxes send from it.
 *
 * Idempotent: a tenant that already has a fax number is left untouched.
 * Fail-soft: a provisioning error is REPORTED but does NOT fail onboarding
 * — the tenant is already stood up, and the number can be added later from
 * the admin "Fax number" settings page or by re-running with the flag.
 */
async function provisionTenantFax(
  supabase: OnboardClient,
  orgId: string,
  a: ParsedArgs,
): Promise<string> {
  if (!a.provisionFax && !a.faxNumber) {
    return "skipped (pass --provision-fax or --fax-number to set one)";
  }

  // Don't re-provision a tenant that already has a fax number.
  const { data: org, error: readErr } = await supabase
    .schema("resupply")
    .from("organizations")
    .select("fax_from_number")
    .eq("id", orgId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (org?.fax_from_number) {
    return `existing (${org.fax_from_number}) — left unchanged`;
  }

  const nowIso = new Date().toISOString();

  // Manual: a ported / pre-existing DID. No vendor call.
  if (a.faxNumber) {
    const { error } = await supabase
      .schema("resupply")
      .from("organizations")
      .update({
        fax_from_number: a.faxNumber,
        fax_telnyx_order_id: null,
        fax_provisioned_at: nowIso,
      })
      .eq("id", orgId);
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        return `FAILED — ${a.faxNumber} is already assigned to another tenant`;
      }
      throw error;
    }
    return `${a.faxNumber} (set manually)`;
  }

  // Auto-provision from Telnyx.
  if (
    !process.env.TELNYX_API_KEY?.trim() ||
    !process.env.TELNYX_FAX_CONNECTION_ID?.trim()
  ) {
    return (
      "FAILED — TELNYX_API_KEY and TELNYX_FAX_CONNECTION_ID must be set to " +
      "auto-provision; tenant onboarded WITHOUT a fax number (set one later)"
    );
  }

  let result: { phoneNumber: string; orderId: string; status: string };
  try {
    const client = createTelnyxNumberClient();
    result = await client.provisionFaxNumber({
      areaCode: a.faxAreaCode ?? undefined,
      customerReference: `org:${a.orgSlug}`,
    });
  } catch (err) {
    if (err instanceof TelnyxConfigError) {
      return "FAILED — Telnyx not configured; tenant onboarded WITHOUT a fax number";
    }
    return `FAILED — ${
      err instanceof Error ? err.message : "Telnyx provisioning error"
    }; tenant onboarded WITHOUT a fax number`;
  }

  const { error: updErr } = await supabase
    .schema("resupply")
    .from("organizations")
    .update({
      fax_from_number: result.phoneNumber,
      fax_telnyx_order_id: result.orderId,
      fax_provisioned_at: nowIso,
    })
    .eq("id", orgId);
  if (updErr) {
    // The number was bought but the write failed — surface the order id so
    // the operator can reconcile rather than orphaning a paid-for number.
    return (
      `FAILED to persist — number ${result.phoneNumber} was ORDERED ` +
      `(telnyx_order_id=${result.orderId}) but the DB write failed: ` +
      `${updErr.message}. Reconcile by hand.`
    );
  }
  return `${result.phoneNumber} (provisioned via Telnyx, order=${result.orderId}, status=${result.status})`;
}

type OnboardClient = ReturnType<typeof getSupabaseServiceRoleClient>;

/**
 * Provision the tenant's feature-flag rows. Since Phase 1 (migration
 * 0350) feature_flags is keyed (org_id, key), so a new org needs its own
 * row per flag before its admins can toggle anything in Control Center.
 * Copies the seed tenant's catalog (keys + metadata) as the starting point.
 *
 * Enabled state:
 *   * With a recognized `planCode`, apply that plan's preset bundle
 *     (`resolvePlanFlagPreset`, mirroring the marketed tiers): only the
 *     plan's flags default ON, the rest OFF. This is the "streamlined
 *     signup" path — the operator reviews nothing, and a Launch tenant
 *     isn't handed Scale-tier automation. Every flag stays toggleable in
 *     Control Center afterward.
 *   * Without a plan (or an unrecognized one), fall back to the legacy
 *     behavior: copy the seed tenant's `enabled` state verbatim.
 *
 * Idempotent: existing (org_id, key) rows are left untouched. No-op when
 * onboarding the seed tenant itself (it already carries the canonical rows
 * from the seed migrations).
 */
async function provisionFeatureFlags(
  supabase: OnboardClient,
  orgId: string,
  planCode: string | null,
): Promise<{ provisioned: number; enabled: number; preset: string | null }> {
  const { data: seedOrg, error: seedErr } = await supabase
    .schema("resupply")
    .from("organizations")
    .select("id")
    .eq("slug", SEED_ORG_SLUG)
    .maybeSingle();
  if (seedErr) throw seedErr;
  if (!seedOrg || seedOrg.id === orgId) {
    return { provisioned: 0, enabled: 0, preset: null };
  }

  const { data: seedFlags, error: flagsErr } = await supabase
    .schema("resupply")
    .from("feature_flags")
    .select("key, enabled, description, category")
    .eq("org_id", seedOrg.id);
  if (flagsErr) throw flagsErr;
  if (!seedFlags || seedFlags.length === 0) {
    return { provisioned: 0, enabled: 0, preset: null };
  }

  // A recognized plan code selects a preset bundle; otherwise null → keep
  // the seed tenant's enabled state (legacy copy-all behavior).
  const preset = resolvePlanFlagPreset(planCode);

  const rows = seedFlags.map((f) => ({
    org_id: orgId,
    key: f.key,
    // `module.*` keys are preset-exempt: they're the tenant's own
    // navigation choices, not a plan entitlement. A preset turns off
    // everything it doesn't list, so applying one to them would onboard
    // every new tenant with an empty console sidebar.
    enabled:
      preset && !isPresetExemptFlag(f.key) ? preset.has(f.key) : f.enabled,
    description: f.description,
    category: f.category,
  }));
  const { error: insErr } = await supabase
    .schema("resupply")
    .from("feature_flags")
    .upsert(rows, { onConflict: "org_id,key", ignoreDuplicates: true });
  if (insErr) throw insErr;
  return {
    provisioned: rows.length,
    enabled: rows.filter((r) => r.enabled).length,
    preset: preset ? planCode : null,
  };
}

/**
 * Give the tenant its own default mask formulary.
 *
 * Migration 0482 seeds one per org, but a migration only covers the orgs
 * that existed when it ran. A tenant onboarded afterwards would have NO
 * active formulary, and the fitting engine's fallback for that is an
 * implicit open formulary with a null id and version 0 — so every fit
 * report that tenant produced would cite a formulary the operator cannot
 * find, edit, or version. That defeats the provenance the report exists
 * to provide.
 *
 * 'open' posture with zero rules is exactly the pre-formulary behaviour
 * (every catalog mask is dispensable), so this changes nothing about what
 * gets recommended — it only makes the provenance real.
 *
 * Idempotent: skips when the tenant already has one.
 */
async function provisionDefaultFormulary(
  supabase: OnboardClient,
  orgId: string,
): Promise<{ created: boolean }> {
  const { data: existing, error: readErr } = await supabase
    .schema("resupply")
    .from("formularies")
    .select("id")
    .eq("org_id", orgId)
    .limit(1)
    .maybeSingle();
  if (readErr) throw readErr;
  if (existing) return { created: false };

  const { error } = await supabase
    .schema("resupply")
    .from("formularies")
    .insert({
      org_id: orgId,
      name: "Default formulary",
      status: "active",
      default_posture: "open",
      version: 1,
      notes:
        "Created by tenant:onboard. Open posture with no rules behaves " +
        "exactly like the pre-formulary engine: every catalog mask is " +
        "dispensable. Add rules to shape it.",
    });
  if (error) throw error;
  return { created: true };
}

/**
 * Assign the tenant a billing plan by code (migration 0362 catalog). Use
 * `--plan=mask_fitter` to stand a tenant up as a fitter-only DME — its
 * product scope (migration 0419) then gates the console down to the AI mask
 * fitter — or `--plan=launch|growth|scale` for a full-suite tenant.
 *
 * Idempotent & safe: a tenant that already has a current
 * (active/trialing/past_due) subscription is LEFT UNTOUCHED — onboarding
 * never silently switches a tenant's plan (that's a deliberate billing
 * action, done from the billing console). Returns a human-readable summary;
 * a bad plan code is reported but does NOT fail the rest of onboarding.
 */
async function provisionBillingPlan(
  supabase: OnboardClient,
  orgId: string,
  planCode: string | null,
): Promise<string> {
  if (!planCode) return "skipped (no --plan; tenant selects one in-app)";

  const { data: plan, error: planErr } = await supabase
    .schema("resupply")
    .from("billing_plans")
    .select("id, name")
    .eq("code", planCode)
    .maybeSingle();
  if (planErr) throw planErr;
  if (!plan) {
    const { data: codes } = await supabase
      .schema("resupply")
      .from("billing_plans")
      .select("code")
      .order("sort_order");
    const available = (codes ?? []).map((c) => c.code).join(", ");
    return `FAILED — no billing plan with code '${planCode}' (available: ${
      available || "none"
    })`;
  }

  const { data: existing, error: existErr } = await supabase
    .schema("resupply")
    .from("tenant_billing_subscriptions")
    .select("id, billing_plans(code)")
    .eq("org_id", orgId)
    .in("status", ["active", "trialing", "past_due"])
    .limit(1)
    .maybeSingle();
  if (existErr) throw existErr;
  if (existing) {
    const existingCode =
      (existing as { billing_plans?: { code?: string } | null }).billing_plans
        ?.code ?? "unknown";
    return existingCode === planCode
      ? `existing (${plan.name}) — left unchanged`
      : `existing plan '${existingCode}' — left unchanged (switch it from the billing console)`;
  }

  const { error: insErr } = await supabase
    .schema("resupply")
    .from("tenant_billing_subscriptions")
    .insert({
      org_id: orgId,
      plan_id: plan.id,
      status: "active",
      notes: "Seeded by tenant:onboard",
      updated_by_email: "tenant:onboard",
    });
  if (insErr) throw insErr;
  return `${plan.name} (assigned)`;
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

  // ── 1b. Provision the tenant's feature flags (Phase 1, org-scoped).
  //        With a --plan, apply that plan's preset bundle (only its flags
  //        default ON); otherwise copy the seed tenant's state verbatim. ─
  const flagsResult = await provisionFeatureFlags(supabase, orgId, a.plan);

  // ── 1b-ii. Give the tenant its own default mask formulary. ─────────
  const formularyResult = await provisionDefaultFormulary(supabase, orgId);

  // ── 1c. Optionally assign a billing plan (e.g. mask_fitter). ────────
  const planResult = await provisionBillingPlan(supabase, orgId, a.plan);

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

  // ── 4. Fax number: auto-provision (Telnyx) or set manually. ────────
  const faxResult = await provisionTenantFax(supabase, orgId, a);

  // ── Summary. ───────────────────────────────────────────────────────
  process.stdout.write(
    `\n[tenant:onboard] Tenant '${a.orgSlug}' ready.\n` +
      `  organization      = ${a.orgName} (${orgAction}) org_id=${orgId} status=${a.status}\n` +
      `  storefront_name   = ${a.storefrontName ?? "(falls back to name)"}\n` +
      `  feature flags     = ${
        flagsResult.provisioned === 0
          ? "none provisioned (seed tenant, no seed org, or seed has no feature_flag rows)"
          : flagsResult.preset
            ? `${flagsResult.enabled}/${flagsResult.provisioned} ON via '${flagsResult.preset}' preset bundle`
            : `${flagsResult.provisioned} provisioned from seed catalog (no --plan; verbatim copy)`
      }\n` +
      `  mask formulary    = ${
        formularyResult.created
          ? "'Default formulary' created (open posture, no rules)"
          : "already present (left as-is)"
      }\n` +
      `  billing plan      = ${planResult}\n` +
      `  admin auth user   = ${emailLower} (${userAction}) role=admin\n` +
      `  admin_users row   = role=admin status=active org_id=${orgId} [${adminAction}]\n` +
      `  fax number        = ${faxResult}\n`,
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
