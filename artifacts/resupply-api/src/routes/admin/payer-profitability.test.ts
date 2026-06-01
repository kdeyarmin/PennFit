// Tests for /admin/billing/payer-profitability (Owner #2) — the pure
// rollup + the HTTP route.

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

import payerProfitabilityRouter, {
  buildPayerProfitability,
  type PayerClaimInput,
} from "./payer-profitability";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "owner@penn.example.com",
  role: "admin",
};
const CSR: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(payerProfitabilityRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("buildPayerProfitability (pure)", () => {
  it("rolls up per payer, sorts by collected desc, keeps the cost split honest", () => {
    const claims: PayerClaimInput[] = [
      {
        payerKey: "aetna",
        payerName: "Aetna",
        status: "paid",
        billedCents: 10000,
        allowedCents: 8000,
        paidCents: 8000,
        costCents: 3000,
      },
      {
        payerKey: "aetna",
        payerName: "Aetna",
        status: "denied",
        billedCents: 5000,
        allowedCents: 0,
        paidCents: 0,
        costCents: null, // no costed line
      },
      {
        payerKey: "uhc",
        payerName: "UHC",
        status: "paid",
        billedCents: 20000,
        allowedCents: 15000,
        paidCents: 15000,
        costCents: 6000,
      },
    ];
    const { payers, totals } = buildPayerProfitability(claims);

    // UHC collected more → first.
    expect(payers.map((p) => p.payerKey)).toEqual(["uhc", "aetna"]);

    const aetna = payers.find((p) => p.payerKey === "aetna")!;
    expect(aetna.claimCount).toBe(2);
    expect(aetna.deniedCount).toBe(1);
    expect(aetna.denialRate).toBeCloseTo(0.5, 5);
    expect(aetna.billedCents).toBe(15000);
    expect(aetna.paidCents).toBe(8000);
    expect(aetna.collectionRate).toBeCloseTo(8000 / 15000, 5);
    expect(aetna.costKnownCents).toBe(3000);
    expect(aetna.claimsWithCost).toBe(1);
    expect(aetna.claimsWithoutCost).toBe(1);
    expect(aetna.netCents).toBe(5000); // 8000 paid − 3000 known cost

    expect(totals.claimCount).toBe(3);
    expect(totals.paidCents).toBe(23000);
    expect(totals.netCents).toBe(14000); // 23000 − 9000 known cost
  });
});

describe("GET /admin/billing/payer-profitability", () => {
  it("401s without admin", async () => {
    expect(
      (await request(makeApp()).get("/admin/billing/payer-profitability"))
        .status,
    ).toBe(401);
  });

  it("403s for a role without cost.read (csr)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp()).get(
      "/admin/billing/payer-profitability",
    );
    expect(res.status).toBe(403);
    expect(res.body.requiredPermission).toBe("cost.read");
  });

  it("joins claim line-item COGS and returns the per-payer rollup", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        {
          id: "c1",
          payer_name: "Aetna",
          payer_profile_id: "pay_aetna",
          status: "paid",
          total_billed_cents: 10000,
          total_allowed_cents: 8000,
          total_paid_cents: 8000,
        },
        {
          id: "c2",
          payer_name: "Aetna",
          payer_profile_id: "pay_aetna",
          status: "denied",
          total_billed_cents: 5000,
          total_allowed_cents: 0,
          total_paid_cents: 0,
        },
      ],
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [
        { claim_id: "c1", quantity: 2, unit_cost_cents: 1500 }, // 3000 cost
        { claim_id: "c2", quantity: 1, unit_cost_cents: null }, // uncosted
      ],
    });

    const res = await request(makeApp()).get(
      "/admin/billing/payer-profitability?days=180",
    );
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(180);
    expect(res.body.payers).toHaveLength(1);
    const aetna = res.body.payers[0];
    expect(aetna.payerKey).toBe("pay_aetna");
    expect(aetna.claimCount).toBe(2);
    expect(aetna.costKnownCents).toBe(3000);
    expect(aetna.claimsWithoutCost).toBe(1);
    expect(aetna.netCents).toBe(5000);
    expect(res.body.totals.paidCents).toBe(8000);
  });
});
