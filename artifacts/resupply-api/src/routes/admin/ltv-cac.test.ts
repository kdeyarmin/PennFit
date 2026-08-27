// Route tests for /admin/analytics/ltv-cac + the acquisition upsert
// (Owner #3). The cohort math itself is unit-tested in
// @workspace/resupply-domain (ltv-cac.test.ts); here we cover the
// join/shape, gates, and the upsert.

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
  stageSupabaseRpcResponse,
  getSupabaseRpcArgs,
  getSupabaseCallCount,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({ logAudit: logAuditMock }));

import ltvCacRouter from "./ltv-cac";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "owner@penn.example.com",
  role: "admin",
};
// csr lacks cost.read / cost.write (finance perms).
const CSR: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(ltvCacRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("GET /admin/analytics/ltv-cac", () => {
  it("401s without admin", async () => {
    expect(
      (await request(makeApp()).get("/admin/analytics/ltv-cac")).status,
    ).toBe(401);
  });

  it("403s for a role without cost.read (csr)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp()).get("/admin/analytics/ltv-cac");
    expect(res.status).toBe(403);
    expect(res.body.requiredPermission).toBe("cost.read");
  });

  it("rolls up the per-customer economics RPC by channel", async () => {
    mockAdmin.current = ADMIN;
    // resupply.ltv_cac_customer_economics returns one flattened row per
    // customer (the union of paid-revenue + attribution). c1 paid
    // 30000 shop + 10000 linked insurance = 40000 on paid_search
    // (cost 8000); c2 paid 20000 with no attribution → unattributed.
    stageSupabaseRpcResponse("ltv_cac_customer_economics", {
      data: [
        {
          customer_id: "c1",
          lifetime_revenue_cents: 40000,
          shop_revenue_cents: 30000,
          insurance_revenue_cents: 10000,
          patient_id: "11111111-1111-4111-8111-111111111111",
          channel: "paid_search",
          acquisition_cost_cents: 8000,
        },
        {
          customer_id: "c2",
          lifetime_revenue_cents: 20000,
          shop_revenue_cents: 20000,
          insurance_revenue_cents: 0,
          patient_id: null,
          channel: null,
          acquisition_cost_cents: null,
        },
      ],
    });
    stageSupabaseResponse("insurance_claims", "select", {
      data: [{ total_paid_cents: 50000 }],
      count: 1,
    });

    const res = await request(makeApp()).get("/admin/analytics/ltv-cac");
    expect(res.status).toBe(200);

    // The RPC is org-scoped via p_org_id.
    const args = getSupabaseRpcArgs("ltv_cac_customer_economics")[0] as {
      p_org_id?: unknown;
    };
    expect(args.p_org_id).toBeDefined();

    const paid = res.body.byChannel.find(
      (c: { channel: string }) => c.channel === "paid_search",
    );
    expect(paid.customerCount).toBe(1);
    expect(paid.avgLtvCents).toBe(40000); // shop + linked insurance
    expect(paid.avgCacCents).toBe(8000);
    expect(paid.ltvToCacRatio).toBeCloseTo(5.0, 5);

    const unattributed = res.body.byChannel.find(
      (c: { channel: string }) => c.channel === "unattributed",
    );
    expect(unattributed.customerCount).toBe(1);
    expect(unattributed.avgLtvCents).toBe(20000);
    expect(unattributed.avgCacCents).toBeNull();

    expect(res.body.totals.customerCount).toBe(2);
    expect(res.body.totals.totalRevenueCents).toBe(60000);

    expect(res.body.insuranceRemittance).toMatchObject({
      eraPayerPaidCents: 50000,
      paidClaimCount: 1,
      linkedToCustomersCents: 10000,
      linkedCustomerCount: 1,
      includedInLtvRatio: true,
      possiblyIncomplete: false,
    });
  });

  it("handles bigint cents coming back as strings from the RPC", async () => {
    // PostgREST returns bigint columns as JSON strings; the route must
    // Number() them so the rollup math stays integer-correct.
    mockAdmin.current = ADMIN;
    stageSupabaseRpcResponse("ltv_cac_customer_economics", {
      data: [
        {
          customer_id: "c1",
          lifetime_revenue_cents: "40000",
          shop_revenue_cents: "40000",
          insurance_revenue_cents: "0",
          patient_id: null,
          channel: "paid_search",
          acquisition_cost_cents: 8000,
        },
      ],
    });
    stageSupabaseResponse("insurance_claims", "select", {
      data: [],
      count: 0,
    });
    const res = await request(makeApp()).get("/admin/analytics/ltv-cac");
    expect(res.status).toBe(200);
    const paid = res.body.byChannel.find(
      (c: { channel: string }) => c.channel === "paid_search",
    );
    expect(paid.avgLtvCents).toBe(40000);
    expect(res.body.totals.totalRevenueCents).toBe(40000);
    expect(res.body.insuranceRemittance.includedInLtvRatio).toBe(false);
    expect(res.body.insuranceRemittance.linkedToCustomersCents).toBe(0);
  });
});

describe("PUT /admin/customers/:customerId/acquisition", () => {
  it("403s for a role without cost.write (csr)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp())
      .put("/admin/customers/cust_1/acquisition")
      .send({ channel: "paid_social" });
    expect(res.status).toBe(403);
    expect(getSupabaseCallCount("customer_acquisition", "upsert")).toBe(0);
  });

  it("400s on an invalid channel", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .put("/admin/customers/cust_1/acquisition")
      .send({ channel: "tiktok" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("upserts the attribution + audits (cost optional)", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("customer_acquisition", "upsert", {
      data: { customer_id: "cust_1", channel: "fitter", patient_id: null },
    });
    const res = await request(makeApp())
      .put("/admin/customers/cust_1/acquisition")
      .send({
        channel: "fitter",
        acquisitionCostCents: 2500,
        sourceDetail: "fitter:jane",
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      customerId: "cust_1",
      channel: "fitter",
      patientId: null,
    });

    const payload = getSupabaseWritePayloads(
      "customer_acquisition",
      "upsert",
    )[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      customer_id: "cust_1",
      channel: "fitter",
      acquisition_cost_cents: 2500,
      source_detail: "fitter:jane",
    });
    expect(payload).not.toHaveProperty("patient_id");

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("customer_acquisition.upsert");
    expect(audit.metadata).toEqual({
      channel: "fitter",
      cost_known: true,
      patient_linked: false,
    });
  });

  it("records attribution with unknown cost (cost_known false)", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("customer_acquisition", "upsert", {
      data: { customer_id: "cust_2", channel: "organic", patient_id: null },
    });
    const res = await request(makeApp())
      .put("/admin/customers/cust_2/acquisition")
      .send({ channel: "organic" });
    expect(res.status).toBe(200);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      metadata: Record<string, unknown>;
    };
    expect(audit.metadata).toEqual({
      channel: "organic",
      cost_known: false,
      patient_linked: false,
    });
  });

  it("links a patient after verifying they exist in-tenant", async () => {
    mockAdmin.current = ADMIN;
    const patientId = "22222222-2222-4222-8222-222222222222";
    stageSupabaseResponse("patients", "select", {
      data: { id: patientId },
    });
    stageSupabaseResponse("customer_acquisition", "upsert", {
      data: {
        customer_id: "cust_3",
        channel: "insurance_lead",
        patient_id: patientId,
      },
    });
    const res = await request(makeApp())
      .put("/admin/customers/cust_3/acquisition")
      .send({ channel: "insurance_lead", patientId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      customerId: "cust_3",
      channel: "insurance_lead",
      patientId,
    });
    expect(getSupabaseCallCount("patients", "select")).toBe(1);
    const payload = getSupabaseWritePayloads(
      "customer_acquisition",
      "upsert",
    )[0] as Record<string, unknown>;
    expect(payload.patient_id).toBe(patientId);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      metadata: Record<string, unknown>;
    };
    expect(audit.metadata.patient_linked).toBe(true);
  });

  it("404s when patientId is not in the tenant", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patients", "select", { data: null });
    const res = await request(makeApp())
      .put("/admin/customers/cust_3/acquisition")
      .send({
        channel: "organic",
        patientId: "33333333-3333-4333-8333-333333333333",
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("patient_not_found");
    expect(getSupabaseCallCount("customer_acquisition", "upsert")).toBe(0);
  });
});
