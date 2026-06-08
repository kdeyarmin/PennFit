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
  adminReadRateLimiter: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

const { ClaimNotForPatientError } = vi.hoisted(() => {
  class ClaimNotForPatientError extends Error {}
  return { ClaimNotForPatientError };
});
const submitFn = vi.hoisted(() => ({
  current: vi.fn(async (..._a: unknown[]) => ({
    claimStatusCheckId: "csc_1",
    isaControlNumber: "000000009",
    traceReference: "T",
    uploadOk: true,
    errorMessage: null,
  })),
}));
vi.mock("../../lib/billing/claim-status-checker", () => ({
  ClaimNotForPatientError,
  submitClaimStatusCheck: (...args: unknown[]) => submitFn.current(...args),
}));

import claimStatusRouter from "./claim-status";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "biller@penn.example.com",
  role: "admin",
};
const PID = "11111111-1111-4111-8111-111111111111";
const CLAIM_ID = "22222222-2222-4222-8222-222222222222";
const url = `/admin/patients/${PID}/insurance-claims/${CLAIM_ID}/status-check`;

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(claimStatusRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  submitFn.current = vi.fn(async (..._a: unknown[]) => ({
    claimStatusCheckId: "csc_1",
    isaControlNumber: "000000009",
    traceReference: "T",
    uploadOk: true,
    errorMessage: null,
  }));
});

describe("POST status-check", () => {
  it("401 unauthenticated", async () => {
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(401);
  });

  it("201 + records the check on success", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("csc_1");
    expect(res.body.uploadOk).toBe(true);
  });

  it("404 when the claim isn't the patient's", async () => {
    mockAdmin.current = ADMIN;
    submitFn.current = vi.fn(async () => {
      throw new ClaimNotForPatientError();
    });
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("claim_not_found");
  });

  it("422 when the payer isn't electronic", async () => {
    mockAdmin.current = ADMIN;
    submitFn.current = vi.fn(async () => {
      throw new Error("payer does not accept electronic 276/277");
    });
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("payer_not_electronic");
  });
});
