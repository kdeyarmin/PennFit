// GET /api/provider/orgs — DME memberships for the signed-in provider.
//
// Works on the **platform host** (unlike /me and /queue). Returns active
// provider_dme_links with each tenant's verified portal base URL so the SPA
// can deep-link off cmbreathe.com into the correct tenant portal.
//
// No PHI: org names + portal URLs only. Pending counts and patient lists
// stay on tenant-host routes that fail closed without a brand org.

import { Router, type IRouter } from "express";

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { getAuthDeps } from "../../lib/auth-deps";
import { logger } from "../../lib/logger";
import { resolveTenantLinkBaseUrl } from "../../lib/tenant-branding";
import { requireProvider } from "../../middlewares/requireProvider";
import { providerPortalRateLimiter } from "./shared";

const router: IRouter = Router();

router.get(
  "/api/provider/orgs",
  providerPortalRateLimiter,
  ...requireProvider,
  async (req, res) => {
    const account = req.providerAccount;
    if (!account) {
      res.status(401).json({ error: "session_required" });
      return;
    }
    try {
      const seedOrgId = await resolveSeedOrgId();
      if (!seedOrgId) {
        res.status(500).json({ error: "tenant_context_missing" });
        return;
      }
      // raw-org-scope-exempt: cross-tenant membership list keyed by the
      // session's provider_id (never from the request). Same pattern as
      // GET /api/provider/referrals/destinations — no PHI, only orgs that
      // explicitly linked this provider.
      const { data, error } = await getOrgScopedClient(seedOrgId)
        .raw()
        .schema("resupply")
        .from("provider_dme_links")
        .select("id, org_id, display_name, status, organizations(name)")
        .eq("provider_id", account.providerId)
        .eq("status", "active")
        .limit(200);
      if (error) {
        res.status(500).json({ error: "query_failed" });
        return;
      }

      const platformBase = getAuthDeps().publicBaseUrl;
      const rows = data ?? [];
      const orgs = await Promise.all(
        rows.map(async (row) => {
          const r = row as Record<string, unknown>;
          const orgId = String(r.org_id ?? "");
          const org = r.organizations as { name?: string } | null;
          const name =
            (r.display_name as string | null) ?? org?.name ?? "DME practice";
          const portalBaseUrl =
            orgId === ""
              ? null
              : await resolveTenantLinkBaseUrl(orgId, platformBase);
          const portalUrl = portalBaseUrl
            ? `${portalBaseUrl.replace(/\/$/, "")}/provider`
            : null;
          return {
            orgId,
            dmeLinkId: String(r.id),
            name,
            portalBaseUrl,
            portalUrl,
            hasVerifiedPortal: portalUrl != null,
          };
        }),
      );

      res.json({ orgs });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "provider orgs membership lookup failed",
      );
      res.status(500).json({ error: "query_failed" });
    }
  },
);

export default router;
