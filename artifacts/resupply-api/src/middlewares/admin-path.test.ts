// Direct tests for the shared `isAdminMutationRequest` matcher.
//
// The two gates that delegate to this helper (requireCsrfOnAdminMutations
// in csrf.ts and adminMutationLooseLimit in rate-limit.ts) both have
// their own functional tests exercising it indirectly. This file pins
// the matcher's behavior directly so a future refactor can't silently
// drift one gate from the other.

import type { Request } from "express";
import { describe, expect, it } from "vitest";

import {
  ADMIN_PATH_PREFIXES,
  ADMIN_SAFE_HTTP_METHODS,
  ME_PATH_PREFIXES,
  SHOP_PATH_PREFIXES,
  isAdminMutationRequest,
  isShopMutationRequest,
  isStorefrontSessionMutationRequest,
} from "./admin-path";

function req(method: string, path: string): Request {
  return { method, path } as unknown as Request;
}

describe("ADMIN_SAFE_HTTP_METHODS", () => {
  it.each(["GET", "HEAD", "OPTIONS"])("contains %s", (m) => {
    expect(ADMIN_SAFE_HTTP_METHODS.has(m)).toBe(true);
  });
  it.each(["POST", "PATCH", "PUT", "DELETE"])("does NOT contain %s", (m) => {
    expect(ADMIN_SAFE_HTTP_METHODS.has(m)).toBe(false);
  });
});

describe("ADMIN_PATH_PREFIXES", () => {
  it("covers both mount trees, in lowercase, without trailing slash", () => {
    expect(ADMIN_PATH_PREFIXES).toContain("/api/admin");
    expect(ADMIN_PATH_PREFIXES).toContain("/resupply-api/admin");
    for (const prefix of ADMIN_PATH_PREFIXES) {
      expect(prefix).toBe(prefix.toLowerCase());
      expect(prefix.endsWith("/")).toBe(false);
    }
  });
});

describe("isAdminMutationRequest", () => {
  it.each(["GET", "HEAD", "OPTIONS"])(
    "returns false for safe method %s on an admin path",
    (method) => {
      expect(isAdminMutationRequest(req(method, "/api/admin/users"))).toBe(
        false,
      );
    },
  );

  it.each([
    ["POST", "/api/admin/users/invite"],
    ["PATCH", "/api/admin/users/42"],
    ["DELETE", "/resupply-api/admin/csr-macros/abc"],
    ["PUT", "/resupply-api/admin/patients/x/fit-override"],
  ])("returns true for %s %s", (method, path) => {
    expect(isAdminMutationRequest(req(method, path))).toBe(true);
  });

  it.each([
    "/API/ADMIN/users",
    "/Api/Admin/users",
    "/resupply-API/Admin/shop/orders/x",
  ])("matches mixed-case admin path %s", (path) => {
    expect(isAdminMutationRequest(req("POST", path))).toBe(true);
  });

  it.each(["/api/admin", "/resupply-api/admin"])(
    "matches the bare admin path %s exactly",
    (path) => {
      // Defensive — no route mounts at the bare path today, but the
      // contract should hold if a future router lands there.
      expect(isAdminMutationRequest(req("POST", path))).toBe(true);
    },
  );

  it.each([
    "/api/admin-export",
    "/api/administrators",
    "/api/adminfoo",
    "/resupply-api/admin-bridge",
  ])("does NOT match look-alike prefix %s", (path) => {
    expect(isAdminMutationRequest(req("POST", path))).toBe(false);
  });

  it("does NOT match non-admin paths", () => {
    expect(isAdminMutationRequest(req("POST", "/api/orders"))).toBe(false);
    expect(isAdminMutationRequest(req("POST", "/resupply-api/voice/inbound"))).toBe(
      false,
    );
  });
});

describe("SHOP_PATH_PREFIXES", () => {
  it("covers both mount trees, lowercase, no trailing slash", () => {
    expect(SHOP_PATH_PREFIXES).toContain("/api/shop");
    expect(SHOP_PATH_PREFIXES).toContain("/resupply-api/shop");
    for (const prefix of SHOP_PATH_PREFIXES) {
      expect(prefix).toBe(prefix.toLowerCase());
      expect(prefix.endsWith("/")).toBe(false);
    }
  });
});

describe("isShopMutationRequest", () => {
  it.each(["GET", "HEAD", "OPTIONS"])(
    "returns false for safe method %s on a shop path",
    (method) => {
      expect(isShopMutationRequest(req(method, "/api/shop/me/cart-snapshot"))).toBe(
        false,
      );
    },
  );

  it.each([
    ["POST", "/api/shop/checkout"],
    ["POST", "/api/shop/me/quick-checkout"],
    ["PUT", "/api/shop/me/cart-snapshot"],
    ["DELETE", "/api/shop/me/caregiver"],
    ["POST", "/resupply-api/shop/checkout"],
    ["PATCH", "/resupply-api/shop/me/comm-prefs"],
  ])("returns true for %s %s", (method, path) => {
    expect(isShopMutationRequest(req(method, path))).toBe(true);
  });

  it.each([
    "/API/SHOP/checkout",
    "/Api/Shop/Me/cart-snapshot",
    "/resupply-API/Shop/checkout",
  ])("matches mixed-case shop path %s", (path) => {
    expect(isShopMutationRequest(req("POST", path))).toBe(true);
  });

  it.each(["/api/shop", "/resupply-api/shop"])(
    "matches the bare shop path %s exactly",
    (path) => {
      expect(isShopMutationRequest(req("POST", path))).toBe(true);
    },
  );

  it.each([
    "/api/shop-banner",
    "/api/shoppers",
    "/api/shopfoo",
    "/resupply-api/shop-bridge",
  ])("does NOT match look-alike prefix %s", (path) => {
    expect(isShopMutationRequest(req("POST", path))).toBe(false);
  });

  it("does NOT match admin or webhook paths", () => {
    expect(isShopMutationRequest(req("POST", "/api/admin/users"))).toBe(false);
    expect(isShopMutationRequest(req("POST", "/resupply-api/voice/inbound"))).toBe(
      false,
    );
    expect(isShopMutationRequest(req("POST", "/api/orders"))).toBe(false);
  });

  it("does NOT match the patient-portal /me tree (that's the storefront matcher)", () => {
    // isShopMutationRequest is shop-only; /me coverage lives in
    // isStorefrontSessionMutationRequest. This pins the boundary so a
    // future edit can't silently collapse the two.
    expect(isShopMutationRequest(req("POST", "/api/me/payments/checkout-session"))).toBe(
      false,
    );
  });
});

describe("ME_PATH_PREFIXES", () => {
  it("covers both mount trees, lowercase, no trailing slash", () => {
    expect(ME_PATH_PREFIXES).toContain("/api/me");
    expect(ME_PATH_PREFIXES).toContain("/resupply-api/me");
    for (const prefix of ME_PATH_PREFIXES) {
      expect(prefix).toBe(prefix.toLowerCase());
      expect(prefix.endsWith("/")).toBe(false);
    }
  });
});

describe("isStorefrontSessionMutationRequest", () => {
  it.each(["GET", "HEAD", "OPTIONS"])(
    "returns false for safe method %s",
    (method) => {
      expect(
        isStorefrontSessionMutationRequest(
          req(method, "/api/me/payments/checkout-session"),
        ),
      ).toBe(false);
    },
  );

  it.each([
    // shop tree (delegates to isShopMutationRequest)
    ["POST", "/api/shop/checkout"],
    ["POST", "/api/shop/me/quick-checkout"],
    ["POST", "/resupply-api/shop/checkout"],
    // patient-portal /me tree (the regression this matcher fixes)
    ["POST", "/api/me/payments/checkout-session"],
    ["POST", "/api/me/payments/intent"],
    ["POST", "/api/me/sleep-coach"],
    ["POST", "/resupply-api/me/payments/checkout-session"],
  ])("returns true for %s %s", (method, path) => {
    expect(isStorefrontSessionMutationRequest(req(method, path))).toBe(true);
  });

  it.each(["/api/me", "/resupply-api/me"])(
    "matches the bare /me path %s exactly",
    (path) => {
      expect(isStorefrontSessionMutationRequest(req("POST", path))).toBe(true);
    },
  );

  it("matches mixed-case /me paths", () => {
    expect(
      isStorefrontSessionMutationRequest(
        req("POST", "/API/Me/payments/checkout-session"),
      ),
    ).toBe(true);
  });

  it.each(["/api/men", "/api/membership", "/api/mens-health", "/resupply-api/metrics"])(
    "does NOT match look-alike prefix %s",
    (path) => {
      expect(isStorefrontSessionMutationRequest(req("POST", path))).toBe(false);
    },
  );

  it("does NOT match admin or webhook paths", () => {
    expect(isStorefrontSessionMutationRequest(req("POST", "/api/admin/users"))).toBe(
      false,
    );
    expect(
      isStorefrontSessionMutationRequest(req("POST", "/resupply-api/voice/inbound")),
    ).toBe(false);
  });
});
