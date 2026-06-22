// /platform/cost-rates — vendor cost-rate card.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequirePlatformAdminMock,
  type MockPlatformAdminRef,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockPlatformAdmin } = vi.hoisted(() => ({
  mockPlatformAdmin: { current: null } as MockPlatformAdminRef,
}));
vi.mock("../../middlewares/requirePlatformAdmin", () =>
  makeRequirePlatformAdminMock(mockPlatformAdmin),
);

import costRatesRouter from "./cost-rates";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(costRatesRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  mockPlatformAdmin.current = null;
});

describe("GET /platform/cost-rates", () => {
  it("401s for a non-platform-admin", async () => {
    const res = await request(makeApp()).get("/platform/cost-rates");
    expect(res.status).toBe(401);
  });

  it("returns saved rates and defaults unset ones to 0", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    stageSupabaseResponse("app_config", "select", {
      data: [
        { key: "cost_rate.ai_input_per_1m_cents", value: "300" },
        { key: "cost_rate.ai_output_per_1m_cents", value: "1500" },
      ],
    });
    const res = await request(makeApp()).get("/platform/cost-rates");
    expect(res.status).toBe(200);
    expect(res.body.rates).toMatchObject({
      aiInputPer1mCents: 300,
      aiOutputPer1mCents: 1500,
      outboundMessageCents: 0,
      aiVoiceEventCents: 0,
      faxEventCents: 0,
    });
  });
});

describe("PUT /platform/cost-rates", () => {
  it("400s on a negative rate", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    const res = await request(makeApp())
      .put("/platform/cost-rates")
      .send({ aiInputPer1mCents: -5 });
    expect(res.status).toBe(400);
  });

  it("upserts provided rates and echoes the effective set", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    stageSupabaseResponse("app_config", "upsert", { error: null });
    stageSupabaseResponse("app_config", "select", {
      data: [
        { key: "cost_rate.ai_input_per_1m_cents", value: "300" },
        { key: "cost_rate.outbound_message_cents", value: "1" },
      ],
    });
    const res = await request(makeApp())
      .put("/platform/cost-rates")
      .send({ aiInputPer1mCents: 300, outboundMessageCents: 1 });
    expect(res.status).toBe(200);
    expect(res.body.rates).toMatchObject({
      aiInputPer1mCents: 300,
      outboundMessageCents: 1,
    });
    const upserts = supabaseMock.writePayloads("app_config", "upsert");
    const written = upserts[0] as Array<{ key: string; value: string }>;
    expect(written.map((r) => r.key)).toContain(
      "cost_rate.ai_input_per_1m_cents",
    );
  });
});
