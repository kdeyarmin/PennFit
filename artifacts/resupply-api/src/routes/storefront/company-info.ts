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
  PLATFORM_NAME,
  resolveAssistantNamesForOrg,
} from "../../lib/company-info";
import {
  resolveBrandOrgIdByHost,
  resolveBrandingByHost,
  resolveTenantBaseUrl,
} from "../../lib/tenant-branding.js";
import { resolveTenantSender } from "../../lib/email/tenant-sender.js";
import { requestHost } from "../../lib/request-host.js";

const PLATFORM_SUPPORT_EMAIL = "support@cmbreathe.com";

const router: IRouter = Router();

router.get("/company-info", async (req, res) => {
  // Branding resolver — NOT resolveOrgIdByHost. The data-plane resolver
  // fails soft to the seed (Penn) org on the platform host / unbound
  // domains; that leaked the seed tenant's phone/email/name onto
  // cmbreathe.com. Auth email already avoids this via
  // resolveBrandingByHost; company-info must match that contract.
  const host = requestHost(req);
  // Resolve host branding FIRST — same path as GET /api/storefront-branding
  // — so the footer/chat identity cannot drift from the logo even when
  // getCompanyInfo still carries CareMetric leftovers in dme_organization.
  const branding = await resolveBrandingByHost(host);
  const orgId = (await resolveBrandOrgIdByHost(host)) ?? undefined;
  let info = orgId ? await getCompanyInfo(orgId) : getPlatformIdentity();

  const hostName = branding.storefrontName.trim();
  if (orgId && hostName && hostName !== PLATFORM_NAME) {
    const needsName = info.name.trim() !== hostName;
    const needsEmail = info.supportEmail.trim() === PLATFORM_SUPPORT_EMAIL;
    if (needsName || needsEmail) {
      const [tenantBase, sender] = await Promise.all([
        resolveTenantBaseUrl(orgId),
        resolveTenantSender(orgId),
      ]);
      const tenantEmail = sender.fromEmail?.trim() || null;
      const useEmail = needsEmail && !!tenantEmail;
      info = {
        ...info,
        ...(needsName
          ? {
              name: hostName,
              legalName: branding.legalName.trim() || hostName,
              websiteUrl: tenantBase || info.websiteUrl,
            }
          : {}),
        ...(useEmail
          ? {
              supportEmail: tenantEmail,
              generalEmail: tenantEmail,
              billingEmail: tenantEmail,
            }
          : {}),
      };
    }
  }

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
  // Short TTL: brand overlays must show up quickly after an admin save or
  // a deploy that fixes host/company-info drift. storefront-branding keeps
  // its own cache; keeping these aligned matters more than edge hit rate.
  res.set("Cache-Control", "public, max-age=60, must-revalidate");
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
