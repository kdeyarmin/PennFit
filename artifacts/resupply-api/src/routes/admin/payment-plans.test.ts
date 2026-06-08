import { describe, it, expect, vi, beforeEach } from "vitest";
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
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  adminReadRateLimiter: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

import paymentPlansRouter from "./payment-plans";

// CSR holds patients.read + patients.update.
const CSR: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};
const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const PLAN_ID = "22222222-2222-4222-8222-222222222222";
const INST_ID = "33333333-3333-4333-8333-333333333333";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(paymentPlansRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("POST /admin/patients/:id/payment-plans", () => {
  it("401 unauthenticated", async () => {
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/payment-plans`)
      .send({
        totalAmountCents: 10000,
        installmentCount: 3,
        startDate: "2026-01-15",
      });
    expect(res.status).toBe(401);
  });

  it("404 when the patient doesn't exist", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("patients", "select", { data: null });
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/payment-plans`)
      .send({
        totalAmountCents: 10000,
        installmentCount: 3,
        startDate: "2026-01-15",
      });
    expect(res.status).toBe(404);
  });

  it("creates a plan and returns the generated schedule", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("patient_payment_plans", "insert", {
      data: { id: PLAN_ID },
    });
    stageSupabaseResponse("patient_payment_plan_installments", "insert", {
      data: null,
    });
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/payment-plans`)
      .send({
        totalAmountCents: 10000,
        installmentCount: 3,
        frequency: "monthly",
        startDate: "2026-01-15",
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(PLAN_ID);
    expect(res.body.installments).toHaveLength(3);
    expect(
      res.body.installments.reduce(
        (t: number, i: { amountCents: number }) => t + i.amountCents,
        0,
      ),
    ).toBe(10000);
  });

  it("400 on an invalid installment count", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/payment-plans`)
      .send({
        totalAmountCents: 10000,
        installmentCount: 1, // min is 2
        startDate: "2026-01-15",
      });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /admin/payment-plan-installments/:id", () => {
  it("settles an installment and recomputes plan status to completed", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("patient_payment_plan_installments", "select", {
      data: { id: INST_ID, plan_id: PLAN_ID },
    });
    stageSupabaseResponse("patient_payment_plan_installments", "update", {
      data: null,
    });
    // sibling read after update — all paid → plan completes
    stageSupabaseResponse("patient_payment_plan_installments", "select", {
      data: [
        { amount_cents: 5000, status: "paid", due_date: "2026-01-15" },
        { amount_cents: 5000, status: "paid", due_date: "2026-02-15" },
      ],
    });
    stageSupabaseResponse("patient_payment_plans", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/payment-plan-installments/${INST_ID}`)
      .send({ status: "paid" });
    expect(res.status).toBe(200);
    expect(res.body.planStatus).toBe("completed");
  });

  it("404 when the installment doesn't exist", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("patient_payment_plan_installments", "select", {
      data: null,
    });
    const res = await request(makeApp())
      .patch(`/admin/payment-plan-installments/${INST_ID}`)
      .send({ status: "paid" });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /admin/payment-plans/:id (cancel)", () => {
  it("cancels an active plan", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("patient_payment_plans", "update", {
      data: [{ id: PLAN_ID }],
    });
    const res = await request(makeApp())
      .patch(`/admin/payment-plans/${PLAN_ID}`)
      .send({ status: "cancelled" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
  });

  it("409 when nothing was cancellable (e.g. already completed)", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("patient_payment_plans", "update", { data: [] });
    const res = await request(makeApp())
      .patch(`/admin/payment-plans/${PLAN_ID}`)
      .send({ status: "cancelled" });
    expect(res.status).toBe(409);
  });
});
