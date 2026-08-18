// Platform super-admin: tenant directory + lifecycle (G4).
//
// GET  /resupply-api/platform/tenants                  — list every tenant
// POST /resupply-api/platform/tenants/:id/suspend      — status → suspended
// POST /resupply-api/platform/tenants/:id/reactivate   — status → active
//
// The cross-tenant platform-operator surface, gated by
// `requirePlatformAdmin` (the tier ABOVE a tenant admin). Reads/writes the
// GLOBAL `organizations` directory via `.raw()`.
//
// Suspend has real effect: the branding / host→org resolvers only match a
// `status = 'active'` row (so a suspended tenant's custom domain stops
// resolving to it and degrades to the platform site) and `listActiveOrgIds`
// excludes it (so the recurring worker crons skip it). The SEED tenant
// (the platform's own org, where the platform admins live) can NOT be
// suspended.
//
// PII posture: organizations rows are tenant metadata (slug, brand name,
// domain) — no patient data — so they're safe to return whole.

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { inviteTeamMember } from "@workspace/resupply-auth";
import {
  getOrgScopedClient,
  resolveSeedOrgId,
  SEED_ORG_SLUG,
} from "@workspace/resupply-db";

import {
  FEATURE_FLAG_KEYS,
  type FeatureFlagKey,
  invalidateFeatureFlagCache,
} from "../../lib/feature-flags";
import { getAuthDeps } from "../../lib/auth-deps";
import { getCompanyInfo } from "../../lib/company-info";
import { logger } from "../../lib/logger";
import {
  invalidateBrandingCache,
  resolveTenantBaseUrl,
} from "../../lib/tenant-branding";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePlatformAdmin } from "../../middlewares/requirePlatformAdmin";

const router: IRouter = Router();

const TENANT_SELECT =
  "id, slug, name, storefront_name, status, custom_domain, custom_domain_status, created_at";

// The single-tenant detail view surfaces a couple more operator-relevant
// fields than the directory list: the tenant's own outbound sender
// (migration 0360) and the last-touched timestamp.
const TENANT_DETAIL_SELECT = `${TENANT_SELECT}, from_email, from_name, updated_at`;

interface OrgRow {
  id: string;
  slug: string;
  name: string | null;
  storefront_name: string | null;
  status: string;
  custom_domain: string | null;
  custom_domain_status: string | null;
  created_at: string;
}

interface OrgDetailRow extends OrgRow {
  from_email: string | null;
  from_name: string | null;
  updated_at: string | null;
}

function toTenantView(o: OrgRow) {
  return {
    id: o.id,
    slug: o.slug,
    name: o.name,
    storefrontName: o.storefront_name,
    status: o.status,
    customDomain: o.custom_domain,
    customDomainStatus: o.custom_domain_status,
    createdAt: o.created_at,
  };
}

function toTenantDetailView(o: OrgDetailRow) {
  return {
    ...toTenantView(o),
    fromEmail: o.from_email,
    fromName: o.from_name,
    updatedAt: o.updated_at,
  };
}

// Feature-flag keys this running build knows how to toggle. A flag seeded
// by a newer migration than the deployed build still LISTS (read from DB)
// but can't be toggled — surfaced as `manageable: false` so the console
// can disable the switch instead of letting the operator hit a raw 404.
// Mirrors MANAGEABLE_KEYS in routes/admin/feature-flags.ts.
const MANAGEABLE_FLAG_KEYS: ReadonlySet<string> = new Set(FEATURE_FLAG_KEYS);

interface FeatureFlagRow {
  key: string;
  enabled: boolean;
  description: string | null;
  category: string | null;
  updated_by_email: string | null;
  updated_at: string;
}

function toFeatureFlagView(r: FeatureFlagRow) {
  return {
    key: r.key,
    enabled: r.enabled,
    description: r.description ?? "",
    category: r.category ?? "General",
    manageable: MANAGEABLE_FLAG_KEYS.has(r.key),
    updatedByEmail: r.updated_by_email,
    updatedAt: r.updated_at,
  };
}

const FEATURE_FLAG_SELECT =
  "key, enabled, description, category, updated_by_email, updated_at";

const tenantIdParam = z.object({ id: z.string().uuid() });

// Mirrors the DB CHECK `organizations_slug_format`
// (0331_organizations_tenant.sql): a URL-safe lowercase label.
const createTenantBody = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(63)
    .regex(
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
      "slug must be a URL-safe lowercase label (a-z, 0-9, hyphens)",
    ),
  name: z.string().trim().min(1).max(200),
});

/**
 * Provision a new tenant's feature-flag rows by copying the seed tenant's
 * current catalog (keys + enabled + metadata). Since the Phase-1 rekey
 * (migration 0350) feature_flags is keyed `(org_id, key)`, a fresh org
 * has no rows until this runs — without them a tenant admin can't toggle
 * anything in Control Center. Idempotent (`ON CONFLICT (org_id, key) DO
 * NOTHING`). Mirrors `provisionFeatureFlags` in scripts/tenant-onboard.ts
 * (the CLI path); kept in sync deliberately.
 */
async function provisionTenantFeatureFlags(
  raw: ReturnType<ReturnType<typeof getOrgScopedClient>["raw"]>,
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
router.get(
  "/platform/tenants",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (_req, res): Promise<void> => {
    // The `organizations` directory is GLOBAL (it IS the tenant list), so
    // it's reached via the `.raw()` escape hatch — the org-scoped facade
    // would wrongly filter it to one tenant. resolveSeedOrgId only supplies
    // a client; any org id yields the same unscoped `.raw()` client.
    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const supabase = getOrgScopedClient(seedOrgId).raw();
    const { data, error } = await supabase
      .schema("resupply")
      .from("organizations")
      .select(TENANT_SELECT)
      .order("created_at", { ascending: true });
    if (error) {
      logger.error(
        { event: "platform_tenants_list_failed", err: error },
        "platform: tenant list query failed",
      );
      res.status(500).json({ error: "tenant_list_failed" });
      return;
    }

    const tenants = ((data ?? []) as OrgRow[]).map(toTenantView);
    res.json({ tenants });
  },
);

// ── GET /platform/tenants/:id ───────────────────────────────────────
// One tenant's full record for the detail drill-down. Tenant metadata
// only (slug, brand, domain, sender) — no patient PHI. A 404 for an
// unknown id keeps the detail page from rendering a phantom tenant.
router.get(
  "/platform/tenants/:id",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (req, res): Promise<void> => {
    const parsed = tenantIdParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_tenant_id" });
      return;
    }
    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const { data, error } = await getOrgScopedClient(seedOrgId)
      .raw()
      .schema("resupply")
      .from("organizations")
      .select(TENANT_DETAIL_SELECT)
      .eq("id", parsed.data.id)
      .limit(1)
      .maybeSingle();
    if (error) {
      logger.error(
        { event: "platform_tenant_detail_failed", err: error },
        "platform: tenant detail query failed",
      );
      res.status(500).json({ error: "tenant_read_failed" });
      return;
    }
    if (!data) {
      res.status(404).json({ error: "tenant_not_found" });
      return;
    }
    res.json({ tenant: toTenantDetailView(data as OrgDetailRow) });
  },
);

/**
 * Flip a tenant's lifecycle status. Shared by suspend / reactivate.
 * Refuses to suspend the seed tenant (the platform's own org). Returns
 * the updated tenant, invalidates the host→brand/org caches so the change
 * takes effect immediately, and writes an audit row.
 */
async function setTenantStatus(
  req: Request,
  res: Response,
  nextStatus: "active" | "suspended",
): Promise<void> {
  const parsed = tenantIdParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_tenant_id" });
    return;
  }
  const id = parsed.data.id;

  const seedOrgId = await resolveSeedOrgId();
  if (!seedOrgId) {
    res.status(503).json({ error: "tenant_directory_unavailable" });
    return;
  }
  const supabase = getOrgScopedClient(seedOrgId).raw();

  // Load the target so we can 404 a missing id and refuse the seed org.
  const { data: existing, error: readErr } = await supabase
    .schema("resupply")
    .from("organizations")
    .select("id, slug, status")
    .eq("id", id)
    .limit(1)
    .maybeSingle();
  if (readErr) {
    logger.error(
      { event: "platform_tenant_read_failed", err: readErr },
      "platform: tenant read failed",
    );
    res.status(500).json({ error: "tenant_read_failed" });
    return;
  }
  if (!existing) {
    res.status(404).json({ error: "tenant_not_found" });
    return;
  }
  if (nextStatus === "suspended" && existing.slug === SEED_ORG_SLUG) {
    // The seed org is the platform's own tenant and the home of the
    // platform admins — suspending it would break the platform itself.
    res.status(400).json({ error: "cannot_suspend_seed_tenant" });
    return;
  }

  const { data: updated, error: updErr } = await supabase
    .schema("resupply")
    .from("organizations")
    .update({ status: nextStatus, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(TENANT_SELECT)
    .limit(1)
    .maybeSingle();
  if (updErr || !updated) {
    logger.error(
      { event: "platform_tenant_status_update_failed", err: updErr },
      "platform: tenant status update failed",
    );
    res.status(500).json({ error: "tenant_update_failed" });
    return;
  }

  // The host→brand and host→org caches key off status='active'; drop them
  // so a suspend/reactivate is visible on the next request, not after the
  // ~60s TTL.
  invalidateBrandingCache();

  await logAudit({
    action:
      nextStatus === "suspended"
        ? "platform.tenant.suspended"
        : "platform.tenant.reactivated",
    adminEmail: req.platformAdminEmail ?? "platform-admin",
    adminUserId: req.platformAdminUserId ?? null,
    targetTable: "organizations",
    targetId: id,
    metadata: { slug: (existing as { slug: string }).slug, status: nextStatus },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((err) => {
    logger.warn({ err }, "platform: tenant status audit write failed");
  });

  res.json({ tenant: toTenantView(updated as OrgRow) });
}

router.post(
  "/platform/tenants/:id/suspend",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  (req, res) => setTenantStatus(req, res, "suspended"),
);

router.post(
  "/platform/tenants/:id/reactivate",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  (req, res) => setTenantStatus(req, res, "active"),
);

// Tenant-scoped tables we surface a headline count for. Each is counted
// through the org-scoped facade for the TARGET tenant (the facade appends
// `.eq("org_id", :id)`), so the numbers are genuinely per-tenant.
const USAGE_COUNTS = [
  ["patients", "patients"],
  ["orders", "shop_orders"],
  ["conversations", "conversations"],
] as const;

router.get(
  "/platform/tenants/:id/usage",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (req, res): Promise<void> => {
    const parsed = tenantIdParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_tenant_id" });
      return;
    }
    const id = parsed.data.id;

    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    // Confirm the tenant exists (404 a bad id) via the global directory.
    const { data: org, error: orgErr } = await getOrgScopedClient(seedOrgId)
      .raw()
      .schema("resupply")
      .from("organizations")
      .select("id")
      .eq("id", id)
      .limit(1)
      .maybeSingle();
    if (orgErr) {
      logger.error(
        { event: "platform_tenant_usage_read_failed", err: orgErr },
        "platform: tenant usage org read failed",
      );
      res.status(500).json({ error: "tenant_read_failed" });
      return;
    }
    if (!org) {
      res.status(404).json({ error: "tenant_not_found" });
      return;
    }

    // Per-tenant counts via the scoped facade for the TARGET org.
    const db = getOrgScopedClient(id);
    try {
      const entries = await Promise.all(
        USAGE_COUNTS.map(async ([label, table]) => {
          const { count, error } = await db
            .from(table)
            .select("*", { count: "exact", head: true });
          if (error) throw error;
          return [label, count ?? 0] as const;
        }),
      );
      res.json({ tenantId: id, usage: Object.fromEntries(entries) });
    } catch (err) {
      logger.error(
        { event: "platform_tenant_usage_count_failed", err },
        "platform: tenant usage count failed",
      );
      res.status(500).json({ error: "usage_query_failed" });
    }
  },
);

// ── Per-tenant feature flags (platform-operator view) ───────────────
// A platform admin can read and toggle ANY tenant's feature flags from
// the console — the cross-tenant equivalent of the per-tenant Control
// Center (routes/admin/feature-flags.ts), which only ever sees the
// caller's own org. Reads/writes the TARGET org's rows directly. No PHI:
// flag keys + states are static config.

const flagKeyParam = z.object({
  id: z.string().uuid(),
  key: z.enum(FEATURE_FLAG_KEYS),
});
const flagPatchBody = z.object({ enabled: z.boolean() }).strict();

router.get(
  "/platform/tenants/:id/feature-flags",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (req, res): Promise<void> => {
    const parsed = tenantIdParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_tenant_id" });
      return;
    }
    const id = parsed.data.id;
    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const raw = getOrgScopedClient(seedOrgId).raw();

    // Confirm the tenant exists so a bad id 404s rather than returning [].
    const { data: org, error: orgErr } = await raw
      .schema("resupply")
      .from("organizations")
      .select("id")
      .eq("id", id)
      .limit(1)
      .maybeSingle();
    if (orgErr) {
      logger.error(
        { event: "platform_tenant_flags_org_read_failed", err: orgErr },
        "platform: tenant feature-flag org read failed",
      );
      res.status(500).json({ error: "tenant_read_failed" });
      return;
    }
    if (!org) {
      res.status(404).json({ error: "tenant_not_found" });
      return;
    }

    const { data, error } = await raw
      .schema("resupply")
      .from("feature_flags")
      .select(FEATURE_FLAG_SELECT)
      .eq("org_id", id)
      .order("category", { ascending: true })
      .order("key", { ascending: true });
    if (error) {
      logger.error(
        { event: "platform_tenant_flags_list_failed", err: error },
        "platform: tenant feature-flag list failed",
      );
      res.status(500).json({ error: "feature_flags_failed" });
      return;
    }
    res.json({
      tenantId: id,
      flags: ((data ?? []) as FeatureFlagRow[]).map(toFeatureFlagView),
    });
  },
);

router.patch(
  "/platform/tenants/:id/feature-flags/:key",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req, res): Promise<void> => {
    const parsed = flagKeyParam.safeParse(req.params);
    if (!parsed.success) {
      // A bad uuid is a 400; an unknown flag key is a 404 (the key isn't in
      // this build's catalog). Disambiguate so the client can react.
      const badId = parsed.error.issues.some((i) => i.path[0] === "id");
      res
        .status(badId ? 400 : 404)
        .json({ error: badId ? "invalid_tenant_id" : "unknown_flag" });
      return;
    }
    const bodyParsed = flagPatchBody.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const { id, key } = parsed.data;
    const nextEnabled = bodyParsed.data.enabled;

    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const raw = getOrgScopedClient(seedOrgId).raw();

    // Read prior state — also serves as the tenant-exists / flag-seeded
    // check, mirroring the per-tenant Control Center handler.
    const { data: priorRow, error: priorErr } = await raw
      .schema("resupply")
      .from("feature_flags")
      .select(FEATURE_FLAG_SELECT)
      .eq("org_id", id)
      .eq("key", key)
      .maybeSingle();
    if (priorErr) {
      logger.error(
        { event: "platform_tenant_flag_read_failed", err: priorErr },
        "platform: tenant feature-flag read failed",
      );
      res.status(500).json({ error: "feature_flag_read_failed" });
      return;
    }
    if (!priorRow) {
      // No row → either the tenant doesn't exist or wasn't provisioned.
      res.status(404).json({ error: "flag_not_seeded", key });
      return;
    }
    const prior = priorRow as FeatureFlagRow;
    if (prior.enabled === nextEnabled) {
      res.json({ tenantId: id, flag: toFeatureFlagView(prior) });
      return;
    }

    const { data: updated, error: updErr } = await raw
      .schema("resupply")
      .from("feature_flags")
      .update({
        enabled: nextEnabled,
        updated_by_user_id: req.platformAdminUserId ?? null,
        updated_by_email: req.platformAdminEmail ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("org_id", id)
      .eq("key", key)
      .select(FEATURE_FLAG_SELECT)
      .single();
    if (updErr || !updated) {
      logger.error(
        { event: "platform_tenant_flag_update_failed", err: updErr },
        "platform: tenant feature-flag update failed",
      );
      res.status(500).json({ error: "feature_flag_update_failed" });
      return;
    }

    invalidateFeatureFlagCache(key as FeatureFlagKey);

    await logAudit({
      action: "platform.feature_flag.toggle",
      adminEmail: req.platformAdminEmail ?? "platform-admin",
      adminUserId: req.platformAdminUserId ?? null,
      targetTable: "feature_flags",
      targetId: key,
      metadata: { orgId: id, key, from: prior.enabled, to: nextEnabled },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "platform: feature_flag toggle audit write failed");
    });

    // Durable per-tenant toggle record — the same table the tenant's own
    // Control Center "Recent toggle activity" panel reads, so a
    // platform-side change is visible to the tenant operator too.
    const { error: eventErr } = await raw
      .schema("resupply")
      .from("feature_flag_events")
      .insert({
        org_id: id,
        key,
        previous_enabled: prior.enabled,
        next_enabled: nextEnabled,
        operator_email: req.platformAdminEmail ?? null,
      });
    if (eventErr) {
      logger.warn(
        { err: eventErr, key },
        "platform: feature_flag_events insert failed",
      );
    }

    res.json({
      tenantId: id,
      flag: toFeatureFlagView(updated as FeatureFlagRow),
    });
  },
);

// ── GET /platform/tenants/:id/feature-flag-activity ─────────────────
// Recent feature-flag toggle history for one tenant — who flipped what,
// when, and which direction. Reads `feature_flag_events` (the durable
// toggle ledger the tenant's own Control Center reads), NOT `audit_log`
// (retired). Includes platform-side toggles, since the PATCH handler
// above writes the same rows. No PHI — flag keys are static config.
const ACTIVITY_DEFAULT_LIMIT = 20;
const ACTIVITY_MAX_LIMIT = 100;
const activityQuery = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => {
      if (!v) return ACTIVITY_DEFAULT_LIMIT;
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) return ACTIVITY_DEFAULT_LIMIT;
      return Math.min(n, ACTIVITY_MAX_LIMIT);
    }),
});

interface FlagEventRow {
  occurred_at: string;
  operator_email: string | null;
  key: string;
  previous_enabled: boolean;
  next_enabled: boolean;
}

router.get(
  "/platform/tenants/:id/feature-flag-activity",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (req, res): Promise<void> => {
    const parsed = tenantIdParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_tenant_id" });
      return;
    }
    const id = parsed.data.id;
    // A repeated/array `limit` would throw on `.parse()`; degrade to the
    // default instead of 5xx (mirrors the admin activity reader).
    const parsedQuery = activityQuery.safeParse(req.query);
    const limit = parsedQuery.success
      ? parsedQuery.data.limit
      : ACTIVITY_DEFAULT_LIMIT;

    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const raw = getOrgScopedClient(seedOrgId).raw();

    const { data: org, error: orgErr } = await raw
      .schema("resupply")
      .from("organizations")
      .select("id")
      .eq("id", id)
      .limit(1)
      .maybeSingle();
    if (orgErr) {
      logger.error(
        { event: "platform_tenant_flag_activity_org_read_failed", err: orgErr },
        "platform: tenant flag-activity org read failed",
      );
      res.status(500).json({ error: "tenant_read_failed" });
      return;
    }
    if (!org) {
      res.status(404).json({ error: "tenant_not_found" });
      return;
    }

    const { data, error } = await raw
      .schema("resupply")
      .from("feature_flag_events")
      .select(
        "occurred_at, operator_email, key, previous_enabled, next_enabled",
      )
      .eq("org_id", id)
      .order("occurred_at", { ascending: false })
      .limit(limit);
    if (error) {
      logger.error(
        { event: "platform_tenant_flag_activity_failed", err: error },
        "platform: tenant flag-activity query failed",
      );
      res.status(500).json({ error: "feature_flag_activity_failed" });
      return;
    }

    const activity = ((data ?? []) as FlagEventRow[]).map((r) => ({
      occurredAt: r.occurred_at,
      operatorEmail: r.operator_email ?? null,
      key: r.key,
      from: r.previous_enabled,
      to: r.next_enabled,
    }));
    res.json({ tenantId: id, activity });
  },
);

// ── GET /platform/tenants/:id/admins ────────────────────────────────
// The tenant's staff accounts (who can sign into its admin console) —
// the support/security answer to "who do I contact?" and "is there a
// stale admin?". Reads `admin_users` for the TARGET org via the scoped
// facade. admin_users carries the email/role/status directly, so no
// cross-schema join is needed. Staff emails are operator metadata (a
// platform admin can already impersonate the tenant) — no patient PHI.
interface AdminUserRow {
  id: string;
  email_lower: string | null;
  role: string;
  status: string;
  display_name: string | null;
  last_login_at: string | null;
  invited_at: string | null;
}

router.get(
  "/platform/tenants/:id/admins",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (req, res): Promise<void> => {
    const parsed = tenantIdParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_tenant_id" });
      return;
    }
    const id = parsed.data.id;

    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    // Confirm the tenant exists (404 a bad id) via the global directory.
    const { data: org, error: orgErr } = await getOrgScopedClient(seedOrgId)
      .raw()
      .schema("resupply")
      .from("organizations")
      .select("id")
      .eq("id", id)
      .limit(1)
      .maybeSingle();
    if (orgErr) {
      logger.error(
        { event: "platform_tenant_admins_org_read_failed", err: orgErr },
        "platform: tenant admins org read failed",
      );
      res.status(500).json({ error: "tenant_read_failed" });
      return;
    }
    if (!org) {
      res.status(404).json({ error: "tenant_not_found" });
      return;
    }

    // Per-tenant staff via the scoped facade for the TARGET org.
    const { data, error } = await getOrgScopedClient(id)
      .from("admin_users")
      .select(
        "id, email_lower, role, status, display_name, last_login_at, invited_at",
      )
      .order("invited_at", { ascending: false });
    if (error) {
      logger.error(
        { event: "platform_tenant_admins_failed", err: error },
        "platform: tenant admins query failed",
      );
      res.status(500).json({ error: "admins_query_failed" });
      return;
    }

    const admins = ((data ?? []) as AdminUserRow[]).map((a) => ({
      id: a.id,
      email: a.email_lower,
      role: a.role,
      status: a.status,
      displayName: a.display_name,
      lastLoginAt: a.last_login_at,
      invitedAt: a.invited_at,
    }));
    res.json({ tenantId: id, admins });
  },
);

// ── POST /platform/tenants/:id/admins ───────────────────────────────
//
// Set up an admin account for a tenant by hand.
//
// Until now the only way to give a tenant its first login was the
// `tenant:onboard` CLI — which means shell access to a Railway box. That
// is a fine belt-and-braces path, but it made the most ordinary
// onboarding step in the product ("create this customer's account")
// impossible from the console a super-admin is already sitting in, and
// impossible at all for an operator without deploy credentials.
//
// Two modes, mirroring POST /admin/team/invite (the in-tenant version of
// this route), so the two behave identically and share `inviteTeamMember`:
//
//   * EMAIL INVITE (default) — mints the auth row, issues a 7-day
//     set-password token, and emails it, branded to the TARGET tenant.
//     The new admin sets their own password; we never see it.
//   * INITIAL PASSWORD — provisions the account active + email-verified
//     with the given password and sends nothing. For onboarding calls
//     where the operator reads the credential to the customer directly,
//     and for tenants whose sending domain isn't authenticated yet (an
//     invite email to an unauthenticated domain lands in spam, which
//     looks exactly like "the product is broken" on day one).
//
// When the invite email can't be delivered we return the raw
// `inviteLink` so the operator can pass it along out of band, rather
// than leaving a half-created account with no way in.
//
// PHI posture: admin_users rows are staff metadata (email, role, status)
// — no patient data crosses this surface, unlike the deliberately
// aggregate-only tenant usage endpoints above.
const createTenantAdminBody = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    // Granular role, matching admin_users.role. Defaults to the tenant
    // owner role, since that's what this route exists to create.
    role: z
      .enum([
        "admin",
        "supervisor",
        "csr",
        "fitter",
        "fulfillment",
        "compliance_officer",
        "agent",
        "rt",
        "biller",
      ])
      .default("admin"),
    displayName: z.string().trim().min(1).max(120).nullable().optional(),
    // Same floor as sign-in / change-password, so an operator-set
    // password is never weaker than a user-set one. `inviteTeamMember`
    // re-validates against the shared policy and throws if it fails.
    initialPassword: z.string().min(12).max(1024).nullable().optional(),
  })
  .strict();

router.post(
  "/platform/tenants/:id/admins",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const params = tenantIdParam.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_tenant_id" });
      return;
    }
    const parsed = createTenantAdminBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_admin",
        details: parsed.error.flatten(),
      });
      return;
    }
    const orgId = params.data.id;
    const { email, role, displayName } = parsed.data;
    const initialPassword = parsed.data.initialPassword ?? undefined;
    const useInitialPassword = typeof initialPassword === "string";

    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }

    // 404 an unknown tenant before touching any auth state — creating an
    // orphan auth user for a typo'd org id would be worse than a 404.
    const { data: org, error: orgErr } = await getOrgScopedClient(seedOrgId)
      .raw()
      .schema("resupply")
      .from("organizations")
      .select("id, name")
      .eq("id", orgId)
      .limit(1)
      .maybeSingle();
    if (orgErr) {
      logger.error(
        { event: "platform_tenant_admin_org_read_failed", err: orgErr },
        "platform: tenant admin create org read failed",
      );
      res.status(500).json({ error: "tenant_read_failed" });
      return;
    }
    if (!org) {
      res.status(404).json({ error: "tenant_not_found" });
      return;
    }

    const supabase = getOrgScopedClient(orgId);
    const raw = supabase.raw();

    // `resupply_auth.users.email_lower` and `admin_users.email_lower` are
    // GLOBALLY unique, so an email already claimed by another tenant
    // cannot be added here: inviteTeamMember would mutate that other
    // tenant's identity row (role change + a fresh reset token + a
    // spurious email) and then 23505 on insert. Refuse up front, same as
    // the in-tenant invite route and the onboard CLI do.
    const { data: existingAdmin, error: existingErr } = await raw
      .schema("resupply")
      .from("admin_users")
      .select("id, org_id, role, status, auth_user_id, display_name")
      .eq("email_lower", email)
      .limit(1)
      .maybeSingle();
    if (existingErr) {
      logger.error(
        { event: "platform_tenant_admin_lookup_failed", err: existingErr },
        "platform: tenant admin lookup failed",
      );
      res.status(500).json({ error: "admin_lookup_failed" });
      return;
    }
    const prior = existingAdmin as {
      id: string;
      org_id: string | null;
      role: string;
      status: string;
      auth_user_id: string | null;
      display_name: string | null;
    } | null;
    if (prior && prior.org_id && prior.org_id !== orgId) {
      res.status(409).json({
        error: "email_belongs_to_another_tenant",
        message: `${email} is already a team member of another organization. Remove them there first, or use a different address.`,
      });
      return;
    }
    if (prior && prior.status === "active") {
      res.status(409).json({
        error: "already_active_member",
        message: `${email} is already an active member of this tenant. Change their role from the tenant's own Team page.`,
        adminId: prior.id,
      });
      return;
    }

    // Brand the invite to the TARGET tenant, not the platform: the person
    // receiving it is signing in to THEIR company's console, and a
    // CareMetric-branded email for a Penn login reads as a phish.
    // getCompanyInfo falls back to the neutral platform identity for a
    // tenant with no dme_organization row — never the seed tenant's brand.
    const company = await getCompanyInfo(orgId);
    // Land the set-password link on the tenant's own verified domain when
    // it has one, so the link host matches the brand in the email.
    const tenantBaseUrl = await resolveTenantBaseUrl(orgId);

    let invite: Awaited<ReturnType<typeof inviteTeamMember>>;
    try {
      invite = await inviteTeamMember(raw, getAuthDeps(), {
        emailLower: email,
        // Only `admin` is a super-admin; everything else buckets to the
        // coarse `agent` auth role. The granular value lands on
        // admin_users.role below and is what RBAC actually reads.
        role: role === "admin" ? "admin" : "agent",
        roleLabel: role === "admin" ? "Super admin" : "Team member",
        displayName: displayName ?? prior?.display_name ?? null,
        productName: company.name,
        signatureName: company.legalName,
        uiPathPrefix: "/admin",
        publicBaseUrl: tenantBaseUrl ?? undefined,
        initialPassword,
      });
    } catch (err) {
      // The one caller-fixable failure here is a rejected password
      // (inviteTeamMember re-validates against the shared policy).
      const message = err instanceof Error ? err.message : "";
      if (message.startsWith("initialPassword:")) {
        res.status(422).json({
          error: "weak_initial_password",
          message: message.replace(/^initialPassword:\s*/, ""),
        });
        return;
      }
      logger.error(
        { event: "platform_tenant_admin_invite_failed", err, orgId },
        "platform: tenant admin invite failed",
      );
      res.status(500).json({ error: "admin_invite_failed" });
      return;
    }

    // An initial-password account is sign-in-ready right now, so mirror
    // that on admin_users; an emailed invite stays pending until the
    // recipient sets their password.
    const nowIso = new Date().toISOString();
    const status = useInitialPassword ? "active" : "pending";
    const acceptedAt = useInitialPassword ? nowIso : null;
    const ADMIN_SELECT =
      "id, email_lower, role, status, display_name, last_login_at, invited_at";

    let row: AdminUserRow | null;
    if (prior) {
      const { data, error } = await raw
        .schema("resupply")
        .from("admin_users")
        .update({
          org_id: orgId,
          role,
          status,
          auth_user_id: invite.authUserId,
          display_name: displayName ?? prior.display_name,
          invited_at: nowIso,
          accepted_at: acceptedAt,
          revoked_at: null,
          revoked_by: null,
          updated_at: nowIso,
        })
        .eq("id", prior.id)
        .select(ADMIN_SELECT)
        .limit(1)
        .maybeSingle();
      if (error) {
        logger.error(
          { event: "platform_tenant_admin_update_failed", err: error, orgId },
          "platform: tenant admin update failed",
        );
        res.status(500).json({ error: "admin_write_failed" });
        return;
      }
      row = data as AdminUserRow | null;
    } else {
      const { data, error } = await raw
        .schema("resupply")
        .from("admin_users")
        .insert({
          org_id: orgId,
          email_lower: email,
          role,
          status,
          auth_user_id: invite.authUserId,
          display_name: displayName ?? null,
          invited_at: nowIso,
          accepted_at: acceptedAt,
          updated_at: nowIso,
        })
        .select(ADMIN_SELECT)
        .limit(1)
        .maybeSingle();
      if (error) {
        logger.error(
          { event: "platform_tenant_admin_insert_failed", err: error, orgId },
          "platform: tenant admin insert failed",
        );
        res.status(500).json({ error: "admin_write_failed" });
        return;
      }
      row = data as AdminUserRow | null;
    }
    if (!row) {
      res.status(500).json({ error: "admin_write_failed" });
      return;
    }

    await logAudit({
      action: "platform.tenant.admin_created",
      adminEmail: req.platformAdminEmail ?? "platform-admin",
      adminUserId: req.platformAdminUserId ?? null,
      targetTable: "admin_users",
      targetId: row.id,
      // Never log the password itself — only WHICH path was taken, so an
      // operator reviewing the trail can tell an out-of-band credential
      // hand-off from an emailed invite.
      metadata: {
        orgId,
        role,
        credential: useInitialPassword
          ? "operator_set_password"
          : "email_invite",
        emailSent: invite.emailSent,
      },
      ip: null,
      userAgent: null,
    }).catch((err) => {
      logger.warn({ err }, "platform: tenant admin create audit write failed");
    });

    res.status(prior ? 200 : 201).json({
      tenantId: orgId,
      admin: {
        id: row.id,
        email: row.email_lower,
        role: row.role,
        status: row.status,
        displayName: row.display_name,
        lastLoginAt: row.last_login_at,
        invitedAt: row.invited_at,
      },
      emailSent: invite.emailSent,
      // Only present when the email did NOT go out — otherwise the link
      // lives only in the recipient's inbox, which is where an
      // account-takeover credential belongs.
      inviteLink: invite.emailSent ? null : invite.inviteLink,
      signInReady: invite.signInReady,
    });
  },
);

/**
 * Create a new tenant SHELL: the `organizations` row + its feature-flag
 * provisioning. The tenant's first ADMIN is created separately, via
 * `POST /platform/tenants/:id/admins` below (or the `tenant:onboard`
 * CLI) — two steps on purpose, so "make the org" and "hand someone the
 * keys to it" are distinct, separately-audited actions.
 */
router.post(
  "/platform/tenants",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = createTenantBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_tenant", details: parsed.error.flatten() });
      return;
    }
    const { slug, name } = parsed.data;

    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const raw = getOrgScopedClient(seedOrgId).raw();

    // Insert the org. The unique index on slug turns a duplicate into a
    // 23505 we translate to 409 (a friendlier signal than a 500).
    const { data: created, error: insErr } = await raw
      .schema("resupply")
      .from("organizations")
      .insert({ slug, name })
      .select(TENANT_SELECT)
      .limit(1)
      .maybeSingle();
    if (insErr) {
      if ((insErr as { code?: string }).code === "23505") {
        res.status(409).json({ error: "slug_already_exists" });
        return;
      }
      logger.error(
        { event: "platform_tenant_create_failed", err: insErr },
        "platform: tenant create failed",
      );
      res.status(500).json({ error: "tenant_create_failed" });
      return;
    }
    if (!created) {
      res.status(500).json({ error: "tenant_create_failed" });
      return;
    }
    const tenant = toTenantView(created as OrgRow);

    // Provision feature flags so the new tenant's admins can toggle
    // features. Best-effort: a flag-provisioning hiccup must NOT undo a
    // successfully-created org (the operator can re-run provisioning),
    // so we log and continue rather than 500 the create.
    let flagsProvisioned = 0;
    try {
      flagsProvisioned = await provisionTenantFeatureFlags(
        raw,
        seedOrgId,
        tenant.id,
      );
    } catch (err) {
      logger.warn(
        {
          event: "platform_tenant_flag_provision_failed",
          err,
          orgId: tenant.id,
        },
        "platform: tenant created but feature-flag provisioning failed",
      );
    }

    invalidateBrandingCache();
    await logAudit({
      action: "platform.tenant.created",
      adminEmail: req.platformAdminEmail ?? "platform-admin",
      adminUserId: req.platformAdminUserId ?? null,
      targetTable: "organizations",
      targetId: tenant.id,
      metadata: { slug, flagsProvisioned },
      ip: null,
      userAgent: null,
    }).catch((err) => {
      logger.warn({ err }, "platform: tenant create audit write failed");
    });

    res.status(201).json({ tenant, flagsProvisioned });
  },
);

// ── GET /platform/overview ──────────────────────────────────────────
// One-call fleet snapshot for the super-admin dashboard: every tenant
// plus its headline usage counts, so the "see all tenants" view loads
// without N per-tenant round-trips. AGGREGATE COUNTS ONLY — no patient
// PHI ever crosses this surface; a super-admin who needs a tenant's real
// records uses audited impersonation (act-as-tenant) instead.
//
// Fan-out is bounded by the number of tenants (a handful) and each count
// is a HEAD request (no rows returned). A per-tenant count failure
// degrades that tenant's number to null rather than failing the whole
// dashboard.
router.get(
  "/platform/overview",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (_req, res): Promise<void> => {
    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const { data, error } = await getOrgScopedClient(seedOrgId)
      .raw()
      .schema("resupply")
      .from("organizations")
      .select(TENANT_SELECT)
      .order("created_at", { ascending: true });
    if (error) {
      logger.error(
        { event: "platform_overview_list_failed", err: error },
        "platform: overview tenant list failed",
      );
      res.status(500).json({ error: "overview_failed" });
      return;
    }

    const tenants = await Promise.all(
      ((data ?? []) as OrgRow[]).map(async (o) => {
        const db = getOrgScopedClient(o.id);
        const usageEntries = await Promise.all(
          USAGE_COUNTS.map(async ([label, table]) => {
            try {
              const { count, error: countErr } = await db
                .from(table)
                .select("*", { count: "exact", head: true });
              if (countErr) throw countErr;
              return [label, count ?? 0] as const;
            } catch (err) {
              // Degrade this one metric to null; keep the rest. Log with
              // tenant + table context so a persistent null (RLS/grant
              // misconfig, PostgREST blip) is diagnosable, not invisible.
              logger.warn(
                {
                  event: "platform_overview_count_failed",
                  err,
                  orgId: o.id,
                  table,
                },
                "platform: overview per-tenant count failed; degrading to null",
              );
              return [label, null] as const;
            }
          }),
        );
        return {
          ...toTenantView(o),
          usage: Object.fromEntries(usageEntries) as Record<
            string,
            number | null
          >,
        };
      }),
    );

    res.json({ tenants, generatedAt: new Date().toISOString() });
  },
);
export default router;
