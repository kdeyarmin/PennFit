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
  const info = await getCompanyInfo();
  // Resolve the storefront's assistant name for the tenant that owns THIS
  // host (the two assistant-name keys are app_config `scope: "tenant"`),
  // not the seed org's — so a second tenant's storefront shows its own bot
  // name. `getCompanyInfo()` is still seed-scoped for the contact fields;
  // a NULL/unresolved host falls back to the seed/default names (the
  // single-tenant deployment is unchanged). Fail-soft: the resolver never
  // throws.
  const orgId = (await resolveOrgIdByHost(requestHost(req))) ?? undefined;
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
