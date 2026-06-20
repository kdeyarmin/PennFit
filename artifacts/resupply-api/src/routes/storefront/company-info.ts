// GET /api/company-info — public company identity for the storefront.
//
// Feeds the SPA's footer contact column, floating chat launcher, and
// "call us" links so the values an admin saves on the Company
// information page reach the customer-facing site without a frontend
// redeploy. Strictly public business identity — never identifiers like
// the tax id, PTAN, or any patient data. Served from the process-level
// company-info cache plus an edge/browser Cache-Control, so it adds no
// per-page DB load.

import { Router, type IRouter } from "express";

import {
  getCompanyInfo,
  resolveAssistantNamesForOrg,
} from "../../lib/company-info";
import { resolveOrgIdByHost } from "../../lib/tenant-branding.js";
import { requestHost } from "../../lib/request-host.js";

const router: IRouter = Router();

router.get("/company-info", async (req, res) => {
  // Resolve the tenant that owns THIS host so the storefront shows its own
  // contact identity + assistant name (both are per-tenant), not the seed
  // org's. A NULL/unresolved host falls back to the seed/default identity, so
  // the single-tenant deployment is unchanged. Fail-soft: the resolver never
  // throws.
  const orgId = (await resolveOrgIdByHost(requestHost(req))) ?? undefined;
  const info = await getCompanyInfo(orgId);
  const assistantNames = orgId
    ? await resolveAssistantNamesForOrg(orgId)
    : {
        assistantStorefrontName: info.assistantStorefrontName,
        assistantAdminName: info.assistantAdminName,
      };
  // Cacheable for 5 min. The response now varies by host (assistant names
  // resolve per tenant), which the Cloudflare edge keys on already — each
  // tenant's custom domain is a distinct cache scope, so `public` stays
  // correct per-tenant.
  res.set("Cache-Control", "public, max-age=300");
  res.json({
    name: info.name,
    // Registered legal name — the storefront legal pages ("operated by …")
    // render this per-tenant rather than hardcoding the seed tenant's.
    legalName: info.legalName,
    phoneE164: info.supportPhoneE164,
    phoneDisplay: info.supportPhoneDisplay,
    supportEmail: info.supportEmail,
    generalEmail: info.generalEmail,
    supportHours: info.supportHours,
    websiteUrl: info.websiteUrl,
    address: info.address,
    assistantStorefrontName: assistantNames.assistantStorefrontName,
    assistantAdminName: assistantNames.assistantAdminName,
  });
});

export default router;
