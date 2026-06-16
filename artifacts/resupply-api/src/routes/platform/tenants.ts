// Platform super-admin: tenant directory (G4).
//
// GET /resupply-api/platform/tenants — list every tenant (organization)
// on the platform with its status and custom-domain binding. This is the
// first cross-tenant, platform-operator surface; it is gated by
// `requirePlatformAdmin` (the tier ABOVE a tenant admin) and reads the
// GLOBAL `organizations` directory via `.raw()`.
//
// PII posture: organizations rows are tenant metadata (slug, brand name,
// domain) — no patient data — so the list is safe to return whole.

import { Router, type IRouter } from "express";

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requirePlatformAdmin } from "../../middlewares/requirePlatformAdmin";

const router: IRouter = Router();

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

router.get(
  "/platform/tenants",
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
      .select(
        "id, slug, name, storefront_name, status, custom_domain, custom_domain_status, created_at",
      )
      .order("created_at", { ascending: true });
    if (error) {
      logger.error(
        { event: "platform_tenants_list_failed", err: error },
        "platform: tenant list query failed",
      );
      res.status(500).json({ error: "tenant_list_failed" });
      return;
    }

    const tenants = ((data ?? []) as OrgRow[]).map((o) => ({
      id: o.id,
      slug: o.slug,
      name: o.name,
      storefrontName: o.storefront_name,
      status: o.status,
      customDomain: o.custom_domain,
      customDomainStatus: o.custom_domain_status,
      createdAt: o.created_at,
    }));
    res.json({ tenants });
  },
);

export default router;
