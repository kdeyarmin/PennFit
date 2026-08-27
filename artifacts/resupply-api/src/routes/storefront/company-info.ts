// GET /api/company-info — public company identity for the storefront.
//
// Feeds the SPA's footer contact column, floating chat launcher, and
// "call us" links so the values an admin saves on the Company
// information page reach the customer-facing site without a frontend
// redeploy. Strictly public business identity — never identifiers like
// the tax id, PTAN, or any patient data.
//
// Also mounted at GET /api/storefront-company-info (same handler). The
// SPA reads that path so Host-keyed edge caches that pinned a stale
// CareMetric body on /company-info cannot keep serving it after the
// host-brand overlay fix. Keep /company-info for older clients.

import { Router, type IRouter, type Request, type Response } from "express";

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

async function handleCompanyInfo(req: Request, res: Response): Promise<void> {
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
    const [tenantBase, sender] = await Promise.all([
      resolveTenantBaseUrl(orgId),
      resolveTenantSender(orgId),
    ]);
    const needsName = info.name.trim() !== hostName;
    const needsEmail = info.supportEmail.trim() === PLATFORM_SUPPORT_EMAIL;
    const tenantWebsite = tenantBase?.replace(/\/+$/, "") ?? "";
    const currentWebsite = info.websiteUrl?.replace(/\/+$/, "") ?? "";
    const needsWebsite =
      tenantWebsite.length > 0 && currentWebsite !== tenantWebsite;
    if (needsName || needsEmail || needsWebsite) {
      const tenantEmail = sender.fromEmail?.trim() || null;
      const useEmail = needsEmail && !!tenantEmail;
      info = {
        ...info,
        ...(needsName
          ? {
              name: hostName,
              legalName: branding.legalName.trim() || hostName,
            }
          : {}),
        ...(needsWebsite ? { websiteUrl: tenantWebsite } : {}),
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
  // Body varies by host (tenant identity + assistant names). `Vary` keeps
  // shared caches from serving one tenant's contact info to another.
  //
  // `private, no-store` (+ CDN-Cache-Control): Railway Hikari kept serving a
  // stale Host-keyed CareMetric body for pennpaps.com after deploys that
  // fixed the overlay (identical etag / max-age=300). Brand identity must
  // not lag a deploy or an admin save behind an edge TTL.
  res.set("Vary", "X-Forwarded-Host, Host");
  res.set("Cache-Control", "private, no-store");
  res.set("CDN-Cache-Control", "no-store");
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
}

router.get("/company-info", handleCompanyInfo);
router.get("/storefront-company-info", handleCompanyInfo);

export default router;
