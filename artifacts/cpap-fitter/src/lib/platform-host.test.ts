import { describe, expect, it } from "vitest";

import { isPlatformApexHost, isPlatformHomeHost } from "./platform-host";

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

describe("isPlatformApexHost", () => {
  it("matches ONLY the production apex (with and without www)", () => {
    expect(isPlatformApexHost("cmbreathe.com")).toBe(true);
    expect(isPlatformApexHost("www.cmbreathe.com")).toBe(true);
    expect(isPlatformApexHost("CMBreathe.com")).toBe(true);
    expect(isPlatformApexHost("cmbreathe.com.")).toBe(true);
  });

  it("does NOT match the Railway deploy/preview hosts (kept out of the index)", () => {
    // These ARE platform-home hosts, but they serve staging/duplicate
    // content and must stay noindex — only the canonical apex is indexable.
    expect(isPlatformApexHost("pennfit.up.railway.app")).toBe(false);
    expect(isPlatformApexHost("pennfit-pr-42.up.railway.app")).toBe(false);
  });

  it("does NOT match tenant storefront, local dev, or empty hosts", () => {
    expect(isPlatformApexHost("pennpaps.com")).toBe(false);
    expect(isPlatformApexHost("acme.cmbreathe.com")).toBe(false);
    expect(isPlatformApexHost("localhost")).toBe(false);
    expect(isPlatformApexHost("")).toBe(false);
  });
});
