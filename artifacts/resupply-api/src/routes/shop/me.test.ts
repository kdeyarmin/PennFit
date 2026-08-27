// Route tests for GET /shop/me — recentOrders includes insurance
// fulfillments when email resolves to exactly one patient chart.

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

vi.mock("../../lib/customer-profile", () => ({
  readCustomerProfile: vi.fn(async () => ({
    email: "patient@example.com",
    displayName: "Pat",
  })),
}));

vi.mock("../../lib/shop-customer/record", () => ({
  ensureShopCustomerRow: vi.fn(async () => ({
    customer_id: "user_abc",
    email_lower: "patient@example.com",
    display_name: "Pat",
    shipping_address_json: null,
    cpap_device_json: null,
    physician_info_json: null,
  })),
}));

import meRouter from "./me";

const USER_ID = "user_abc";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(meRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  supabaseMock.reset();
});

describe("GET /shop/me", () => {
  it("returns signedIn false for guests", async () => {
    const res = await request(makeApp()).get("/shop/me");
    expect(res.status).toBe(200);
    expect(res.body.signedIn).toBe(false);
  });

  it("merges insurance fulfillments into recentOrders", async () => {
    mockSignedIn.current = USER_ID;
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: USER_ID,
        email_lower: "patient@example.com",
      },
    });
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "pat_1" }],
    });
    stageSupabaseResponse("shop_orders", "select", { data: [] });
    stageSupabaseResponse("fulfillments", "select", {
      data: [
        {
          id: "ful_1",
          status: "queued",
          created_at: "2024-02-01T12:00:00.000Z",
          shipped_at: null,
          delivered_at: null,
        },
      ],
    });

    const res = await request(makeApp()).get("/shop/me");
    expect(res.status).toBe(200);
    expect(res.body.signedIn).toBe(true);
    expect(res.body.recentOrders).toEqual([
      {
        id: "ful_1",
        sessionId: "",
        status: "with_warehouse",
        amountTotalCents: null,
        currency: null,
        createdAt: "2024-02-01T12:00:00.000Z",
      },
    ]);
  });
});
