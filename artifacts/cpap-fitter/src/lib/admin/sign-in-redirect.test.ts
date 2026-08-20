// Tests for the staff/operator post-sign-in redirect.
//
// The bug this guards: the Breathe marketing footer's "Super admin login"
// link points at /platform, which bounces a signed-out visitor to
// /admin/sign-in. Sign-in used to hardcode /admin, so the operator landed in
// the TENANT console and the link read as broken.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_DEFAULT_LANDING,
  ADMIN_SIGN_IN_PATH,
  buildAdminSignInHref,
  readAdminRedirectTarget,
  sanitizeAdminRedirect,
} from "./sign-in-redirect";

/** Point window.location at a URL for the duration of one test. */
function withLocation(href: string) {
  const url = new URL(href);
  vi.stubGlobal("window", {
    location: {
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sanitizeAdminRedirect", () => {
  it("keeps a same-origin absolute path", () => {
    expect(sanitizeAdminRedirect("/platform")).toBe("/platform");
    expect(sanitizeAdminRedirect("/platform/tenants")).toBe(
      "/platform/tenants",
    );
    expect(sanitizeAdminRedirect("/admin/patients/123")).toBe(
      "/admin/patients/123",
    );
  });

  it("preserves a query string and hash on the destination", () => {
    expect(sanitizeAdminRedirect("/platform/tenants?status=active")).toBe(
      "/platform/tenants?status=active",
    );
    expect(sanitizeAdminRedirect("/admin/patients?tab=orders#notes")).toBe(
      "/admin/patients?tab=orders#notes",
    );
  });

  it("falls back to the default landing when absent or empty", () => {
    expect(sanitizeAdminRedirect(null)).toBe(ADMIN_DEFAULT_LANDING);
    expect(sanitizeAdminRedirect(undefined)).toBe(ADMIN_DEFAULT_LANDING);
    expect(sanitizeAdminRedirect("")).toBe(ADMIN_DEFAULT_LANDING);
  });

  // Open-redirect defense — the whole reason this is a shared helper.
  it("rejects protocol-relative and absolute URLs", () => {
    expect(sanitizeAdminRedirect("//evil.com")).toBe(ADMIN_DEFAULT_LANDING);
    expect(sanitizeAdminRedirect("//evil.com/pwn")).toBe(ADMIN_DEFAULT_LANDING);
    expect(sanitizeAdminRedirect("https://evil.com")).toBe(
      ADMIN_DEFAULT_LANDING,
    );
    expect(sanitizeAdminRedirect("http://evil.com")).toBe(
      ADMIN_DEFAULT_LANDING,
    );
    expect(sanitizeAdminRedirect("javascript:alert(1)")).toBe(
      ADMIN_DEFAULT_LANDING,
    );
  });

  it("rejects a backslash smuggled behind the leading slash", () => {
    // Some browsers normalize "/\" to "//", making it protocol-relative.
    expect(sanitizeAdminRedirect("/\\evil.com")).toBe(ADMIN_DEFAULT_LANDING);
  });

  it("refuses to bounce back into an auth page", () => {
    expect(sanitizeAdminRedirect("/admin/sign-in")).toBe(ADMIN_DEFAULT_LANDING);
    expect(sanitizeAdminRedirect("/admin/forgot-password")).toBe(
      ADMIN_DEFAULT_LANDING,
    );
    expect(sanitizeAdminRedirect("/admin/reset-password?token=abc")).toBe(
      ADMIN_DEFAULT_LANDING,
    );
    expect(sanitizeAdminRedirect("/admin/verify-email")).toBe(
      ADMIN_DEFAULT_LANDING,
    );
  });
});

describe("readAdminRedirectTarget", () => {
  it("reads and returns the ?redirect= target", () => {
    withLocation("https://cmbreathe.com/admin/sign-in?redirect=%2Fplatform");
    expect(readAdminRedirectTarget()).toBe("/platform");
  });

  it("sanitizes a hostile ?redirect= target", () => {
    withLocation(
      "https://cmbreathe.com/admin/sign-in?redirect=https%3A%2F%2Fevil.com",
    );
    expect(readAdminRedirectTarget()).toBe(ADMIN_DEFAULT_LANDING);
  });

  it("defaults when no ?redirect= is present", () => {
    withLocation("https://cmbreathe.com/admin/sign-in");
    expect(readAdminRedirectTarget()).toBe(ADMIN_DEFAULT_LANDING);
  });
});

describe("buildAdminSignInHref", () => {
  it("carries the current path when the console bounces a signed-out visitor", () => {
    withLocation("https://cmbreathe.com/platform");
    expect(buildAdminSignInHref()).toBe(
      `${ADMIN_SIGN_IN_PATH}?redirect=%2Fplatform`,
    );
  });

  it("carries a deep link with its query string", () => {
    withLocation("https://cmbreathe.com/platform/tenants?status=active");
    expect(buildAdminSignInHref()).toBe(
      `${ADMIN_SIGN_IN_PATH}?redirect=%2Fplatform%2Ftenants%3Fstatus%3Dactive`,
    );
  });

  it("omits the param when the destination is already the default landing", () => {
    withLocation("https://cmbreathe.com/admin");
    expect(buildAdminSignInHref()).toBe(ADMIN_SIGN_IN_PATH);
  });

  it("omits the param rather than encoding a hostile destination", () => {
    expect(buildAdminSignInHref("//evil.com")).toBe(ADMIN_SIGN_IN_PATH);
  });

  it("round-trips: what it encodes is what sign-in reads back", () => {
    withLocation("https://cmbreathe.com/platform/tenants?status=active");
    const href = buildAdminSignInHref();
    withLocation(`https://cmbreathe.com${href}`);
    expect(readAdminRedirectTarget()).toBe("/platform/tenants?status=active");
  });
});
