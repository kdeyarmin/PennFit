// Tests for POST /admin/billing/fulfillments/batch-create-claims.
//
// The per-fulfillment create core (createClaimFromFulfillment) is mocked here
// — its persist/duplicate contract is covered in
// lib/billing/create-claim-from-fulfillment.test.ts. These tests pin the
// BATCH orchestration: auth gate, validation, per-item isolation, de-dupe,
// and the aggregated result/summary shape.

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
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: vi.fn(async () => false),
}));
vi.mock("../../lib/billing/create-claim-from-fulfillment", () => ({
  createClaimFromFulfillment: vi.fn(),
}));

import { createClaimFromFulfillment } from "../../lib/billing/create-claim-from-fulfillment";
import batchRouter from "./billing-batch-create-claims";

const createMock = vi.mocked(createClaimFromFulfillment);

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "biller@penn.example.com",
  role: "admin",
};
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const url = "/admin/billing/fulfillments/batch-create-claims";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(batchRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  createMock.mockReset();
});

describe("POST /admin/billing/fulfillments/batch-create-claims", () => {
  it("401 unauthenticated", async () => {
    const res = await request(makeApp())
      .post(url)
      .send({ fulfillmentIds: [A] });
    expect(res.status).toBe(401);
  });

  it("400 on an empty id list", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).post(url).send({ fulfillmentIds: [] });
    expect(res.status).toBe(400);
  });

  it("400 on a non-uuid id", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post(url)
      .send({ fulfillmentIds: ["not-a-uuid"] });
    expect(res.status).toBe(400);
  });

  it("aggregates per-item outcomes and returns 200", async () => {
    mockAdmin.current = ADMIN;
    createMock.mockImplementation(async ({ fulfillmentId }) => {
      if (fulfillmentId === A)
        return {
          status: "created",
          claimId: "c-a",
          lineCount: 2,
          proposed: {} as never,
        };
      if (fulfillmentId === B)
        return {
          status: "claim_exists",
          claimId: "c-b",
          existingStatus: "submitted",
        };
      return { status: "fulfillment_not_found" };
    });

    const res = await request(makeApp())
      .post(url)
      .send({ fulfillmentIds: [A, B, C] });

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({
      requested: 3,
      created: 1,
      claimExists: 1,
      notFound: 1,
      errored: 0,
    });
    expect(res.body.results).toHaveLength(3);
    const byId = Object.fromEntries(
      (
        res.body.results as Array<{ fulfillmentId: string; status: string }>
      ).map((r) => [r.fulfillmentId, r.status]),
    );
    expect(byId[A]).toBe("created");
    expect(byId[B]).toBe("claim_exists");
    expect(byId[C]).toBe("fulfillment_not_found");
  });

  it("isolates a thrown item as 'error' without aborting the batch", async () => {
    mockAdmin.current = ADMIN;
    createMock.mockImplementation(async ({ fulfillmentId }) => {
      if (fulfillmentId === B) throw new Error("boom");
      return {
        status: "created",
        claimId: "c",
        lineCount: 1,
        proposed: {} as never,
      };
    });

    const res = await request(makeApp())
      .post(url)
      .send({ fulfillmentIds: [A, B, C] });

    expect(res.status).toBe(200);
    expect(res.body.summary.created).toBe(2);
    expect(res.body.summary.errored).toBe(1);
    const errored = (
      res.body.results as Array<{ fulfillmentId: string; status: string }>
    ).find((r) => r.status === "error");
    expect(errored?.fulfillmentId).toBe(B);
  });

  it("de-dupes repeated ids so a fulfillment is processed once", async () => {
    mockAdmin.current = ADMIN;
    createMock.mockResolvedValue({
      status: "created",
      claimId: "c",
      lineCount: 1,
      proposed: {} as never,
    });

    const res = await request(makeApp())
      .post(url)
      .send({ fulfillmentIds: [A, A, B] });

    expect(res.status).toBe(200);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(res.body.summary.requested).toBe(2);
  });

  it("500 when tenant context is missing", async () => {
    mockAdmin.current = { ...ADMIN, orgId: null };
    const res = await request(makeApp())
      .post(url)
      .send({ fulfillmentIds: [A] });
    expect(res.status).toBe(500);
  });
});
