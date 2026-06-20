// Guards for the System Configuration catalog. These pin
// security-relevant intent (which keys are secret → masked + write-only)
// so a future edit can't silently change the posture of a credential.

import { describe, it, expect } from "vitest";

import {
  APP_CONFIG_CATALOG,
  appConfigScopeOf,
  CATEGORY_OFFICE_ALLY,
  getAppConfigSetting,
  isAppConfigKey,
  PLATFORM_SCOPED_APP_CONFIG_KEYS,
  TENANT_SCOPED_APP_CONFIG_KEYS,
} from "./catalog";

describe("APP_CONFIG_CATALOG — Office Ally real-time eligibility", () => {
  it("exposes the real-time API key as a masked secret in the Office Ally category", () => {
    const apiKey = getAppConfigSetting("OFFICE_ALLY_REALTIME_API_KEY");
    expect(apiKey).toBeDefined();
    // secret === true is what makes the route mask it (last-4 hint) and the
    // UI render a password input — never returning the plaintext.
    expect(apiKey!.secret).toBe(true);
    expect(apiKey!.category).toBe(CATEGORY_OFFICE_ALLY);
    // Read at call time from process.env (eligibility-verifier →
    // resolveClearinghouse), folded in by the boot overlay → "restart".
    expect(apiKey!.applyMode).toBe("restart");
  });

  it("exposes the real-time endpoint URL as non-secret config", () => {
    const url = getAppConfigSetting("OFFICE_ALLY_REALTIME_URL");
    expect(url).toBeDefined();
    // The endpoint is not a secret — shown in full so an operator can verify it.
    expect(url!.secret).toBe(false);
    expect(url!.category).toBe(CATEGORY_OFFICE_ALLY);
  });

  it("treats both keys as writable catalog keys (overlayable)", () => {
    expect(isAppConfigKey("OFFICE_ALLY_REALTIME_API_KEY")).toBe(true);
    expect(isAppConfigKey("OFFICE_ALLY_REALTIME_URL")).toBe(true);
  });

  it("keeps every key unique (the overlay is keyed by env-var name)", () => {
    const keys = APP_CONFIG_CATALOG.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("APP_CONFIG_CATALOG — platform vs tenant scope split", () => {
  // The split decides WHICH admin surface owns a setting:
  //   platform → the global super-admin (/platform/config)
  //   tenant   → the tenant's own Admin/Owner (/admin/system/config)
  // Infra credentials are platform-shared; business partner accounts are
  // each tenant's own relationship.

  it("scopes the business-integration partner accounts to the tenant", () => {
    // Each DME brings its OWN therapy-cloud + clearinghouse accounts.
    for (const key of [
      "AIRVIEW_CLIENT_SECRET",
      "CARE_ORCHESTRATOR_CLIENT_SECRET",
      "REACT_HEALTH_CLIENT_SECRET",
      "OFFICE_ALLY_USERNAME",
      "OFFICE_ALLY_REALTIME_API_KEY",
    ]) {
      expect(appConfigScopeOf(key)).toBe("tenant");
    }
  });

  it("keeps shared platform infra credentials platform-scoped", () => {
    // AI vendors + the platform's own Twilio/SendGrid/Stripe are shared by
    // every tenant and owned by the global super-admin only.
    for (const key of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "TWILIO_AUTH_TOKEN",
      "SENDGRID_API_KEY",
      "STRIPE_SECRET_KEY",
    ]) {
      expect(appConfigScopeOf(key)).toBe("platform");
    }
  });

  it("keeps the tenant assistant/branding names tenant-scoped", () => {
    expect(appConfigScopeOf("RESUPPLY_ASSISTANT_STOREFRONT_NAME")).toBe(
      "tenant",
    );
    expect(appConfigScopeOf("RESUPPLY_ASSISTANT_ADMIN_NAME")).toBe("tenant");
  });

  it("partitions every catalog key into exactly one scope bucket", () => {
    const tenant = new Set(TENANT_SCOPED_APP_CONFIG_KEYS);
    const platform = new Set(PLATFORM_SCOPED_APP_CONFIG_KEYS);
    // Disjoint…
    for (const k of tenant) expect(platform.has(k)).toBe(false);
    // …and exhaustive.
    expect(tenant.size + platform.size).toBe(APP_CONFIG_CATALOG.length);
  });

  it("never surfaces a platform credential on the tenant surface", () => {
    // The thing the security split is FOR: a tenant admin must not be able
    // to read/write a shared platform secret.
    expect(TENANT_SCOPED_APP_CONFIG_KEYS).not.toContain("STRIPE_SECRET_KEY");
    expect(TENANT_SCOPED_APP_CONFIG_KEYS).not.toContain("ANTHROPIC_API_KEY");
    expect(TENANT_SCOPED_APP_CONFIG_KEYS).not.toContain("TWILIO_AUTH_TOKEN");
  });
});
