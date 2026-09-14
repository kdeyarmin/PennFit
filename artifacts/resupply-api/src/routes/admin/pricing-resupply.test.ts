import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";
const db = installSupabaseMock();
const { admin, prepare } = vi.hoisted(() => ({
  admin: { current: null as MockAdminCtx | null },
  prepare: vi.fn(),
}));
vi.mock("../../middlewares/requireAdmin", () => makeRequireAdminMock(admin));
vi.mock("../../lib/pricing/service", async (original) => ({
  ...(await original<typeof import("../../lib/pricing/service")>()),
  prepareCsrPricing: prepare,
  quoteDto: (row: unknown) => row,
}));
import { PricingError } from "../../lib/pricing/service";
import router from "./pricing-resupply";
const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];
const app = () => express().use(express.json()).use(router);
beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
  admin.current = {
    userId: "csr",
    email: "fixture@example.com",
    role: "agent",
    granularRole: "csr",
  };
});
describe("individual patient checks in a resupply pricing batch", () => {
  it("checks only the newest exact approval when many historical candidates are stale", async () => {
    stageSupabaseResponse("resupply_order_drafts", "select", {
      data: [
        {
          id: ids[0],
          patient_id: "patient",
          suggested_product_id: "MASK",
          suggested_quantity: 1,
          status: "proposed",
        },
      ],
    });
    stageSupabaseResponse("pricing_quotes", "select", {
      data: Array.from({ length: 100 }, (_, i) => ({
        id: `quote-${i}`,
        revision: 1,
        lines: [{ id: "line", sku: "MASK", quantity: 1 }],
        input: { revenue: { mode: "insurance" } },
      })),
    });
    prepare.mockRejectedValue(new PricingError("stale_dependencies", 409));
    const response = await request(app())
      .post("/admin/pricing/resupply-review")
      .send({ draftIds: [ids[0]] });
    expect(response.status).toBe(200);
    expect(response.body.reviews[0]).toMatchObject({ state: "stale" });
    expect(response.body.reviews[0].message).toContain(
      "newest matching approval",
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0][1].quoteId).toBe("quote-0");
  });
  it("checks each patient's exact quantity and reports stale approvals separately", async () => {
    stageSupabaseResponse("resupply_order_drafts", "select", {
      data: ids.map((id, i) => ({
        id,
        patient_id: `patient-${i}`,
        suggested_product_id: "MASK",
        suggested_quantity: i + 1,
        status: "proposed",
      })),
    });
    for (const [i] of ids.entries())
      stageSupabaseResponse("pricing_quotes", "select", {
        data: [
          {
            id: `quote-${i}`,
            revision: i + 1,
            lines: [{ id: `line-${i}`, sku: "MASK", quantity: i + 1 }],
            input: { revenue: { mode: "insurance" } },
          },
        ],
      });
    prepare
      .mockResolvedValueOnce({
        id: "quote-0",
        revision: 1,
        evaluation: { contributionCents: 3000, contributionMarginBps: 4000 },
      })
      .mockRejectedValueOnce(new PricingError("stale_dependencies", 409));
    const result = await request(app())
      .post("/admin/pricing/resupply-review")
      .send({ draftIds: ids });
    expect(result.status).toBe(200);
    expect(result.body.reviews.map((r: { state: string }) => r.state)).toEqual([
      "ready",
      "stale",
    ]);
    expect(prepare.mock.calls.map((c) => c[1])).toMatchObject([
      {
        patientId: "patient-0",
        quoteId: "quote-0",
        items: [{ sku: "MASK", quantity: 1 }],
      },
      {
        patientId: "patient-1",
        quoteId: "quote-1",
        items: [{ sku: "MASK", quantity: 2 }],
      },
    ]);
  });
  it("does not reuse a different quantity or invent an unavailable tenant draft", async () => {
    stageSupabaseResponse("resupply_order_drafts", "select", {
      data: [
        {
          id: ids[0],
          patient_id: "patient",
          suggested_product_id: "MASK",
          suggested_quantity: 2,
          status: "proposed",
        },
      ],
    });
    stageSupabaseResponse("pricing_quotes", "select", {
      data: [
        {
          lines: [{ sku: "MASK", quantity: 1 }],
          input: { revenue: { mode: "insurance" } },
        },
      ],
    });
    const result = await request(app())
      .post("/admin/pricing/resupply-review")
      .send({ draftIds: ids });
    expect(result.body.reviews.map((r: { state: string }) => r.state)).toEqual([
      "review_needed",
      "unavailable",
    ]);
    expect(result.body.reviews[1].patientId).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });
  it("rejects duplicate selections and unauthenticated requests", async () => {
    expect(
      (
        await request(app())
          .post("/admin/pricing/resupply-review")
          .send({ draftIds: [ids[0], ids[0]] })
      ).status,
    ).toBe(400);
    admin.current = null;
    expect(
      (
        await request(app())
          .post("/admin/pricing/resupply-review")
          .send({ draftIds: ids })
      ).status,
    ).toBe(401);
  });
});
