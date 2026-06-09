// Route tests for /admin/system-info — focuses on the HTTP contract
// (auth gating) and the vendor-presence computation, in particular that
// it resolves consolidated env aliases over the EFFECTIVE env so a
// credential entered in System Configuration reads as "configured" here.
//
// Regression: the "voice phone" row reads the retired
// TWILIO_VOICE_PHONE_NUMBER alias, but the only number the catalog (and
// the real call path) uses is the canonical TWILIO_PHONE_NUMBER. The
// boot-time aliaser only runs over process.env, never over the app_config
// overlay, so without applyEnvAliases() in the route a number saved in
// System Configuration never flipped this flag. See system-info.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// getEffectiveEnv would otherwise hit Supabase; pin it per test. The real
// applyEnvAliases (from @workspace/resupply-secrets) runs unmocked so the
// test exercises the actual alias resolution.
const { mockGetEffectiveEnv } = vi.hoisted(() => ({
  mockGetEffectiveEnv: vi.fn<() => Promise<NodeJS.ProcessEnv>>(),
}));
vi.mock("../../lib/app-config/store", () => ({
  getEffectiveEnv: mockGetEffectiveEnv,
}));

import systemInfoRouter from "./system-info";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(systemInfoRouter);
  return app;
}

function asAdmin() {
  mockAdmin.current = {
    userId: "u1",
    email: "boss@pennpaps.com",
    role: "admin",
    granularRole: "admin",
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  mockGetEffectiveEnv.mockReset();
  mockGetEffectiveEnv.mockResolvedValue({});
});

describe("auth gating", () => {
  it("401 when not signed in", async () => {
    const res = await request(makeApp()).get("/admin/system-info");
    expect(res.status).toBe(401);
  });
});

describe("vendor presence", () => {
  it("flips voicePhoneConfigured when only the canonical TWILIO_PHONE_NUMBER is set", async () => {
    asAdmin();
    // The retired TWILIO_VOICE_PHONE_NUMBER is deliberately absent — this
    // is exactly the shape produced when an operator enters the number in
    // System Configuration (saved under TWILIO_PHONE_NUMBER) and the
    // boot-time aliaser never ran over the app_config overlay.
    mockGetEffectiveEnv.mockResolvedValue({
      TWILIO_PHONE_NUMBER: "+12158675309",
    });

    const res = await request(makeApp()).get("/admin/system-info");
    expect(res.status).toBe(200);
    expect(res.body.vendors.twilio.voicePhoneConfigured).toBe(true);
  });

  it("reports voicePhoneConfigured false when no voice number is set", async () => {
    asAdmin();
    mockGetEffectiveEnv.mockResolvedValue({});

    const res = await request(makeApp()).get("/admin/system-info");
    expect(res.status).toBe(200);
    expect(res.body.vendors.twilio.voicePhoneConfigured).toBe(false);
  });

  it("reports sendgrid.fromEmailConfigured true when only the API key is set (From defaults to the platform constant)", async () => {
    asAdmin();
    // SENDGRID_FROM_EMAIL is deliberately absent — the From address is a
    // fixed platform constant that createSendgridClient defaults to
    // (info@pennpaps.com), so email still sends and this row must read
    // "configured". Reading the raw env var alone reported a misleading
    // "not configured" for every deploy that relied on the default.
    mockGetEffectiveEnv.mockResolvedValue({
      SENDGRID_API_KEY: "SG.xxx",
    });

    const res = await request(makeApp()).get("/admin/system-info");
    expect(res.status).toBe(200);
    expect(res.body.vendors.sendgrid.configured).toBe(true);
    expect(res.body.vendors.sendgrid.fromEmailConfigured).toBe(true);
  });

  it("reports sendgrid.fromEmailConfigured false when SendGrid is not configured (no API key)", async () => {
    asAdmin();
    // No SENDGRID_API_KEY → email sending is off. The From-address sub-flag
    // is gated on the API key so it can't read "configured" while the
    // integration itself is off, even though the platform default constant
    // (info@pennpaps.com) always exists.
    mockGetEffectiveEnv.mockResolvedValue({});

    const res = await request(makeApp()).get("/admin/system-info");
    expect(res.status).toBe(200);
    expect(res.body.vendors.sendgrid.configured).toBe(false);
    expect(res.body.vendors.sendgrid.fromEmailConfigured).toBe(false);
  });

  it("reflects other vendor flags straight from the effective env", async () => {
    asAdmin();
    mockGetEffectiveEnv.mockResolvedValue({
      STRIPE_SECRET_KEY: "sk_live_x",
      TWILIO_MESSAGING_SERVICE_SID: "MGxxx",
      OPENAI_API_KEY: "sk-x",
    });

    const res = await request(makeApp()).get("/admin/system-info");
    expect(res.status).toBe(200);
    expect(res.body.vendors.stripe.secretKeyConfigured).toBe(true);
    expect(res.body.vendors.stripe.webhookSecretConfigured).toBe(false);
    expect(res.body.vendors.twilio.messagingServiceConfigured).toBe(true);
    expect(res.body.vendors.openai.apiKeyConfigured).toBe(true);
  });
});
