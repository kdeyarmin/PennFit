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
  resolveAssistantNamesForOrg: resolveAssistantNamesForOrgMock,
}));

const resolveBrandOrgIdByHostMock = vi.hoisted(() =>
  vi.fn(async (_host: string): Promise<string | null> => null),
);
vi.mock("../../lib/tenant-branding.js", () => ({
  resolveBrandOrgIdByHost: resolveBrandOrgIdByHostMock,
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
  resolveAssistantNamesForOrgMock.mockClear();
  getCompanyInfoMock.mockClear();
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
});
