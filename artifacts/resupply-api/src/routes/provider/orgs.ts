// GET  /api/provider/orgs        — DME memberships for the signed-in provider
// POST /api/provider/orgs/select — pin active org on the session (platform host)
//
// GET works on the **platform host** (unlike /me and /queue before a pin).
// Returns active provider_dme_links with each tenant's verified portal base
// URL plus the session's activeOrgId / per-row isActive so the SPA can
// select-or-deep-link off cmbreathe.com.
//
// POST is CSRF-gated via requireProvider. Re-validates membership before
// writing sessions.provider_active_org_id (migration 0533). No PHI.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { getAuthDeps } from "../../lib/auth-deps";
import { logger } from "../../lib/logger";
import { resolveTenantLinkBaseUrl } from "../../lib/tenant-branding";
import { requireProvider } from "../../middlewares/requireProvider";
import { providerHasActiveDmeLink, providerPortalRateLimiter } from "./shared";

const router: IRouter = Router();

const selectBodySchema = z.object({
  orgId: z.string().uuid(),
});

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

      let activeOrgId: string | null = null;
      const sessionId = req.authSessionId;
      if (sessionId) {
        try {
          const session = await getAuthDeps().repo.findSessionById(sessionId);
          activeOrgId = session?.providerActiveOrgId ?? null;
        } catch (err) {
          logger.warn(
            {
              err: err instanceof Error ? err : new Error(String(err)),
              sessionId,
            },
            "provider orgs: active-org session lookup failed",
          );
        }
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
            isActive: activeOrgId != null && orgId === activeOrgId,
          };
        }),
      );

      res.json({ orgs, activeOrgId });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "provider orgs membership lookup failed",
      );
      res.status(500).json({ error: "query_failed" });
    }
  },
);

router.post(
  "/api/provider/orgs/select",
  providerPortalRateLimiter,
  ...requireProvider,
  async (req, res) => {
    const account = req.providerAccount;
    const sessionId = req.authSessionId;
    if (!account || !sessionId) {
      res.status(401).json({ error: "session_required" });
      return;
    }
    const parsed = selectBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const { orgId } = parsed.data;
    try {
      const ok = await providerHasActiveDmeLink(account.providerId, orgId);
      if (!ok) {
        res.status(403).json({
          error: "not_a_member",
          message: "You are not linked to that DME practice.",
        });
        return;
      }
      await getAuthDeps().repo.setProviderActiveOrgId(sessionId, orgId);
      res.json({ activeOrgId: orgId });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err : new Error(String(err)), orgId },
        "provider orgs select failed",
      );
      res.status(500).json({ error: "query_failed" });
    }
  },
);

export default router;
