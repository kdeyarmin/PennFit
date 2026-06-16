// tenant-branding resolver: "which tenant brand does THIS host get?".
//
//   1. A verified custom domain resolves to that tenant's brand.
//   2. An unknown / unverified host falls back to the platform brand.
//   3. A DB error degrades to the bundled DEFAULT_BRANDING (fail-soft).

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import {
  __resetTenantBrandingForTests,
  DEFAULT_BRANDING,
  isVerifiedCustomDomainOrigin,
  refreshVerifiedCustomDomains,
  resolveBrandingByHost,
} from "./tenant-branding";

const SEED_ROW = {
  name: "Penn Home Medical Supply",
  storefront_name: "PennPaps",
  tagline: "Your CPAP, made simple. Fit. Shop. Resupply.",
  logo_url: null,
};

const TENANT_ROW = {
  name: "Acme Home Medical",
  storefront_name: "AcmeSleep",
  tagline: "Sleep better with Acme.",
  logo_url: "https://cdn.example/acme-logo.png",
};

beforeEach(() => {
  supabaseMock.reset();
  __resetTenantBrandingForTests();
});

describe("resolveBrandingByHost", () => {
  it("returns the Penn tenant brand for pennpaps.com", async () => {
    stageSupabaseResponse("organizations", "select", { data: SEED_ROW });
    const b = await resolveBrandingByHost("pennpaps.com");
    expect(b.storefrontName).toBe("PennPaps");
    expect(b.legalName).toBe("Penn Home Medical Supply");
    expect(b.logoUrl).toBeNull();
  });

  it("returns the tenant brand for a verified custom domain", async () => {
    stageSupabaseResponse("organizations", "select", { data: TENANT_ROW });
    const b = await resolveBrandingByHost("shop.acme.com");
    expect(b.storefrontName).toBe("AcmeSleep");
    expect(b.legalName).toBe("Acme Home Medical");
    expect(b.logoUrl).toBe("https://cdn.example/acme-logo.png");
  });

  it("falls back to the platform brand when no verified tenant owns the host", async () => {
    stageSupabaseResponse("organizations", "select", { data: null });
    const b = await resolveBrandingByHost("unclaimed.example.com");
    expect(b.storefrontName).toBe("CareMetric Breathe");
  });

  it("falls back to storefront_name = legal name when tenant storefront_name is blank", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: { ...SEED_ROW, storefront_name: null },
    });
    const b = await resolveBrandingByHost("pennpaps.com");
    expect(b.storefrontName).toBe("Penn Home Medical Supply");
  });

  it("degrades to DEFAULT_BRANDING on a DB error (fail-soft)", async () => {
    stageSupabaseResponse("organizations", "select", {
      error: { message: "boom" },
    });
    const b = await resolveBrandingByHost("pennpaps.com");
    expect(b).toEqual(DEFAULT_BRANDING);
  });

  it("caches per host (a second call makes no new query)", async () => {
    stageSupabaseResponse("organizations", "select", { data: SEED_ROW });
    const first = await resolveBrandingByHost("pennpaps.com");
    // No second response staged — a cache miss would throw "no staged
    // response". The cached hit returns the same value.
    const second = await resolveBrandingByHost("pennpaps.com");
    expect(second).toEqual(first);
  });
});

describe("isVerifiedCustomDomainOrigin", () => {
  it("normalizes www origins when checking verified tenant domains", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ custom_domain: "pennpaps.com" }],
    });

    await refreshVerifiedCustomDomains();

    expect(isVerifiedCustomDomainOrigin("https://pennpaps.com")).toBe(true);
    expect(isVerifiedCustomDomainOrigin("https://www.pennpaps.com")).toBe(true);
  });

  it("does not allow the platform domain through the tenant dynamic CORS path", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ custom_domain: "pennpaps.com" }],
    });

    await refreshVerifiedCustomDomains();

    expect(isVerifiedCustomDomainOrigin("https://cmbreathe.com")).toBe(false);
  });
});
