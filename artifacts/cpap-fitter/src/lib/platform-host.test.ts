import { describe, expect, it } from "vitest";

import { isPlatformHomeHost } from "./platform-host";

describe("isPlatformHomeHost", () => {
  it("matches the platform apex (with and without www)", () => {
    expect(isPlatformHomeHost("cmbreathe.com")).toBe(true);
    expect(isPlatformHomeHost("www.cmbreathe.com")).toBe(true);
    expect(isPlatformHomeHost("CMBreathe.com")).toBe(true);
    expect(isPlatformHomeHost("cmbreathe.com.")).toBe(true);
  });

  it("matches the Railway platform fallback hosts", () => {
    expect(isPlatformHomeHost("pennfit.up.railway.app")).toBe(true);
    expect(isPlatformHomeHost("pennfit-pr-42.up.railway.app")).toBe(true);
  });

  it("does NOT match tenant storefront hosts", () => {
    // Verified custom domain (the seed tenant).
    expect(isPlatformHomeHost("pennpaps.com")).toBe(false);
    expect(isPlatformHomeHost("www.pennpaps.com")).toBe(false);
    // A `<slug>.cmbreathe.com` tenant subdomain is NOT the apex.
    expect(isPlatformHomeHost("acme.cmbreathe.com")).toBe(false);
    expect(isPlatformHomeHost("acme-sleep.cmbreathe.com")).toBe(false);
  });

  it("does NOT match local dev or empty hosts", () => {
    expect(isPlatformHomeHost("localhost")).toBe(false);
    expect(isPlatformHomeHost("127.0.0.1")).toBe(false);
    expect(isPlatformHomeHost("")).toBe(false);
  });
});
