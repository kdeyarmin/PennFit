// Behavior of the patient auth-email brand resolver.
//
// Drives the exported resolver directly with a fake request and a stubbed
// host→branding lookup, so these assert what it DOES — which host produces
// which brand, and that a host belonging to no tenant can never borrow one.

import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const PLATFORM_BRANDING = {
  storefrontName: "CareMetric Breathe",
  legalName: "CareMetric Breathe",
  tagline: "The CPAP resupply platform for modern DME teams.",
  logoUrl: null as string | null,
};

const resolveBrandingByHostMock = vi.hoisted(() =>
  vi.fn(async (_host: string | undefined) => ({
    storefrontName: "CareMetric Breathe",
    legalName: "CareMetric Breathe",
    tagline: "The CPAP resupply platform for modern DME teams.",
    logoUrl: null as string | null,
  })),
);
// Guard against the resolver reaching for the DATA resolver instead: that one
// answers unmatched hosts with the SEED org, which would leak the seed
// tenant's brand into platform-host auth mail.
const resolveOrgIdByHostMock = vi.hoisted(() => vi.fn());
const resolveBrandingByOrgIdMock = vi.hoisted(() => vi.fn());
vi.mock("./tenant-branding", () => ({
  resolveBrandingByHost: resolveBrandingByHostMock,
  resolveOrgIdByHost: resolveOrgIdByHostMock,
  resolveBrandingByOrgId: resolveBrandingByOrgIdMock,
}));

import { storefrontAuthBrandResolver } from "./auth-email-brand";

function reqForHost(host: string): Request {
  return { headers: { host }, hostname: host } as unknown as Request;
}

beforeEach(() => {
  resolveBrandingByHostMock.mockReset();
  resolveBrandingByHostMock.mockResolvedValue({ ...PLATFORM_BRANDING });
  resolveOrgIdByHostMock.mockReset();
  resolveOrgIdByHostMock.mockResolvedValue("org-seed-penn");
  resolveBrandingByOrgIdMock.mockReset();
  resolveBrandingByOrgIdMock.mockResolvedValue({
    storefrontName: "Penn Home Medical Supply",
    legalName: "Penn Home Medical Supply",
    tagline: "t",
    logoUrl: null,
  });
});

describe("storefrontAuthBrandResolver", () => {
  it("returns the tenant's storefront brand for a host that resolves to one", async () => {
    resolveBrandingByHostMock.mockResolvedValue({
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
    expect(resolveBrandingByHostMock).toHaveBeenCalledWith("pennpaps.com");
  });

  it("carries a storefront name distinct from the legal entity", async () => {
    // A tenant that trades under a DBA signs with its registered name.
    resolveBrandingByHostMock.mockResolvedValue({
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

  it("gives the platform brand — never a tenant's — on a host that owns none", async () => {
    // THE regression this file exists for. Routing this through
    // `resolveOrgIdByHost` looked equivalent but is not: that resolver
    // answers the platform host, an unbound domain, AND any lookup error
    // with the SEED org, so auth mail sent from cmbreathe.com would have
    // gone out branded as the seed tenant. `resolveBrandingByHost` answers
    // all three with the platform brand.
    resolveBrandingByHostMock.mockResolvedValue({ ...PLATFORM_BRANDING });

    await expect(
      storefrontAuthBrandResolver(reqForHost("cmbreathe.com")),
    ).resolves.toEqual({
      productName: "CareMetric Breathe",
      signatureName: "CareMetric Breathe",
    });
  });

  it("never consults the data resolver, whose fallback is the seed tenant", async () => {
    // A structural assertion, because the mistake is invisible in the
    // output: on THIS deployment the seed org is Penn, so a reviewer
    // eyeballing pennpaps.com sees the right answer either way.
    await storefrontAuthBrandResolver(reqForHost("cmbreathe.com"));
    expect(resolveOrgIdByHostMock).not.toHaveBeenCalled();
    expect(resolveBrandingByOrgIdMock).not.toHaveBeenCalled();
  });
});
