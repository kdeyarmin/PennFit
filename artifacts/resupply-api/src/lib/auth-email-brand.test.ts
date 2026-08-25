// Behavior of the patient auth-email brand resolver.
//
// Drives the exported resolver directly with a fake request and stubbed
// tenant lookups, so these assert what it DOES — which brand a given host
// produces, and that a failing lookup can't take the email down with it.

import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveOrgIdByHostMock = vi.hoisted(() =>
  vi.fn(async (_host: string | undefined): Promise<string | null> => null),
);
const resolveBrandingByOrgIdMock = vi.hoisted(() =>
  vi.fn(async (_orgId: string | undefined) => ({
    storefrontName: "CareMetric Breathe",
    legalName: "CareMetric Breathe",
    tagline: "t",
    logoUrl: null as string | null,
  })),
);
vi.mock("./tenant-branding", () => ({
  resolveOrgIdByHost: resolveOrgIdByHostMock,
  resolveBrandingByOrgId: resolveBrandingByOrgIdMock,
}));

import { storefrontAuthBrandResolver } from "./auth-email-brand";

function reqForHost(host: string): Request {
  return { headers: { host }, hostname: host } as unknown as Request;
}

beforeEach(() => {
  resolveOrgIdByHostMock.mockReset();
  resolveOrgIdByHostMock.mockResolvedValue(null);
  resolveBrandingByOrgIdMock.mockReset();
  resolveBrandingByOrgIdMock.mockResolvedValue({
    storefrontName: "CareMetric Breathe",
    legalName: "CareMetric Breathe",
    tagline: "t",
    logoUrl: null,
  });
});

describe("storefrontAuthBrandResolver", () => {
  it("returns the tenant's storefront brand for a host that resolves to one", async () => {
    resolveOrgIdByHostMock.mockResolvedValue("org-penn");
    resolveBrandingByOrgIdMock.mockResolvedValue({
      storefrontName: "Penn Home Medical Supply",
      legalName: "Penn Home Medical Supply",
      tagline: "t",
      logoUrl: null,
    });

    await expect(
      storefrontAuthBrandResolver(reqForHost("pennpaps.com")),
    ).resolves.toEqual({
      productName: "Penn Home Medical Supply",
      signatureName: "Penn Home Medical Supply",
    });
    // Resolved from the REQUEST's host, not a constant.
    expect(resolveOrgIdByHostMock).toHaveBeenCalledWith("pennpaps.com");
    expect(resolveBrandingByOrgIdMock).toHaveBeenCalledWith("org-penn");
  });

  it("carries a storefront name distinct from the legal entity", async () => {
    // A tenant that trades under a DBA signs with its registered name.
    resolveOrgIdByHostMock.mockResolvedValue("org-acme");
    resolveBrandingByOrgIdMock.mockResolvedValue({
      storefrontName: "Acme Sleep",
      legalName: "Acme Home Medical LLC",
      tagline: "t",
      logoUrl: null,
    });

    await expect(
      storefrontAuthBrandResolver(reqForHost("acme.example")),
    ).resolves.toEqual({
      productName: "Acme Sleep",
      signatureName: "Acme Home Medical LLC",
    });
  });

  it("defers to the mount's platform default when the host names no tenant", async () => {
    // The platform's own site, or a domain nobody has bound. `null` tells the
    // auth router to keep its configured name rather than invent one.
    resolveOrgIdByHostMock.mockResolvedValue(null);

    await expect(
      storefrontAuthBrandResolver(reqForHost("cmbreathe.com")),
    ).resolves.toBeNull();
    expect(resolveBrandingByOrgIdMock).not.toHaveBeenCalled();
  });

  it("propagates a lookup failure for the router to absorb", async () => {
    // The resolvers fail soft on their own, but if one ever throws, the
    // rejection has to reach the router's guard rather than being swallowed
    // into a blank brand here — a blank wordmark would ship an unbranded
    // email, which is worse than falling back to the platform name.
    resolveOrgIdByHostMock.mockRejectedValue(new Error("supabase down"));

    await expect(
      storefrontAuthBrandResolver(reqForHost("pennpaps.com")),
    ).rejects.toThrow("supabase down");
  });
});
