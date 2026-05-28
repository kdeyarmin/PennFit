// Route tests for /shop/me/comm-prefs.
//
// Coverage:
//   * 401 without sign-in (GET + PUT)
//   * GET returns merged defaults when nothing stored
//   * GET returns stored prefs merged with defaults for missing keys
//   * PUT validates: rejects partial DND windows
//   * PUT rejects equal start/end DND hours
//   * PUT persists merged preferences and returns them
//   * PUT validates IANA timezone shape

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import { makeRequireSignedInMock } from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: { current: null as string | null },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

const ensureShopCustomerRowMock = vi.hoisted(() =>
  vi.fn(async () => undefined),
);
vi.mock("../../lib/stripe/customer", () => ({
  ensureShopCustomerRow: ensureShopCustomerRowMock,
}));

import commPrefsRouter from "./me-comm-prefs";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(commPrefsRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  ensureShopCustomerRowMock.mockClear();
  supabaseMock.reset();
});

describe("GET /shop/me/comm-prefs", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).get("/shop/me/comm-prefs");
    expect(res.status).toBe(401);
  });

  it("returns defaults when nothing stored", async () => {
    mockSignedIn.current = "cust_1";
    stageSupabaseResponse("shop_customers", "select", { data: null });
    const res = await request(makeApp()).get("/shop/me/comm-prefs");
    expect(res.status).toBe(200);
    expect(res.body.preferences).toMatchObject({
      preferredChannel: expect.any(String),
    });
    // ensureShopCustomerRow is called before any read.
    expect(ensureShopCustomerRowMock).toHaveBeenCalledTimes(1);
  });

  it("merges stored prefs over defaults", async () => {
    mockSignedIn.current = "cust_1";
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        communication_preferences: {
          smsMarketing: false,
          preferredChannel: "sms",
        },
      },
    });
    const res = await request(makeApp()).get("/shop/me/comm-prefs");
    expect(res.status).toBe(200);
    expect(res.body.preferences.preferredChannel).toBe("sms");
    expect(res.body.preferences.smsMarketing).toBe(false);
  });
});

describe("PUT /shop/me/comm-prefs", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp())
      .put("/shop/me/comm-prefs")
      .send({ smsMarketing: false });
    expect(res.status).toBe(401);
  });

  it("rejects partial DND (only start set)", async () => {
    mockSignedIn.current = "cust_1";
    stageSupabaseResponse("shop_customers", "select", { data: null });
    const res = await request(makeApp())
      .put("/shop/me/comm-prefs")
      .send({ dndStartHour: 22 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("dnd_partial");
  });

  it("rejects equal DND start and end", async () => {
    mockSignedIn.current = "cust_1";
    stageSupabaseResponse("shop_customers", "select", { data: null });
    const res = await request(makeApp())
      .put("/shop/me/comm-prefs")
      .send({ dndStartHour: 22, dndEndHour: 22 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("dnd_zero_window");
  });

  it("rejects malformed IANA timezone", async () => {
    mockSignedIn.current = "cust_1";
    const res = await request(makeApp())
      .put("/shop/me/comm-prefs")
      .send({ timezone: "Not A Zone!" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("persists and returns merged preferences", async () => {
    mockSignedIn.current = "cust_1";
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        communication_preferences: {
          preferredChannel: "email",
        },
      },
    });
    stageSupabaseResponse("shop_customers", "update", { data: null });

    const res = await request(makeApp()).put("/shop/me/comm-prefs").send({
      smsMarketing: false,
      preferredChannel: "sms",
      dndStartHour: 22,
      dndEndHour: 7,
      timezone: "America/New_York",
    });
    expect(res.status).toBe(200);
    expect(res.body.preferences.smsMarketing).toBe(false);
    expect(res.body.preferences.preferredChannel).toBe("sms");
    expect(res.body.preferences.dndStartHour).toBe(22);
    expect(res.body.preferences.dndEndHour).toBe(7);
    expect(res.body.preferences.timezone).toBe("America/New_York");
  });
});
