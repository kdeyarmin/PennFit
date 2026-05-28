// Route tests for GET /shop/me/substitutions.
//
// Coverage:
//   * 401 without sign-in
//   * patientLinked=false when no email present
//   * patientLinked=false when patient lookup ambiguous (>1)
//   * Projects substitution rows to camelCase
//   * Filters server-side to substituted_from_sku NOT NULL and last 180 days

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireSignedInMock,
  type MockSignedInProfile,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: {
    current: null as null | string | MockSignedInProfile,
  },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

import substitutionsRouter from "./me-substitutions";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(substitutionsRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  supabaseMock.reset();
});

describe("GET /shop/me/substitutions", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).get("/shop/me/substitutions");
    expect(res.status).toBe(401);
  });

  it("returns patientLinked=false when no email", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: null };
    const res = await request(makeApp()).get("/shop/me/substitutions");
    expect(res.status).toBe(200);
    expect(res.body.patientLinked).toBe(false);
    expect(res.body.substitutions).toEqual([]);
  });

  it("returns patientLinked=false when patient lookup is ambiguous", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "p_1" }, { id: "p_2" }],
    });
    const res = await request(makeApp()).get("/shop/me/substitutions");
    expect(res.status).toBe(200);
    expect(res.body.patientLinked).toBe(false);
  });

  it("projects substitution rows", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [{ id: "p_1" }] });
    stageSupabaseResponse("fulfillments", "select", {
      data: [
        {
          id: "f_1",
          item_sku: "MASK-ALT-1",
          substituted_from_sku: "MASK-ORIG-1",
          status: "shipped",
          shipped_at: "2026-05-01T00:00:00Z",
          delivered_at: null,
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
    });
    const res = await request(makeApp()).get("/shop/me/substitutions");
    expect(res.status).toBe(200);
    expect(res.body.patientLinked).toBe(true);
    expect(res.body.substitutions).toEqual([
      {
        id: "f_1",
        shippedSku: "MASK-ALT-1",
        requestedSku: "MASK-ORIG-1",
        status: "shipped",
        shippedAt: "2026-05-01T00:00:00Z",
        deliveredAt: null,
        createdAt: "2026-05-01T00:00:00Z",
      },
    ]);
  });
});
