// Tests for CSR #11 click-to-dial + disposition — the pure call-window
// guard + the two routes' gates, guardrails, and wiring. Twilio is
// mocked so no real dial is placed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

const placeCallMock = vi.fn();
vi.mock("@workspace/resupply-telecom", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-telecom")
  >("@workspace/resupply-telecom");
  return {
    ...actual,
    createTwilioClient: vi.fn(() => ({ placeCall: placeCallMock })),
  };
});

import clickToDialRouter, { withinCallWindow } from "./click-to-dial";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "csr@penn.example.com",
  role: "admin",
};
const RT: MockAdminCtx = {
  userId: "u_rt",
  email: "rt@penn.example.com",
  role: "agent",
  granularRole: "rt",
};

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const DISPOSITION_ID = "22222222-2222-4222-8222-222222222222";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(clickToDialRouter);
  return app;
}

function configureVoice() {
  process.env.OPENAI_API_KEY = "test-openai";
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "test-token";
  process.env.TWILIO_PHONE_NUMBER = "+12158675309";
  process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL = "https://test.example.com";
}

const VOICE_ENV = [
  "OPENAI_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "RESUPPLY_VOICE_PUBLIC_BASE_URL",
] as const;

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  placeCallMock.mockReset();
  for (const k of VOICE_ENV) delete process.env[k];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("withinCallWindow (pure)", () => {
  it("is false on a Sunday", () => {
    expect(withinCallWindow(new Date("2026-01-04T17:00:00Z"))).toBe(false);
  });
  it("is true on a weekday midday ET", () => {
    expect(withinCallWindow(new Date("2026-01-05T17:00:00Z"))).toBe(true);
  });
  it("is false before 9am ET", () => {
    expect(withinCallWindow(new Date("2026-01-05T08:00:00Z"))).toBe(false);
  });
});

describe("POST /admin/patients/:id/click-to-dial", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).post(
      `/admin/patients/${PATIENT_ID}/click-to-dial`,
    );
    expect(res.status).toBe(401);
  });

  it("403s for a role without conversations.manage (rt)", async () => {
    mockAdmin.current = RT;
    const res = await request(makeApp()).post(
      `/admin/patients/${PATIENT_ID}/click-to-dial`,
    );
    expect(res.status).toBe(403);
  });

  it("400s on a non-uuid patient id", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).post(
      "/admin/patients/not-a-uuid/click-to-dial",
    );
    expect(res.status).toBe(400);
  });

  it("503s when outbound voice isn't configured", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).post(
      `/admin/patients/${PATIENT_ID}/click-to-dial`,
    );
    expect(res.status).toBe(503);
  });

  it("404s when the patient doesn't exist", async () => {
    mockAdmin.current = ADMIN;
    configureVoice();
    stageSupabaseResponse("patients", "select", { data: null });
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/click-to-dial`)
      .send({ override: true });
    expect(res.status).toBe(404);
  });

  it("422s when the patient has no phone", async () => {
    mockAdmin.current = ADMIN;
    configureVoice();
    stageSupabaseResponse("patients", "select", {
      data: { status: "active", phone_e164: null },
    });
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/click-to-dial`)
      .send({ override: true });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("patient_missing_phone");
  });

  it("409s outside the call window without override", async () => {
    mockAdmin.current = ADMIN;
    configureVoice();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-04T17:00:00Z")); // Sunday
    stageSupabaseResponse("patients", "select", {
      data: { status: "active", phone_e164: "+12155551212" },
    });
    const res = await request(makeApp()).post(
      `/admin/patients/${PATIENT_ID}/click-to-dial`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("outside_call_window");
  });

  it("422s when the agent has no bridge phone on file", async () => {
    mockAdmin.current = ADMIN;
    configureVoice();
    stageSupabaseResponse("patients", "select", {
      data: { status: "active", phone_e164: "+12155551212" },
    });
    stageSupabaseResponse("admin_users", "select", {
      data: { phone_e164: null },
    });
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/click-to-dial`)
      .send({ override: true });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("agent_phone_missing");
  });

  it("places the bridge and returns the disposition + call sid", async () => {
    mockAdmin.current = ADMIN;
    configureVoice();
    stageSupabaseResponse("patients", "select", {
      data: { status: "active", phone_e164: "+12155551212" },
    });
    stageSupabaseResponse("admin_users", "select", {
      data: { phone_e164: "+19998887777" },
    });
    stageSupabaseResponse("call_dispositions", "insert", {
      data: { id: DISPOSITION_ID },
    });
    stageSupabaseResponse("call_dispositions", "update", { data: null });
    placeCallMock.mockResolvedValue({ sid: "CAtest123" });

    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/click-to-dial`)
      .send({ override: true });
    expect(res.status).toBe(201);
    expect(res.body.dispositionId).toBe(DISPOSITION_ID);
    expect(res.body.callSid).toBe("CAtest123");
    // Twilio dials the AGENT first (agent-first bridge).
    expect(placeCallMock).toHaveBeenCalledOnce();
    expect(placeCallMock.mock.calls[0][0].to).toBe("+19998887777");
  });
});

describe("POST /admin/call-dispositions/:id", () => {
  it("400s on an invalid outcome", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post(`/admin/call-dispositions/${DISPOSITION_ID}`)
      .send({ outcome: "bogus" });
    expect(res.status).toBe(400);
  });

  it("404s when the disposition doesn't exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("call_dispositions", "update", { data: null });
    const res = await request(makeApp())
      .post(`/admin/call-dispositions/${DISPOSITION_ID}`)
      .send({ outcome: "reached" });
    expect(res.status).toBe(404);
  });

  it("logs the outcome", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("call_dispositions", "update", {
      data: { id: DISPOSITION_ID, outcome: "reached" },
    });
    const res = await request(makeApp())
      .post(`/admin/call-dispositions/${DISPOSITION_ID}`)
      .send({ outcome: "reached", note: "Confirmed new mask ships Monday." });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("reached");
  });
});
