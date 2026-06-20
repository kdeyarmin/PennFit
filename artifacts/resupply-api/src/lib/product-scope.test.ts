// Tests for the tenant product-scope resolver + the mask_fitter admin
// allowlist (standalone Virtual Mask Fitter plan, migration 0418).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    result: null as { data: unknown; error: unknown } | null,
    throwOnQuery: false,
  },
}));

// Mock the org-scoped client down the exact chain the resolver walks:
// raw → schema → from → select → eq → in → limit → maybeSingle.
vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: () => ({
    raw: () => ({
      schema: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              in: () => ({
                limit: () => ({
                  maybeSingle: async () => {
                    if (state.throwOnQuery) throw new Error("connection reset");
                    return state.result ?? { data: null, error: null };
                  },
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  }),
}));

vi.mock("./logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  resolveTenantProductScope,
  isMaskFitterAllowedPath,
  __clearProductScopeCacheForTests,
} from "./product-scope";

beforeEach(() => {
  state.result = null;
  state.throwOnQuery = false;
  __clearProductScopeCacheForTests();
});

describe("resolveTenantProductScope", () => {
  it("returns full when no orgId is provided (no DB call)", async () => {
    expect(await resolveTenantProductScope(undefined)).toBe("full");
    expect(await resolveTenantProductScope(null)).toBe("full");
    expect(await resolveTenantProductScope("   ")).toBe("full");
  });

  it("returns mask_fitter when the active plan is scoped to it", async () => {
    state.result = {
      data: { billing_plans: { product_scope: "mask_fitter" } },
      error: null,
    };
    expect(await resolveTenantProductScope("org-1")).toBe("mask_fitter");
  });

  it("returns full for a normal whole-suite plan", async () => {
    state.result = {
      data: { billing_plans: { product_scope: "full" } },
      error: null,
    };
    expect(await resolveTenantProductScope("org-2")).toBe("full");
  });

  it("returns full when the tenant has no active subscription", async () => {
    state.result = { data: null, error: null };
    expect(await resolveTenantProductScope("org-3")).toBe("full");
  });

  it("fails OPEN to full on a query error", async () => {
    state.result = { data: null, error: { message: "boom" } };
    expect(await resolveTenantProductScope("org-4")).toBe("full");
  });

  it("fails OPEN to full when the query throws", async () => {
    state.throwOnQuery = true;
    expect(await resolveTenantProductScope("org-5")).toBe("full");
  });

  it("caches the resolved scope within the TTL", async () => {
    state.result = {
      data: { billing_plans: { product_scope: "mask_fitter" } },
      error: null,
    };
    expect(await resolveTenantProductScope("org-6")).toBe("mask_fitter");
    // Flip the backing row; the cached value must still be served.
    state.result = {
      data: { billing_plans: { product_scope: "full" } },
      error: null,
    };
    expect(await resolveTenantProductScope("org-6")).toBe("mask_fitter");
  });
});

describe("isMaskFitterAllowedPath", () => {
  it("always allows the identity endpoint", () => {
    expect(isMaskFitterAllowedPath("/resupply-api/me")).toBe(true);
  });

  it("allows the fitter + account-essential surfaces", () => {
    for (const p of [
      "/resupply-api/admin/fitter-invites",
      "/resupply-api/admin/fitter-invites/abc/attach",
      "/resupply-api/admin/fitter-leads/metrics",
      "/resupply-api/admin/billing/plans",
      "/resupply-api/admin/billing/subscription",
      "/resupply-api/admin/storefront-branding",
      "/resupply-api/admin/agreements",
      "/resupply-api/admin/inbox-counts",
    ]) {
      expect(isMaskFitterAllowedPath(p)).toBe(true);
    }
  });

  it("blocks the operational modules", () => {
    for (const p of [
      "/resupply-api/admin/patients",
      "/resupply-api/admin/shop-orders",
      "/resupply-api/admin/conversations",
      "/resupply-api/admin/bulk-campaigns",
      "/resupply-api/admin/analytics",
      "/resupply-api/admin/cmn-documents",
    ]) {
      expect(isMaskFitterAllowedPath(p)).toBe(false);
    }
  });
});
