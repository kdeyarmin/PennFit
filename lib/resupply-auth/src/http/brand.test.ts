// The fail-soft contract for per-request auth-email branding.
//
// These two emails are the ONLY way a patient completes a sign-up or gets
// back into a locked account, so the branding lookup must be incapable of
// stopping the send. Every degraded path below has to land on the mount's
// static name — never throw, never yield a blank wordmark.

import type { Request } from "express";
import { describe, expect, it } from "vitest";

import { resolveAuthEmailBrand, type AuthBrandOptions } from "./brand";

const REQ = { headers: {}, hostname: "acme.example" } as unknown as Request;

const PLATFORM: AuthBrandOptions = {
  productName: "CareMetric Breathe",
  signatureName: "CareMetric Breathe",
};

describe("resolveAuthEmailBrand", () => {
  it("uses the mount's static name when no resolver is configured", async () => {
    // The platform's own mounts (staff console, platform sign-up) pass no
    // resolver — the static name IS the right answer there.
    await expect(resolveAuthEmailBrand(PLATFORM, REQ)).resolves.toEqual({
      productName: "CareMetric Breathe",
      signatureName: "CareMetric Breathe",
    });
  });

  it("uses the resolved tenant brand when the host names one", async () => {
    const brand = await resolveAuthEmailBrand(
      {
        ...PLATFORM,
        resolveBrand: () => ({
          productName: "Penn Home Medical Supply",
          signatureName: "Penn Home Medical Supply",
        }),
      },
      REQ,
    );
    expect(brand).toEqual({
      productName: "Penn Home Medical Supply",
      signatureName: "Penn Home Medical Supply",
    });
  });

  it("falls back when the resolver throws", async () => {
    const brand = await resolveAuthEmailBrand(
      {
        ...PLATFORM,
        resolveBrand: () => {
          throw new Error("supabase down");
        },
      },
      REQ,
    );
    expect(brand).toEqual({
      productName: "CareMetric Breathe",
      signatureName: "CareMetric Breathe",
    });
  });

  it("falls back when the resolver rejects", async () => {
    const brand = await resolveAuthEmailBrand(
      { ...PLATFORM, resolveBrand: () => Promise.reject(new Error("timeout")) },
      REQ,
    );
    expect(brand.productName).toBe("CareMetric Breathe");
  });

  it("falls back on a null or blank product name", async () => {
    // An unresolved host (the platform site, an unbound domain) returns null;
    // a half-populated org row could return whitespace. Neither may become an
    // empty wordmark at the top of the email.
    for (const resolved of [
      null,
      { productName: "" },
      { productName: "   " },
    ] as const) {
      const brand = await resolveAuthEmailBrand(
        { ...PLATFORM, resolveBrand: () => resolved },
        REQ,
      );
      expect(brand.productName).toBe("CareMetric Breathe");
    }
  });

  it("never signs one brand's email with another's name", async () => {
    // A resolver that names the tenant but not its legal entity must not
    // inherit the PLATFORM's signature — the wordmark and the sign-off have
    // to come from the same brand or the email reads as two companies.
    const brand = await resolveAuthEmailBrand(
      {
        ...PLATFORM,
        resolveBrand: () => ({ productName: "Acme Sleep", signatureName: "" }),
      },
      REQ,
    );
    expect(brand).toEqual({ productName: "Acme Sleep" });
    expect(brand.signatureName).toBeUndefined();
  });

  it("trims the resolved values", async () => {
    const brand = await resolveAuthEmailBrand(
      {
        ...PLATFORM,
        resolveBrand: () => ({
          productName: "  Acme Sleep  ",
          signatureName: "  Acme Home Medical LLC  ",
        }),
      },
      REQ,
    );
    expect(brand).toEqual({
      productName: "Acme Sleep",
      signatureName: "Acme Home Medical LLC",
    });
  });
});
