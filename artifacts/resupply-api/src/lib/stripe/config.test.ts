import { describe, expect, it } from "vitest";

import {
  getStripeClient,
  readPlatformBillingStripeConfigOrNull,
} from "./config";

// A minimal env that satisfies the public-base-url requirement so the
// config readers don't short-circuit on a missing redirect host.
function baseEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    RESUPPLY_VOICE_PUBLIC_BASE_URL: "https://pennfit.up.railway.app",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("readPlatformBillingStripeConfigOrNull", () => {
  it("falls back to the legacy key in shared mode (dedicated key unset)", () => {
    const cfg = readPlatformBillingStripeConfigOrNull(
      baseEnv({
        STRIPE_SECRET_KEY: "sk_test_legacy",
        STRIPE_WEBHOOK_SIGNING_SECRET: "whsec_legacy",
      }),
    );
    expect(cfg).not.toBeNull();
    expect(cfg!.mode).toBe("shared");
    expect(cfg!.secretKey).toBe("sk_test_legacy");
    // In shared mode there is no dedicated webhook, so the legacy signing
    // secret is what's reported.
    expect(cfg!.webhookSigningSecret).toBe("whsec_legacy");
  });

  it("uses the dedicated account key + its own webhook secret when set", () => {
    const cfg = readPlatformBillingStripeConfigOrNull(
      baseEnv({
        STRIPE_SECRET_KEY: "sk_test_legacy",
        STRIPE_WEBHOOK_SIGNING_SECRET: "whsec_legacy",
        STRIPE_PLATFORM_SECRET_KEY: "sk_test_platform",
        STRIPE_PLATFORM_WEBHOOK_SIGNING_SECRET: "whsec_platform",
      }),
    );
    expect(cfg).not.toBeNull();
    expect(cfg!.mode).toBe("dedicated");
    expect(cfg!.secretKey).toBe("sk_test_platform");
    expect(cfg!.webhookSigningSecret).toBe("whsec_platform");
    // The platform account's publishable key is never used server-side.
    expect(cfg!.publishableKey).toBeNull();
  });

  it("reports a null webhook secret in dedicated mode when it's missing", () => {
    const cfg = readPlatformBillingStripeConfigOrNull(
      baseEnv({
        STRIPE_SECRET_KEY: "sk_test_legacy",
        STRIPE_PLATFORM_SECRET_KEY: "sk_test_platform",
      }),
    );
    expect(cfg!.mode).toBe("dedicated");
    expect(cfg!.webhookSigningSecret).toBeNull();
  });

  it("treats a whitespace-only dedicated key as unset (stays shared)", () => {
    const cfg = readPlatformBillingStripeConfigOrNull(
      baseEnv({
        STRIPE_SECRET_KEY: "sk_test_legacy",
        STRIPE_PLATFORM_SECRET_KEY: "   ",
      }),
    );
    expect(cfg!.mode).toBe("shared");
    expect(cfg!.secretKey).toBe("sk_test_legacy");
  });

  it("returns null when neither a dedicated nor a legacy key is set", () => {
    expect(readPlatformBillingStripeConfigOrNull(baseEnv())).toBeNull();
  });

  it("returns null when no public base URL can be resolved", () => {
    const cfg = readPlatformBillingStripeConfigOrNull({
      STRIPE_SECRET_KEY: "sk_test_legacy",
    } as NodeJS.ProcessEnv);
    expect(cfg).toBeNull();
  });
});

describe("getStripeClient caching", () => {
  it("returns the same instance for one key and distinct instances per key", () => {
    const shared = readPlatformBillingStripeConfigOrNull(
      baseEnv({ STRIPE_SECRET_KEY: "sk_test_cache_shared" }),
    )!;
    const dedicated = readPlatformBillingStripeConfigOrNull(
      baseEnv({
        STRIPE_SECRET_KEY: "sk_test_cache_shared",
        STRIPE_PLATFORM_SECRET_KEY: "sk_test_cache_dedicated",
      }),
    )!;

    const sharedClientA = getStripeClient(shared);
    const sharedClientB = getStripeClient(shared);
    const dedicatedClient = getStripeClient(dedicated);

    // Same key → memoized, no thrash.
    expect(sharedClientA).toBe(sharedClientB);
    // Different key → its own long-lived client (a mid-migration deployment
    // holds both without evicting each other).
    expect(dedicatedClient).not.toBe(sharedClientA);
  });
});
