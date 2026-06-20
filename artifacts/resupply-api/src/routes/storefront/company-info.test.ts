// GET /api/company-info — verifies the storefront identity payload, and in
// particular that the two assistant display names resolve for the tenant
// that owns the request host (the app_config `scope: "tenant"` keys), with a
// seed/default fallback when the host doesn't resolve to a tenant.

import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Seed-scoped company info (contact fields + the seed/default assistant
// names) — the route overlays per-tenant assistant names on top.
const getCompanyInfoMock = vi.hoisted(() =>
  vi.fn(async () => ({
    name: "Penn Home Medical Supply",
    supportPhoneE164: "+18005551212",
    supportPhoneDisplay: "(800) 555-1212",
    supportEmail: "support@pennpaps.com",
    generalEmail: "info@pennpaps.com",
    supportHours: "Mon–Fri 9–5",
    websiteUrl: "https://pennpaps.com",
    address: null,
    assistantStorefrontName: "PennBot",
    assistantAdminName: "PennPilot",
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
  resolveAssistantNamesForOrg: resolveAssistantNamesForOrgMock,
}));

const resolveOrgIdByHostMock = vi.hoisted(() =>
  vi.fn(async (_host: string): Promise<string | null> => null),
);
vi.mock("../../lib/tenant-branding.js", () => ({
  resolveOrgIdByHost: resolveOrgIdByHostMock,
}));

import companyInfoRouter from "./company-info";

function makeApp(): Express {
  const app = express();
  app.use(companyInfoRouter);
  return app;
}

beforeEach(() => {
  resolveOrgIdByHostMock.mockReset();
  resolveOrgIdByHostMock.mockResolvedValue(null);
  resolveAssistantNamesForOrgMock.mockClear();
});

describe("GET /company-info — per-tenant assistant names", () => {
  it("uses the host tenant's assistant names when the host resolves to an org", async () => {
    resolveOrgIdByHostMock.mockResolvedValueOnce("org-acme");
    const res = await request(makeApp()).get("/company-info");
    expect(res.status).toBe(200);
    expect(res.body.assistantStorefrontName).toBe("Acme Assistant");
    expect(res.body.assistantAdminName).toBe("Acme Copilot");
    expect(resolveAssistantNamesForOrgMock).toHaveBeenCalledWith("org-acme");
    // Contact fields still come from the (seed-scoped) company info.
    expect(res.body.name).toBe("Penn Home Medical Supply");
  });

  it("falls back to the seed/default assistant names when the host doesn't resolve", async () => {
    resolveOrgIdByHostMock.mockResolvedValueOnce(null);
    const res = await request(makeApp()).get("/company-info");
    expect(res.status).toBe(200);
    expect(res.body.assistantStorefrontName).toBe("PennBot");
    expect(res.body.assistantAdminName).toBe("PennPilot");
    // No per-tenant resolution attempted when there's no org.
    expect(resolveAssistantNamesForOrgMock).not.toHaveBeenCalled();
  });
});
