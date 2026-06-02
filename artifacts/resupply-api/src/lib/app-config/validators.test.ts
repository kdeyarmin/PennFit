import { describe, it, expect } from "vitest";

import { APP_CONFIG_KEYS } from "./catalog";
import {
  FORMAT_RULE_KEYS,
  checkConfigFormat,
  configFormatHint,
} from "./validators";

describe("checkConfigFormat", () => {
  it("returns null for a key with no rule", () => {
    // No format rule for these — never flagged.
    expect(checkConfigFormat("DEEPGRAM_API_KEY", "anything")).toBeNull();
    expect(checkConfigFormat("TWILIO_AUTH_TOKEN", "anything")).toBeNull();
    expect(checkConfigFormat("NOT_A_KEY", "x")).toBeNull();
  });

  it("validates prefix-style keys leniently (live + test)", () => {
    expect(checkConfigFormat("OPENAI_API_KEY", "sk-abc123")).toBe(true);
    expect(checkConfigFormat("OPENAI_API_KEY", "nope")).toBe(false);

    expect(checkConfigFormat("ANTHROPIC_API_KEY", "sk-ant-abc")).toBe(true);
    expect(checkConfigFormat("ANTHROPIC_API_KEY", "sk-abc")).toBe(false);

    expect(checkConfigFormat("STRIPE_SECRET_KEY", "sk_live_abc")).toBe(true);
    expect(checkConfigFormat("STRIPE_SECRET_KEY", "sk_test_abc")).toBe(true);
    expect(checkConfigFormat("STRIPE_SECRET_KEY", "rk_live_abc")).toBe(true);
    expect(checkConfigFormat("STRIPE_SECRET_KEY", "pk_live_abc")).toBe(false);

    expect(
      checkConfigFormat("STRIPE_WEBHOOK_SIGNING_SECRET", "whsec_abc"),
    ).toBe(true);
    expect(checkConfigFormat("SENDGRID_API_KEY", "SG.abc")).toBe(true);
  });

  it("validates Twilio SIDs and E.164 numbers", () => {
    const sid = "AC" + "a".repeat(32);
    expect(checkConfigFormat("TWILIO_ACCOUNT_SID", sid)).toBe(true);
    expect(checkConfigFormat("TWILIO_ACCOUNT_SID", "AC123")).toBe(false);
    expect(checkConfigFormat("TWILIO_PHONE_NUMBER", "+12155551234")).toBe(true);
    expect(checkConfigFormat("TWILIO_PHONE_NUMBER", "2155551234")).toBe(false);
  });

  it("validates URL fields", () => {
    expect(
      checkConfigFormat("AIRVIEW_API_BASE_URL", "https://api.example.com"),
    ).toBe(true);
    expect(checkConfigFormat("AIRVIEW_API_BASE_URL", "api.example.com")).toBe(
      false,
    );
  });

  it("exposes a human hint for keys with a rule", () => {
    expect(configFormatHint("OPENAI_API_KEY")).toBeTruthy();
    expect(configFormatHint("DEEPGRAM_API_KEY")).toBeNull();
  });
});

describe("format-rule catalog integrity", () => {
  it("every format-rule key exists in the catalog (no drift)", () => {
    for (const key of FORMAT_RULE_KEYS) {
      expect(APP_CONFIG_KEYS).toContain(key);
    }
  });
});
