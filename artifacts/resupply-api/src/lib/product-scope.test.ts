// Tests for the tenant product-scope resolver + the mask_fitter admin
// allowlist (standalone Virtual Mask Fitter plan, migration 0419).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    // tenant_billing_subscriptions query result (plan scope).
    result: null as { data: unknown; error: unknown } | null,
    // organizations query result (billing_required / payment wall).
    orgResult: null as { data: unknown; error: unknown } | null,
    throwOnQuery: false,
  },
}));

// Mock the org-scoped client. The resolver walks two chain shapes:
//   organizations:                 from → select → eq → maybeSingle
//   tenant_billing_subscriptions:  from → select → eq → in → limit → maybeSingle
// One flexible chain supports both; maybeSingle returns the per-table result.
vi.mock("@workspace/resupply-db", () => {
  const makeChain = (table: string) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      limit: () => chain,
      maybeSingle: async () => {
        if (state.throwOnQuery) throw new Error("connection reset");
        const r = table === "organizations" ? state.orgResult : state.result;
        return r ?? { data: null, error: null };
      },
    };
    return chain;
  };
  return {
    getOrgScopedClient: () => ({
      raw: () => ({
        schema: () => ({ from: (t: string) => makeChain(t) }),
      }),
    }),
  };
});

vi.mock("./logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  resolveTenantProductScope,
  isMaskFitterAllowedPath,
  isLockedAllowedPath,
  __clearProductScopeCacheForTests,
} from "./product-scope";

beforeEach(() => {
  state.result = null;
  state.orgResult = null;
  state.throwOnQuery = false;
  delete process.env.BILLING_PAYWALL_ENFORCED;
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

  it("is NOT locked when the payment wall is unenforced, even if billing_required", async () => {
    // Default (no BILLING_PAYWALL_ENFORCED): the org table is never read; the
    // tenant resolves purely on plan scope.
    state.orgResult = { data: { billing_required: true }, error: null };
    state.result = {
      data: { billing_plans: { product_scope: "full" } },
      error: null,
    };
    expect(await resolveTenantProductScope("org-pw1")).toBe("full");
  });

  it("returns locked when the wall is enforced and the tenant is billing_required", async () => {
    process.env.BILLING_PAYWALL_ENFORCED = "1";
    state.orgResult = { data: { billing_required: true }, error: null };
    expect(await resolveTenantProductScope("org-pw2")).toBe("locked");
  });

  it("falls through to plan scope when enforced but the tenant has paid", async () => {
    process.env.BILLING_PAYWALL_ENFORCED = "1";
    state.orgResult = { data: { billing_required: false }, error: null };
    state.result = {
      data: { billing_plans: { product_scope: "mask_fitter" } },
      error: null,
    };
    expect(await resolveTenantProductScope("org-pw3")).toBe("mask_fitter");
  });

  it("fails OPEN to full when the billing_required read throws under enforcement", async () => {
    process.env.BILLING_PAYWALL_ENFORCED = "1";
    state.throwOnQuery = true;
    expect(await resolveTenantProductScope("org-pw4")).toBe("full");
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
  it("allows the top-level identity endpoint", () => {
    expect(isMaskFitterAllowedPath("/resupply-api/me")).toBe(true);
  });

  it("does NOT treat an admin sub-route ending in /me as the identity endpoint", () => {
    // Over-match guard: agent-availability ends in /me but is operational.
    expect(
      isMaskFitterAllowedPath("/resupply-api/admin/agent-availability/me"),
    ).toBe(false);
  });

  it("allows the fitter + account-essential surfaces", () => {
    for (const p of [
      "/resupply-api/admin/fitter-invites",
      "/resupply-api/admin/fitter-invites/abc/attach",
      "/resupply-api/admin/fitter-leads/metrics",
      // The six self-service SUBSCRIPTION billing endpoints.
      "/resupply-api/admin/billing/package",
      "/resupply-api/admin/billing/plans",
      "/resupply-api/admin/billing/subscription",
      "/resupply-api/admin/billing/addons",
      "/resupply-api/admin/billing/preview",
      "/resupply-api/admin/billing/usage-events",
      "/resupply-api/admin/storefront-branding",
      "/resupply-api/admin/storefront-branding/logo",
      "/resupply-api/admin/mfa/status",
      "/resupply-api/admin/team",
      "/resupply-api/admin/team/invite",
      "/resupply-api/admin/agreements",
      "/resupply-api/admin/inbox-counts",
    ]) {
      expect(isMaskFitterAllowedPath(p)).toBe(true);
    }
  });

  it("blocks the operational claims/revenue-cycle suite under /admin/billing/", () => {
    // Regression: the bare "/admin/billing" prefix used to allow ALL of
    // these (incl. PHI-bearing 837P claim export) for a fitter-only tenant.
    for (const p of [
      "/resupply-api/admin/billing/dashboard",
      "/resupply-api/admin/billing/denials-worklist",
      "/resupply-api/admin/billing/era-files",
      "/resupply-api/admin/billing/era-ingest",
      "/resupply-api/admin/billing/claims/export-837p",
      "/resupply-api/admin/billing/statements/pending",
      "/resupply-api/admin/billing/prior-auth-queue",
      "/resupply-api/admin/billing/eligibility-verification-worklist",
      "/resupply-api/admin/billing/stripe-connect/status",
    ]) {
      expect(isMaskFitterAllowedPath(p)).toBe(false);
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
      "/resupply-api/admin/assistant/chat",
    ]) {
      expect(isMaskFitterAllowedPath(p)).toBe(false);
    }
  });
});

describe("isLockedAllowedPath", () => {
  it("allows the identity endpoint plus the billing + account surfaces", () => {
    for (const p of [
      "/resupply-api/me",
      "/resupply-api/admin/billing/package",
      "/resupply-api/admin/billing/plans",
      "/resupply-api/admin/billing/subscription",
      "/resupply-api/admin/billing/addons",
      "/resupply-api/admin/billing/preview",
      "/resupply-api/admin/billing/usage-events",
      "/resupply-api/admin/agreements",
      "/resupply-api/admin/mfa/status",
      "/resupply-api/admin/inbox-counts",
    ]) {
      expect(isLockedAllowedPath(p)).toBe(true);
    }
  });

  it("blocks operational modules AND the operational billing suite (PHI-bearing 837P export)", () => {
    for (const p of [
      "/resupply-api/admin/patients",
      "/resupply-api/admin/conversations",
      "/resupply-api/admin/billing/claims/export-837p",
      "/resupply-api/admin/billing/denials-worklist",
    ]) {
      expect(isLockedAllowedPath(p)).toBe(false);
    }
  });

  it("is TIGHTER than mask_fitter: even the fitter, team, and branding are blocked when unpaid", () => {
    // These open up once paid + on a real scope; an unpaid tenant can only pay.
    for (const p of [
      "/resupply-api/admin/fitter-invites",
      "/resupply-api/admin/team",
      "/resupply-api/admin/storefront-branding",
    ]) {
      expect(isMaskFitterAllowedPath(p)).toBe(true);
      expect(isLockedAllowedPath(p)).toBe(false);
    }
  });
});
