// Guards for the System Configuration catalog. These pin
// security-relevant intent (which keys are secret → masked + write-only)
// so a future edit can't silently change the posture of a credential.

import { describe, it, expect } from "vitest";

import {
  APP_CONFIG_CATALOG,
  CATEGORY_OFFICE_ALLY,
  getAppConfigSetting,
  isAppConfigKey,
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
