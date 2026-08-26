// GET /api/company-info — verifies the storefront identity payload, and in
// particular that the two assistant display names resolve for the tenant
// that owns the request host, with a PLATFORM fallback when the host does
// not map to a verified tenant (never the seed org — that was the brand
// leak on cmbreathe.com).

import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

const getCompanyInfoMock = vi.hoisted(() =>
  vi.fn(async () => ({
    name: "Acme DME",
    legalName: "Acme DME LLC",
    supportPhoneE164: "+18005551212",
    supportPhoneDisplay: "(800) 555-1212",
    supportEmail: "support@acme.example",
    generalEmail: "info@acme.example",
    supportHours: "Mon–Fri 9–5",
    websiteUrl: "https://acme.example",
    address: null,
    assistantStorefrontName: "AcmeBot",
    assistantAdminName: "AcmePilot",
  })),
);
const getPlatformIdentityMock = vi.hoisted(() =>
  vi.fn(() => ({
    name: "CareMetric Breathe",
    legalName: "CareMetric Breathe",
    supportPhoneE164: "+18005550000",
    supportPhoneDisplay: "(800) 555-0000",
    supportEmail: "support@cmbreathe.com",
    generalEmail: "noreply@cmbreathe.com",
    supportHours: "Mon–Fri 9–5 ET",
    websiteUrl: "https://cmbreathe.com",
    address: null,
    assistantStorefrontName: "CareMetric Assistant",
    assistantAdminName: "CareMetric Copilot",
  })),
);
const resolveAssistantNamesForOrgMock = vi.hoisted(() =>
  vi.fn(async (_orgId: string) => ({
    assistantStorefrontName: "Acme Assistant",
    assistantAdminName: "Acme Copilot",
  })),
);
vi.mock("../../lib/company-info", () => ({
  getCompanyInfo: getCompanyInfoMock,
  getPlatformIdentity: getPlatformIdentityMock,
  PLATFORM_NAME: "CareMetric Breathe",
  resolveAssistantNamesForOrg: resolveAssistantNamesForOrgMock,
}));

const resolveBrandOrgIdByHostMock = vi.hoisted(() =>
  vi.fn(async (_host: string): Promise<string | null> => null),
);
const resolveBrandingByHostMock = vi.hoisted(() =>
  vi.fn(async (_host: string) => ({
    storefrontName: "CareMetric Breathe",
    legalName: "CareMetric Breathe",
    tagline: "The CPAP resupply platform for modern DME teams.",
    logoUrl: null as string | null,
  })),
);
const resolveTenantBaseUrlMock = vi.hoisted(() =>
  vi.fn(async (_orgId: string): Promise<string | null> => null),
);
vi.mock("../../lib/tenant-branding.js", () => ({
  resolveBrandOrgIdByHost: resolveBrandOrgIdByHostMock,
  resolveBrandingByHost: resolveBrandingByHostMock,
  resolveTenantBaseUrl: resolveTenantBaseUrlMock,
}));
const resolveTenantSenderMock = vi.hoisted(() =>
  vi.fn(async (_orgId: string | undefined) => ({}) as { fromEmail?: string }),
);
vi.mock("../../lib/email/tenant-sender.js", () => ({
  resolveTenantSender: resolveTenantSenderMock,
}));

import companyInfoRouter from "./company-info";

function makeApp(): Express {
  const app = express();
  app.use(companyInfoRouter);
  return app;
}

beforeEach(() => {
  resolveBrandOrgIdByHostMock.mockReset();
  resolveBrandOrgIdByHostMock.mockResolvedValue(null);
  resolveBrandingByHostMock.mockReset();
  resolveBrandingByHostMock.mockResolvedValue({
    storefrontName: "CareMetric Breathe",
    legalName: "CareMetric Breathe",
    tagline: "The CPAP resupply platform for modern DME teams.",
    logoUrl: null,
  });
  resolveTenantBaseUrlMock.mockReset();
  resolveTenantBaseUrlMock.mockResolvedValue(null);
  resolveTenantSenderMock.mockReset();
  resolveTenantSenderMock.mockResolvedValue({});
  resolveAssistantNamesForOrgMock.mockClear();
  getCompanyInfoMock.mockClear();
  getCompanyInfoMock.mockResolvedValue({
    name: "Acme DME",
    legalName: "Acme DME LLC",
    supportPhoneE164: "+18005551212",
    supportPhoneDisplay: "(800) 555-1212",
    supportEmail: "support@acme.example",
    generalEmail: "info@acme.example",
    supportHours: "Mon–Fri 9–5",
    websiteUrl: "https://acme.example",
    address: null,
    assistantStorefrontName: "AcmeBot",
    assistantAdminName: "AcmePilot",
  });
  getPlatformIdentityMock.mockClear();
});

describe("GET /company-info — per-tenant assistant names", () => {
  it("uses the host tenant's identity when the host maps to a brand org", async () => {
    resolveBrandOrgIdByHostMock.mockResolvedValueOnce("org-acme");
    const res = await request(makeApp()).get("/company-info");
    expect(res.status).toBe(200);
    expect(res.body.assistantStorefrontName).toBe("Acme Assistant");
    expect(res.body.assistantAdminName).toBe("Acme Copilot");
    expect(resolveAssistantNamesForOrgMock).toHaveBeenCalledWith("org-acme");
    expect(getCompanyInfoMock).toHaveBeenCalledWith("org-acme");
    expect(res.body.name).toBe("Acme DME");
  });

  it("falls back to the platform identity when the host has no brand org", async () => {
    resolveBrandOrgIdByHostMock.mockResolvedValueOnce(null);
    const res = await request(makeApp()).get("/company-info");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("CareMetric Breathe");
    expect(res.body.assistantStorefrontName).toBe("CareMetric Assistant");
    expect(res.body.assistantAdminName).toBe("CareMetric Copilot");
    expect(getPlatformIdentityMock).toHaveBeenCalled();
    expect(getCompanyInfoMock).not.toHaveBeenCalled();
    expect(resolveAssistantNamesForOrgMock).not.toHaveBeenCalled();
  });

  it("overlays host branding when company-info still has the platform name", async () => {
    // Live pennpaps.com regression: getCompanyInfo returned CareMetric
    // (dme_organization left at platform defaults / org-id branding cache
    // poisoned) while storefront-branding correctly read Penn from the
    // host → organizations path.
    resolveBrandOrgIdByHostMock.mockResolvedValueOnce("org-penn");
    getCompanyInfoMock.mockResolvedValueOnce({
      name: "CareMetric Breathe",
      legalName: "CareMetric Breathe",
      supportPhoneE164: "",
      supportPhoneDisplay: "",
      supportEmail: "support@cmbreathe.com",
      generalEmail: "support@cmbreathe.com",
      supportHours: "Mon–Fri 9a–5p ET",
      websiteUrl: "https://cmbreathe.com",
      address: null,
      assistantStorefrontName: "PennBot",
      assistantAdminName: "PennPilot",
    });
    resolveBrandingByHostMock.mockResolvedValueOnce({
      storefrontName: "Penn Home Medical Supply",
      legalName: "Penn Home Medical Supply",
      tagline: "Your CPAP, made simple. Fit. Order. Resupply.",
      logoUrl: "/penn/pennpaps-logo.jpeg",
    });
    resolveTenantBaseUrlMock.mockResolvedValueOnce("https://pennpaps.com");
    resolveTenantSenderMock.mockResolvedValueOnce({
      fromEmail: "info@pennpaps.com",
    });
    resolveAssistantNamesForOrgMock.mockResolvedValueOnce({
      assistantStorefrontName: "PennBot",
      assistantAdminName: "PennPilot",
    });

    const res = await request(makeApp())
      .get("/company-info")
      .set("Host", "pennpaps.com");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Penn Home Medical Supply");
    expect(res.body.legalName).toBe("Penn Home Medical Supply");
    expect(res.body.websiteUrl).toBe("https://pennpaps.com");
    expect(res.body.supportEmail).toBe("info@pennpaps.com");
    expect(res.body.assistantStorefrontName).toBe("PennBot");
    expect(resolveBrandingByHostMock).toHaveBeenCalled();
    expect(res.headers["cache-control"]).toMatch(/max-age=60/);
  });

  it("overlays host branding when company-info name disagrees for any reason", async () => {
    // Broader than platform-equality: if the logo says Penn, the footer
    // must not keep a stale leftover name even when it isn't exactly
    // PLATFORM_NAME (typo / partial rebrand / env drift).
    resolveBrandOrgIdByHostMock.mockResolvedValueOnce("org-penn");
    getCompanyInfoMock.mockResolvedValueOnce({
      name: "CareMetric",
      legalName: "CareMetric",
      supportPhoneE164: "",
      supportPhoneDisplay: "",
      supportEmail: "support@cmbreathe.com",
      generalEmail: "support@cmbreathe.com",
      supportHours: "Mon–Fri 9a–5p ET",
      websiteUrl: "https://cmbreathe.com",
      address: null,
      assistantStorefrontName: "PennBot",
      assistantAdminName: "PennPilot",
    });
    resolveBrandingByHostMock.mockResolvedValueOnce({
      storefrontName: "Penn Home Medical Supply",
      legalName: "Penn Home Medical Supply",
      tagline: "Your CPAP, made simple.",
      logoUrl: "/penn/pennpaps-logo.jpeg",
    });
    resolveTenantBaseUrlMock.mockResolvedValueOnce("https://pennpaps.com");
    resolveTenantSenderMock.mockResolvedValueOnce({
      fromEmail: "info@pennpaps.com",
    });
    resolveAssistantNamesForOrgMock.mockResolvedValueOnce({
      assistantStorefrontName: "PennBot",
      assistantAdminName: "PennPilot",
    });

    const res = await request(makeApp())
      .get("/company-info")
      .set("Host", "pennpaps.com");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Penn Home Medical Supply");
    expect(res.body.supportEmail).toBe("info@pennpaps.com");
  });
});
