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
  const orgId = (await resolveBrandOrgIdByHost(host)) ?? undefined;
  let info = orgId ? await getCompanyInfo(orgId) : getPlatformIdentity();

  // Defense in depth: storefront-branding resolves the tenant name via
  // the host → organizations directory path, which is what patients see
  // in the header/logo. When Company Information still carries the
  // platform default name (rebrand leftover / empty admin save), prefer
  // that same host branding so the footer cannot say "CareMetric Breathe"
  // while the logo says the tenant. getCompanyInfo already overlays via
  // resolveBrandingByOrgId; this catches the case where the org-id
  // branding cache was poisoned with the platform default on a transient
  // miss while the host cache stayed correct.
  if (orgId && info.name === PLATFORM_NAME) {
    const branding = await resolveBrandingByHost(host);
    if (branding.storefrontName.trim() !== PLATFORM_NAME) {
      const [tenantBase, sender] = await Promise.all([
        resolveTenantBaseUrl(orgId),
        resolveTenantSender(orgId),
      ]);
      const tenantEmail = sender.fromEmail?.trim() || null;
      const useEmail =
        !!tenantEmail && info.supportEmail === PLATFORM_SUPPORT_EMAIL;
      info = {
        ...info,
        name: branding.storefrontName.trim(),
        legalName: branding.legalName.trim() || branding.storefrontName.trim(),
        websiteUrl: tenantBase || info.websiteUrl,
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
