// tenant-branding resolver: "which tenant brand does THIS host get?".
//
//   1. A verified custom domain resolves to that tenant's brand.
//   2. An unknown / unverified host falls back to the seed tenant brand.
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
  it("returns the seed brand for the platform / unknown host", async () => {
    stageSupabaseResponse("organizations", "select", { data: SEED_ROW });
    const b = await resolveBrandingByHost("pennfit.up.railway.app");
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

  it("falls back to the seed brand when no verified tenant owns the host", async () => {
    // First select (host lookup) misses; second select loads the seed.
    stageSupabaseResponse("organizations", "select", { data: null });
    stageSupabaseResponse("organizations", "select", { data: SEED_ROW });
    const b = await resolveBrandingByHost("unclaimed.example.com");
    expect(b.storefrontName).toBe("PennPaps");
  });

  it("falls back to storefront_name = legal name when storefront_name is blank", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: { ...SEED_ROW, storefront_name: null },
    });
    const b = await resolveBrandingByHost("");
    expect(b.storefrontName).toBe("Penn Home Medical Supply");
  });

  it("degrades to DEFAULT_BRANDING on a DB error (fail-soft)", async () => {
    stageSupabaseResponse("organizations", "select", {
      error: { message: "boom" },
    });
    const b = await resolveBrandingByHost("");
    expect(b).toEqual(DEFAULT_BRANDING);
  });

  it("caches per host (a second call makes no new query)", async () => {
    stageSupabaseResponse("organizations", "select", { data: SEED_ROW });
    const first = await resolveBrandingByHost("pennfit.up.railway.app");
    // No second response staged — a cache miss would throw "no staged
    // response". The cached hit returns the same value.
    const second = await resolveBrandingByHost("pennfit.up.railway.app");
    expect(second).toEqual(first);
  });
});
