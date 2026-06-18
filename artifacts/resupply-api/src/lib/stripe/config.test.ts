import { describe, expect, it } from "vitest";

import {
  getStripeClient,
  readPlatformBillingStripeConfigOrNull,
  readStripeConfigOrNull,
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
  it("falls back to the patient key in shared mode (dedicated key unset)", () => {
    const cfg = readPlatformBillingStripeConfigOrNull(
      baseEnv({
        STRIPE_SECRET_KEY: "sk_test_patient",
        STRIPE_WEBHOOK_SIGNING_SECRET: "whsec_patient",
      }),
    );
    expect(cfg).not.toBeNull();
    expect(cfg!.mode).toBe("shared");
    expect(cfg!.secretKey).toBe("sk_test_patient");
    // In shared mode the platform events arrive on the patient webhook, so
    // the patient signing secret is reused.
    expect(cfg!.webhookSigningSecret).toBe("whsec_patient");
  });

  it("uses the dedicated account key + its own webhook secret when set", () => {
    const cfg = readPlatformBillingStripeConfigOrNull(
      baseEnv({
        STRIPE_SECRET_KEY: "sk_test_patient",
        STRIPE_WEBHOOK_SIGNING_SECRET: "whsec_patient",
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
        STRIPE_SECRET_KEY: "sk_test_patient",
        STRIPE_PLATFORM_SECRET_KEY: "sk_test_platform",
      }),
    );
    expect(cfg!.mode).toBe("dedicated");
    expect(cfg!.webhookSigningSecret).toBeNull();
  });

  it("treats a whitespace-only dedicated key as unset (stays shared)", () => {
    const cfg = readPlatformBillingStripeConfigOrNull(
      baseEnv({
        STRIPE_SECRET_KEY: "sk_test_patient",
        STRIPE_PLATFORM_SECRET_KEY: "   ",
      }),
    );
    expect(cfg!.mode).toBe("shared");
    expect(cfg!.secretKey).toBe("sk_test_patient");
  });

  it("returns null when neither a dedicated nor a patient key is set", () => {
    expect(readPlatformBillingStripeConfigOrNull(baseEnv())).toBeNull();
  });

  it("returns null when no public base URL can be resolved", () => {
    const cfg = readPlatformBillingStripeConfigOrNull({
      STRIPE_SECRET_KEY: "sk_test_patient",
    } as NodeJS.ProcessEnv);
    expect(cfg).toBeNull();
  });
});

describe("getStripeClient caching", () => {
  it("returns the same instance for one key and distinct instances per key", () => {
    const patient = readStripeConfigOrNull(
      baseEnv({ STRIPE_SECRET_KEY: "sk_test_cache_patient" }),
    )!;
    const platform = readPlatformBillingStripeConfigOrNull(
      baseEnv({
        STRIPE_SECRET_KEY: "sk_test_cache_patient",
        STRIPE_PLATFORM_SECRET_KEY: "sk_test_cache_platform",
      }),
    )!;

    const patientClientA = getStripeClient(patient);
    const patientClientB = getStripeClient(patient);
    const platformClient = getStripeClient(platform);

    // Same key → memoized, no thrash.
    expect(patientClientA).toBe(patientClientB);
    // Different key → its own long-lived client (the patient + platform
    // accounts coexist without evicting each other).
    expect(platformClient).not.toBe(patientClientA);
  });
});
