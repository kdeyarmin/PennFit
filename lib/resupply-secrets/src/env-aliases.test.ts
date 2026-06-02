import { describe, expect, it } from "vitest";

import {
  applyEnvAliases,
  OPS_EMAIL_TARGETS,
  PUBLIC_BASE_URL_TARGETS,
} from "./env-aliases";

type Env = Record<string, string | undefined>;

describe("applyEnvAliases — PUBLIC_BASE_URL", () => {
  it("backfills all five base-URL vars + CORS from PUBLIC_BASE_URL", () => {
    const env: Env = { PUBLIC_BASE_URL: "https://pennpaps.com" };
    applyEnvAliases(env);
    for (const name of PUBLIC_BASE_URL_TARGETS) {
      expect(env[name]).toBe("https://pennpaps.com");
    }
    expect(env.RESUPPLY_ALLOWED_ORIGINS).toBe("https://pennpaps.com");
  });

  it("strips a trailing slash from PUBLIC_BASE_URL", () => {
    const env: Env = { PUBLIC_BASE_URL: "https://pennpaps.com/" };
    applyEnvAliases(env);
    expect(env.SHOP_PUBLIC_BASE_URL).toBe("https://pennpaps.com");
  });

  it("synthesizes from RAILWAY_PUBLIC_DOMAIN when PUBLIC_BASE_URL is unset", () => {
    const env: Env = { RAILWAY_PUBLIC_DOMAIN: "pennfit.up.railway.app" };
    applyEnvAliases(env);
    expect(env.RESUPPLY_VOICE_PUBLIC_BASE_URL).toBe(
      "https://pennfit.up.railway.app",
    );
    // CORS is left to the app's own RAILWAY_PUBLIC_DOMAIN handling here.
    expect(env.RESUPPLY_ALLOWED_ORIGINS).toBeUndefined();
  });

  it("never overrides an explicitly-set specific var (specific wins)", () => {
    const env: Env = {
      PUBLIC_BASE_URL: "https://pennpaps.com",
      SHOP_PUBLIC_BASE_URL: "https://shop.example.com",
    };
    applyEnvAliases(env);
    expect(env.SHOP_PUBLIC_BASE_URL).toBe("https://shop.example.com");
    expect(env.REMINDER_PUBLIC_BASE_URL).toBe("https://pennpaps.com");
  });

  it("does not touch CORS when an explicit allow-list is already set", () => {
    const env: Env = {
      PUBLIC_BASE_URL: "https://pennpaps.com",
      RESUPPLY_ALLOWED_ORIGINS: "https://a.com,https://b.com",
    };
    applyEnvAliases(env);
    expect(env.RESUPPLY_ALLOWED_ORIGINS).toBe("https://a.com,https://b.com");
  });

  it("is a no-op for base URLs when neither source is set", () => {
    const env: Env = {};
    applyEnvAliases(env);
    for (const name of PUBLIC_BASE_URL_TARGETS) {
      expect(env[name]).toBeUndefined();
    }
  });
});

describe("applyEnvAliases — OPS_EMAIL", () => {
  it("backfills all operational inboxes from OPS_EMAIL", () => {
    const env: Env = { OPS_EMAIL: "ops@pennpaps.com" };
    applyEnvAliases(env);
    for (const name of OPS_EMAIL_TARGETS) {
      expect(env[name]).toBe("ops@pennpaps.com");
    }
  });

  it("does not override a specific recipient that is already set", () => {
    const env: Env = {
      OPS_EMAIL: "ops@pennpaps.com",
      PENN_FULFILLMENT_EMAIL: "fulfillment@pennpaps.com",
    };
    applyEnvAliases(env);
    expect(env.PENN_FULFILLMENT_EMAIL).toBe("fulfillment@pennpaps.com");
    expect(env.RESUPPLY_ADMIN_ALERTS_EMAIL).toBe("ops@pennpaps.com");
  });
});

describe("applyEnvAliases — OPS_EMAIL feeds the web-push VAPID subject", () => {
  it("defaults WEB_PUSH_VAPID_SUBJECT to mailto:OPS_EMAIL", () => {
    const env: Env = { OPS_EMAIL: "ops@pennpaps.com" };
    applyEnvAliases(env);
    expect(env.WEB_PUSH_VAPID_SUBJECT).toBe("mailto:ops@pennpaps.com");
  });

  it("does not override an explicit VAPID subject", () => {
    const env: Env = {
      OPS_EMAIL: "ops@pennpaps.com",
      WEB_PUSH_VAPID_SUBJECT: "mailto:push@pennpaps.com",
    };
    applyEnvAliases(env);
    expect(env.WEB_PUSH_VAPID_SUBJECT).toBe("mailto:push@pennpaps.com");
  });
});

describe("applyEnvAliases — SendGrid From-name", () => {
  it("defaults SENDGRID_FROM_NAME to RESUPPLY_PRACTICE_NAME", () => {
    const env: Env = { RESUPPLY_PRACTICE_NAME: "Penn Home Medical" };
    applyEnvAliases(env);
    expect(env.SENDGRID_FROM_NAME).toBe("Penn Home Medical");
  });

  it("does not override an explicit From-name", () => {
    const env: Env = {
      RESUPPLY_PRACTICE_NAME: "Penn Home Medical",
      SENDGRID_FROM_NAME: "PennPaps",
    };
    applyEnvAliases(env);
    expect(env.SENDGRID_FROM_NAME).toBe("PennPaps");
  });
});

describe("applyEnvAliases — Twilio voice number", () => {
  it("aliases TWILIO_VOICE_PHONE_NUMBER to TWILIO_PHONE_NUMBER", () => {
    const env: Env = { TWILIO_PHONE_NUMBER: "+18145551234" };
    applyEnvAliases(env);
    expect(env.TWILIO_VOICE_PHONE_NUMBER).toBe("+18145551234");
  });

  it("keeps a distinct voice number if one is explicitly set", () => {
    const env: Env = {
      TWILIO_PHONE_NUMBER: "+18145551234",
      TWILIO_VOICE_PHONE_NUMBER: "+18145559999",
    };
    applyEnvAliases(env);
    expect(env.TWILIO_VOICE_PHONE_NUMBER).toBe("+18145559999");
  });
});

describe("applyEnvAliases — idempotency", () => {
  it("produces the same result when called twice", () => {
    const env: Env = {
      PUBLIC_BASE_URL: "https://pennpaps.com",
      OPS_EMAIL: "ops@pennpaps.com",
    };
    applyEnvAliases(env);
    const snapshot = { ...env };
    applyEnvAliases(env);
    expect(env).toEqual(snapshot);
  });
});
