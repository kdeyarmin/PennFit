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
  isAdminMutationRequest,
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
