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
  getPlatformIdentity,
  resolveAssistantNamesForOrg,
} from "../../lib/company-info";
import { resolveBrandOrgIdByHost } from "../../lib/tenant-branding.js";
import { requestHost } from "../../lib/request-host.js";

const router: IRouter = Router();

router.get("/company-info", async (req, res) => {
  // Branding resolver — NOT resolveOrgIdByHost. The data-plane resolver
  // fails soft to the seed (Penn) org on the platform host / unbound
  // domains; that leaked the seed tenant's phone/email/name onto
  // cmbreathe.com. Auth email already avoids this via
  // resolveBrandingByHost; company-info must match that contract.
  const orgId =
    (await resolveBrandOrgIdByHost(requestHost(req))) ?? undefined;
  const info = orgId ? await getCompanyInfo(orgId) : getPlatformIdentity();
  const assistantNames = orgId
    ? await resolveAssistantNamesForOrg(orgId)
    : {
        assistantStorefrontName: info.assistantStorefrontName,
        assistantAdminName: info.assistantAdminName,
      };
  // Cacheable for 5 min, but the body varies by HOST (tenant identity +
  // assistant names resolve from the brand host). A shared/edge cache
  // keyed only on the URL path would serve one tenant's contact info to
  // another tenant's storefront. `Vary` makes any conformant cache key on
  // the host — byte-for-byte matching storefront-branding.ts.
  res.set("Vary", "X-Forwarded-Host, Host");
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
