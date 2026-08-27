import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveTenantLinkBaseUrlMock = vi.hoisted(() =>
  vi.fn<(orgId: string, platform: string) => Promise<string | null>>(
    async (_orgId, platform) => platform,
  ),
);

vi.mock("../tenant-branding.js", () => ({
  resolveTenantLinkBaseUrl: resolveTenantLinkBaseUrlMock,
}));

import {
  platformPublicBaseUrl,
  resolvePatientEmailLinkBase,
  TENANT_DOMAIN_REQUIRED,
  isPatientEmailClickBaseReady,
} from "./link-base";

describe("resolvePatientEmailLinkBase", () => {
  beforeEach(() => {
    resolveTenantLinkBaseUrlMock.mockReset();
    resolveTenantLinkBaseUrlMock.mockImplementation(
      async (_orgId: string, platform: string) => platform,
    );
    delete process.env.SHOP_PUBLIC_BASE_URL;
  });

  afterEach(() => {
    delete process.env.SHOP_PUBLIC_BASE_URL;
  });

  it("returns explicit override without calling tenant resolver", async () => {
    const base = await resolvePatientEmailLinkBase(
      "00000000-0000-4000-8000-000000000099",
      "https://override.example.com/",
    );
    expect(base).toBe("https://override.example.com");
    expect(resolveTenantLinkBaseUrlMock).not.toHaveBeenCalled();
  });

  it("returns platform env when orgId is unset", async () => {
    process.env.SHOP_PUBLIC_BASE_URL = "https://preview.example.com/";
    const base = await resolvePatientEmailLinkBase(undefined);
    expect(base).toBe("https://preview.example.com");
    expect(resolveTenantLinkBaseUrlMock).not.toHaveBeenCalled();
  });

  it("delegates to resolveTenantLinkBaseUrl when orgId is set", async () => {
    resolveTenantLinkBaseUrlMock.mockResolvedValueOnce(null);
    process.env.SHOP_PUBLIC_BASE_URL = "https://cmbreathe.com";
    const base = await resolvePatientEmailLinkBase(
      "00000000-0000-4000-8000-000000000099",
    );
    expect(base).toBeNull();
    expect(resolveTenantLinkBaseUrlMock).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000099",
      "https://cmbreathe.com",
    );
  });

  it("isPatientEmailClickBaseReady rejects blank origins", () => {
    expect(isPatientEmailClickBaseReady("https://acme.example")).toBe(true);
    expect(isPatientEmailClickBaseReady("")).toBe(false);
    expect(isPatientEmailClickBaseReady(undefined)).toBe(false);
  });

  it("exports tenant_domain_required sentinel", () => {
    expect(TENANT_DOMAIN_REQUIRED).toBe("tenant_domain_required");
  });

  it("platformPublicBaseUrl strips trailing slash", () => {
    expect(platformPublicBaseUrl("https://x.example/")).toBe(
      "https://x.example",
    );
  });
});
