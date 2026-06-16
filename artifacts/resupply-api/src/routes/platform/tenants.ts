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
import {
  getOrgScopedClient,
  resolveSeedOrgId,
  SEED_ORG_SLUG,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { invalidateBrandingCache } from "../../lib/tenant-branding";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePlatformAdmin } from "../../middlewares/requirePlatformAdmin";

const router: IRouter = Router();

const TENANT_SELECT =
  "id, slug, name, storefront_name, status, custom_domain, custom_domain_status, created_at";

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

const tenantIdParam = z.object({ id: z.string().uuid() });

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

export default router;
