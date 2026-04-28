// Worker-side env-presence preflight tests.
//
// `scanForDueReminders` and the job handlers themselves go through the
// live DB / pg-boss / lib helpers and are exercised via the api-side
// integration suite (the lib code path is shared — see ADR 013). This
// file pins the worker's local `readWorkerMessagingConfig` because it
// is the env-shape contract between the worker and the admin-facing
// API: a half-configured deploy that boots the worker but is missing
// SMS or email secrets MUST log + skip rather than throw, otherwise
// pg-boss fills its retry queue with permanent failures.
//
// Tests pass an explicit `env` to keep them hermetic.

import { describe, expect, it } from "vitest";

import { __testing } from "./reminders.js";

const { readWorkerMessagingConfigForTest } = __testing;

const baseEnv = {
  RESUPPLY_VOICE_PUBLIC_BASE_URL: "https://example.test",
  RESUPPLY_PRACTICE_NAME: "Test Practice",
} as const;

describe("readWorkerMessagingConfig (worker env preflight)", () => {
  it("returns sms=null when no twilio credentials are set", () => {
    const cfg = readWorkerMessagingConfigForTest({ ...baseEnv });
    expect(cfg.sms).toBeNull();
  });

  it("returns sms config when phone-number-mode credentials are set", () => {
    const cfg = readWorkerMessagingConfigForTest({
      ...baseEnv,
      TWILIO_ACCOUNT_SID: "AC_x",
      TWILIO_AUTH_TOKEN: "tok",
      TWILIO_PHONE_NUMBER: "+15555550100",
    });
    expect(cfg.sms).not.toBeNull();
    expect(cfg.sms?.twilioPhoneNumber).toBe("+15555550100");
    expect(cfg.sms?.publicBaseUrl).toBe("https://example.test");
  });

  it("returns sms config when messaging-service-mode credentials are set", () => {
    const cfg = readWorkerMessagingConfigForTest({
      ...baseEnv,
      TWILIO_ACCOUNT_SID: "AC_x",
      TWILIO_AUTH_TOKEN: "tok",
      TWILIO_MESSAGING_SERVICE_SID: "MG_x",
    });
    expect(cfg.sms).not.toBeNull();
    expect(cfg.sms?.twilioMessagingServiceSid).toBe("MG_x");
  });

  it("returns sms=null if account+token present but no number/service", () => {
    const cfg = readWorkerMessagingConfigForTest({
      ...baseEnv,
      TWILIO_ACCOUNT_SID: "AC_x",
      TWILIO_AUTH_TOKEN: "tok",
    });
    expect(cfg.sms).toBeNull();
  });

  it("returns sms=null when public base URL cannot be inferred", () => {
    const cfg = readWorkerMessagingConfigForTest({
      RESUPPLY_PRACTICE_NAME: "Test Practice",
      TWILIO_ACCOUNT_SID: "AC_x",
      TWILIO_AUTH_TOKEN: "tok",
      TWILIO_PHONE_NUMBER: "+15555550100",
    });
    expect(cfg.sms).toBeNull();
  });

  it("returns email=null when no sendgrid credentials are set", () => {
    const cfg = readWorkerMessagingConfigForTest({ ...baseEnv });
    expect(cfg.email).toBeNull();
  });

  it("returns email config when all three sendgrid envs + base url are set", () => {
    const cfg = readWorkerMessagingConfigForTest({
      ...baseEnv,
      SENDGRID_API_KEY: "SG.x",
      SENDGRID_FROM_EMAIL: "a@b.test",
      SENDGRID_FROM_NAME: "From",
    });
    expect(cfg.email).not.toBeNull();
    expect(cfg.email?.sendgridFromEmail).toBe("a@b.test");
  });

  it("returns email=null when only api key is present (from email/name missing)", () => {
    const cfg = readWorkerMessagingConfigForTest({
      ...baseEnv,
      SENDGRID_API_KEY: "SG.x",
    });
    expect(cfg.email).toBeNull();
  });

  it("hmacKeysReady is false when either HMAC key is missing", () => {
    expect(
      readWorkerMessagingConfigForTest({ ...baseEnv }).hmacKeysReady,
    ).toBe(false);
    expect(
      readWorkerMessagingConfigForTest({
        ...baseEnv,
        RESUPPLY_PHONE_HMAC_KEY: "k",
      }).hmacKeysReady,
    ).toBe(false);
    expect(
      readWorkerMessagingConfigForTest({
        ...baseEnv,
        RESUPPLY_LINK_HMAC_KEY: "k",
      }).hmacKeysReady,
    ).toBe(false);
  });

  it("hmacKeysReady is true when both HMAC keys are set", () => {
    const cfg = readWorkerMessagingConfigForTest({
      ...baseEnv,
      RESUPPLY_PHONE_HMAC_KEY: "k1",
      RESUPPLY_LINK_HMAC_KEY: "k2",
    });
    expect(cfg.hmacKeysReady).toBe(true);
  });

  it("strips trailing slash from RESUPPLY_VOICE_PUBLIC_BASE_URL", () => {
    const cfg = readWorkerMessagingConfigForTest({
      RESUPPLY_VOICE_PUBLIC_BASE_URL: "https://example.test/",
      TWILIO_ACCOUNT_SID: "AC_x",
      TWILIO_AUTH_TOKEN: "tok",
      TWILIO_PHONE_NUMBER: "+15555550100",
    });
    expect(cfg.sms?.publicBaseUrl).toBe("https://example.test");
  });

  it("falls back to REPLIT_DEV_DOMAIN when explicit base URL absent", () => {
    const cfg = readWorkerMessagingConfigForTest({
      REPLIT_DEV_DOMAIN: "abc.repl.co",
      RESUPPLY_PRACTICE_NAME: "Test Practice",
      TWILIO_ACCOUNT_SID: "AC_x",
      TWILIO_AUTH_TOKEN: "tok",
      TWILIO_PHONE_NUMBER: "+15555550100",
    });
    expect(cfg.sms?.publicBaseUrl).toBe("https://abc.repl.co");
  });
});
