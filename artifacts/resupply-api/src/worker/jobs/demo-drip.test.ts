import { beforeEach, describe, expect, it } from "vitest";

import { buildDemoLinks, demoDripBaseUrl, isStageDue } from "./demo-drip";

const DAY = 86_400_000;

beforeEach(() => {
  process.env.RESUPPLY_LINK_HMAC_KEY = "test-hmac-key-for-demo-drip-helpers-32";
  delete process.env.PLATFORM_PUBLIC_BASE_URL;
  delete process.env.SHOP_PUBLIC_BASE_URL;
  delete process.env.RAILWAY_PUBLIC_DOMAIN;
});

describe("isStageDue", () => {
  const now = Date.now();
  it("welcome (stage 0) is always due", () => {
    expect(isStageDue(0, null, now)).toBe(true);
    expect(isStageDue(0, new Date(now).toISOString(), now)).toBe(true);
  });

  it("follow-up 1 (stage 1) waits ~2 days", () => {
    expect(isStageDue(1, new Date(now - 1 * DAY).toISOString(), now)).toBe(
      false,
    );
    expect(isStageDue(1, new Date(now - 2 * DAY).toISOString(), now)).toBe(
      true,
    );
  });

  it("follow-up 2 (stage 2) waits ~3 days", () => {
    expect(isStageDue(2, new Date(now - 2 * DAY).toISOString(), now)).toBe(
      false,
    );
    expect(isStageDue(2, new Date(now - 3 * DAY).toISOString(), now)).toBe(
      true,
    );
  });

  it("an out-of-range stage is never due", () => {
    expect(isStageDue(3, null, now)).toBe(false);
  });
});

describe("demoDripBaseUrl", () => {
  it("defaults the base URL to the platform apex", () => {
    expect(demoDripBaseUrl()).toBe("https://cmbreathe.com");
  });

  it("prefers the explicit platform override", () => {
    process.env.PLATFORM_PUBLIC_BASE_URL = "https://cmbreathe.com/";
    expect(demoDripBaseUrl()).toBe("https://cmbreathe.com");
  });

  it("uses the platform Railway host, never a tenant shop URL", () => {
    // SHOP_PUBLIC_BASE_URL can be a tenant storefront (e.g. pennpaps.com) —
    // it must NOT influence this platform-only drip.
    process.env.SHOP_PUBLIC_BASE_URL = "https://pennpaps.com";
    process.env.RAILWAY_PUBLIC_DOMAIN = "pennfit.up.railway.app";
    expect(demoDripBaseUrl()).toBe("https://pennfit.up.railway.app");
  });
});

describe("buildDemoLinks", () => {
  it("builds demo / features / unsubscribe links bound to the email", () => {
    const links = buildDemoLinks("lead@example.com", "https://cmbreathe.com");
    expect(links.demoUrl).toBe("https://cmbreathe.com/admin?demo=1");
    expect(links.featuresUrl).toBe("https://cmbreathe.com/breathe-features");
    expect(links.contactUrl).toContain("mailto:info@cmbreathe.com");
    expect(links.unsubscribeUrl).toMatch(
      /^https:\/\/cmbreathe\.com\/api\/newsletter-unsubscribe\?t=/,
    );
  });
});
