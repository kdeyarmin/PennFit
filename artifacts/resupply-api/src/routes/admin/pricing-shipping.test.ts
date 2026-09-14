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
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const db = installSupabaseMock();
const { admin, quoteRates, availability } = vi.hoisted(() => ({
  admin: { current: null as MockAdminCtx | null },
  quoteRates: vi.fn(),
  availability: vi.fn(),
}));
vi.mock("../../middlewares/requireAdmin", () => makeRequireAdminMock(admin));
vi.mock("../../lib/shipping/xps-core", () => ({
  getXpsAdapterForOrg: vi.fn(async () => ({ quoteRates, availability })),
  adapterErrorStatus: () => 502,
}));
import router from "./pricing-shipping";

const patientId = "11111111-1111-4111-8111-111111111111";
const address = {
  line1: "123 Fixture St",
  city: "York",
  state: "PA",
  zip: "17401",
};
const body = {
  patientId,
  lines: [{ sku: "MASK", quantity: 1 }],
  parcels: [{ weightOz: 16, lengthIn: 8, widthIn: 6, heightIn: 4 }],
  residential: true,
};
function app() {
  return express().use(express.json()).use(router);
}
function patient() {
  stageSupabaseResponse("patients", "select", {
    data: { id: patientId, address },
  });
}
function products() {
  stageSupabaseResponse("products", "select", { data: [{ sku: "MASK" }] });
}
beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
  admin.current = {
    userId: "csr",
    email: "fixture@example.com",
    role: "agent",
    granularRole: "csr",
  };
  availability.mockReturnValue({ status: "configured" });
});
describe("pricing delivery estimates", () => {
  it("requires staff authorization before reading patient addresses", async () => {
    admin.current = null;
    expect(
      (await request(app()).post("/admin/pricing/shipping-rates").send(body))
        .status,
    ).toBe(401);
    expect(quoteRates).not.toHaveBeenCalled();
  });
  it("does not quote a patient unavailable to the tenant", async () => {
    expect(
      (await request(app()).post("/admin/pricing/shipping-rates").send(body))
        .status,
    ).toBe(404);
    expect(quoteRates).not.toHaveBeenCalled();
  });
  it("rejects missing parcel measurements and inactive or missing products", async () => {
    expect(
      (
        await request(app())
          .post("/admin/pricing/shipping-rates")
          .send({ ...body, parcels: [{ weightOz: 16 }] })
      ).status,
    ).toBe(400);
    patient();
    expect(
      (await request(app()).post("/admin/pricing/shipping-rates").send(body))
        .body.error,
    ).toBe("catalog_item_required");
    expect(quoteRates).not.toHaveBeenCalled();
  });
  it("leaves cost unknown when shipping is unconfigured or carrier prices are missing", async () => {
    patient();
    products();
    availability.mockReturnValueOnce({ status: "stub" });
    expect(
      (await request(app()).post("/admin/pricing/shipping-rates").send(body))
        .status,
    ).toBe(503);
    patient();
    products();
    quoteRates.mockResolvedValue({
      ok: true,
      value: [{ totalCents: null }, { totalCents: -1 }],
    });
    expect(
      (await request(app()).post("/admin/pricing/shipping-rates").send(body))
        .body.error,
    ).toBe("no_shipping_rates");
    expect(
      getSupabaseWritePayloads("pricing_shipping_quotes", "insert"),
    ).toHaveLength(0);
  });
  it("saves exact destination, contents, and expiry for a priced rate without purchasing a label", async () => {
    patient();
    products();
    quoteRates.mockResolvedValue({
      ok: true,
      value: [
        { carrierCode: "fixture", serviceCode: "ground", totalCents: 850 },
      ],
    });
    const start = Date.now();
    const result = await request(app())
      .post("/admin/pricing/shipping-rates")
      .send(body);
    expect(result.status).toBe(200);
    expect(result.body.rates[0].totalCents).toBe(850);
    expect(Date.parse(result.body.rates[0].expiresAt)).toBeGreaterThanOrEqual(
      start + 29 * 60_000,
    );
    const [rows] = getSupabaseWritePayloads(
      "pricing_shipping_quotes",
      "insert",
    ) as Array<
      Array<{
        cost_cents: number;
        data: {
          patientAddressSnapshot: unknown;
          lines: unknown;
          parcels: unknown;
        };
      }>
    >;
    expect(rows[0].cost_cents).toBe(850);
    expect(rows[0].data.patientAddressSnapshot).toEqual(address);
    expect(rows[0].data.lines).toEqual(body.lines);
    expect(rows[0].data.parcels).toEqual(body.parcels);
    expect(quoteRates.mock.calls[0][0].receiver.name).toBe("Shipping quote");
  });
});
