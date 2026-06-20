// Tests for /admin/organization/phone-settings — tenant voice + SMS numbers.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";

const { mockAdmin, state, TwilioConfigError, TwilioApiError } = vi.hoisted(
  () => {
    class TwilioConfigError extends Error {}
    class TwilioApiError extends Error {}
    return {
      mockAdmin: { current: null as MockAdminCtx | null },
      state: {
        orgRow: {
          voice_from_number: null as string | null,
          sms_from_number: null as string | null,
          twilio_messaging_service_sid: null as string | null,
          slug: "acme" as string | null,
        },
        updateError: null as { code?: string } | null,
        lastUpdate: null as Record<string, unknown> | null,
        provisioned: { sid: "PN1", phoneNumber: "+12155550111" },
        provisionThrow: null as unknown,
      },
      TwilioConfigError,
      TwilioApiError,
    };
  },
);

vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

vi.mock("../../middlewares/admin-rate-limit", () => {
  const passthrough = (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next();
  return {
    adminRateLimit: () => passthrough,
    adminReadRateLimiter: passthrough,
  };
});

vi.mock("@workspace/resupply-db", () => ({
  resolveSeedOrgId: async () => "org",
  getOrgScopedClient: () => ({
    raw: () => ({
      schema: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: state.orgRow, error: null }),
              }),
            }),
          }),
          update: (obj: Record<string, unknown>) => {
            state.lastUpdate = obj;
            return {
              eq: async () => {
                if (!state.updateError) Object.assign(state.orgRow, obj);
                return { error: state.updateError };
              },
            };
          },
        }),
      }),
    }),
  }),
}));

vi.mock("@workspace/resupply-telecom", () => ({
  TwilioConfigError,
  TwilioApiError,
  createTwilioNumberClient: () => ({
    provisionNumber: async () => {
      if (state.provisionThrow) throw state.provisionThrow;
      return state.provisioned;
    },
  }),
}));

vi.mock("@workspace/resupply-audit", () => ({ logAudit: async () => {} }));
vi.mock("../../lib/messaging/tenant-telecom", () => ({
  invalidateTenantTelecomCache: () => {},
}));
vi.mock("../../lib/voice/voice-config", () => ({
  readVoicePublicBaseUrlOrNull: () => "https://app.example",
}));

import phoneSettingsRouter from "./phone-settings";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(phoneSettingsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = {
    email: "owner@acme",
    userId: "u_owner",
    role: "admin",
    granularRole: "admin",
  };
  state.orgRow = {
    voice_from_number: null,
    sms_from_number: null,
    twilio_messaging_service_sid: null,
    slug: "acme",
  };
  state.updateError = null;
  state.lastUpdate = null;
  state.provisioned = { sid: "PN1", phoneNumber: "+12155550111" };
  state.provisionThrow = null;
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "tok";
});

// These tests mutate the Twilio env vars; capture and restore the original
// values so we never leak into sibling test files sharing this worker
// (the deploy environment has real Twilio creds set).
const ORIGINAL_TWILIO_ENV = {
  sid: process.env.TWILIO_ACCOUNT_SID,
  token: process.env.TWILIO_AUTH_TOKEN,
};
afterEach(() => {
  if (ORIGINAL_TWILIO_ENV.sid === undefined)
    delete process.env.TWILIO_ACCOUNT_SID;
  else process.env.TWILIO_ACCOUNT_SID = ORIGINAL_TWILIO_ENV.sid;
  if (ORIGINAL_TWILIO_ENV.token === undefined)
    delete process.env.TWILIO_AUTH_TOKEN;
  else process.env.TWILIO_AUTH_TOKEN = ORIGINAL_TWILIO_ENV.token;
});

describe("GET /admin/organization/phone-settings", () => {
  it("401s when unauthenticated", async () => {
    mockAdmin.current = null;
    const res = await request(makeApp()).get(
      "/admin/organization/phone-settings",
    );
    expect(res.status).toBe(401);
  });

  it("returns current numbers + canProvision", async () => {
    state.orgRow.voice_from_number = "+12155550000";
    const res = await request(makeApp()).get(
      "/admin/organization/phone-settings",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      voiceNumber: "+12155550000",
      smsNumber: null,
      messagingServiceSid: null,
      canProvision: true,
    });
  });

  it("reports canProvision:false when Twilio creds are absent", async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    const res = await request(makeApp()).get(
      "/admin/organization/phone-settings",
    );
    expect(res.body.canProvision).toBe(false);
  });
});

describe("POST /admin/organization/phone-settings/provision", () => {
  it("buys a number and assigns it to both slots by default", async () => {
    const res = await request(makeApp())
      .post("/admin/organization/phone-settings/provision")
      .send({ areaCode: "215" });
    expect(res.status).toBe(201);
    expect(res.body.provisioned).toBe("+12155550111");
    expect(state.lastUpdate).toEqual({
      voice_from_number: "+12155550111",
      sms_from_number: "+12155550111",
    });
  });

  it("assigns only the requested slot", async () => {
    await request(makeApp())
      .post("/admin/organization/phone-settings/provision")
      .send({ assign: ["sms"] });
    expect(state.lastUpdate).toEqual({ sms_from_number: "+12155550111" });
  });

  it("409s when a targeted slot already has a number", async () => {
    state.orgRow.sms_from_number = "+12155559999";
    const res = await request(makeApp())
      .post("/admin/organization/phone-settings/provision")
      .send({ assign: ["sms"] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("phone_already_provisioned");
  });

  it("503s when provisioning isn't configured", async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const res = await request(makeApp())
      .post("/admin/organization/phone-settings/provision")
      .send({});
    expect(res.status).toBe(503);
  });

  it("502s when Twilio provisioning fails", async () => {
    state.provisionThrow = new TwilioApiError("no numbers");
    const res = await request(makeApp())
      .post("/admin/organization/phone-settings/provision")
      .send({});
    expect(res.status).toBe(502);
  });
});

describe("PATCH /admin/organization/phone-settings", () => {
  it("sets the SMS number", async () => {
    const res = await request(makeApp())
      .patch("/admin/organization/phone-settings")
      .send({ smsNumber: "+12155551234" });
    expect(res.status).toBe(200);
    expect(state.lastUpdate).toEqual({ sms_from_number: "+12155551234" });
    expect(res.body.smsNumber).toBe("+12155551234");
  });

  it("clears the voice number with null", async () => {
    state.orgRow.voice_from_number = "+12155550000";
    await request(makeApp())
      .patch("/admin/organization/phone-settings")
      .send({ voiceNumber: null });
    expect(state.lastUpdate).toEqual({ voice_from_number: null });
  });

  it("rejects an empty body", async () => {
    const res = await request(makeApp())
      .patch("/admin/organization/phone-settings")
      .send({});
    expect(res.status).toBe(400);
  });

  it("rejects a malformed E.164 number", async () => {
    const res = await request(makeApp())
      .patch("/admin/organization/phone-settings")
      .send({ smsNumber: "215-555-1234" });
    expect(res.status).toBe(400);
  });

  it("409s on a unique-constraint collision", async () => {
    state.updateError = { code: "23505" };
    const res = await request(makeApp())
      .patch("/admin/organization/phone-settings")
      .send({ smsNumber: "+12155551234" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("phone_number_in_use");
  });
});
