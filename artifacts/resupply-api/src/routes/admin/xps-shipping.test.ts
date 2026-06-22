// Tests for /admin/shipping/xps/* — the shipping-label surface (a wrong
// order id or under-validated parcel maps to mis-shipped product and real
// money). Two prongs:
//   1. Pure units: the order-id allowlist, the parcel/label/batch body
//      schemas (weight & batch-size caps), and the address-completeness
//      check used to gate the queue.
//   2. HTTP route behaviour with mocked Supabase + auth: gating, the
//      invalid-order-id 400 short-circuit, and the queue mapping.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import type { SavedShippingAddress } from "@workspace/resupply-db";

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

import xpsShippingRouter, {
  addressLooksValid,
  batchBodySchema,
  labelBodySchema,
  parcelSchema,
  validateOrderId,
} from "./xps-shipping";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "admin@penn.example.com",
  role: "admin",
};
const UUID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(xpsShippingRouter);
  return app;
}

const validAddress: SavedShippingAddress = {
  line1: "123 Main St",
  line2: null,
  city: "Philadelphia",
  state: "PA",
  postalCode: "19103",
  country: "US",
} as SavedShippingAddress;

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

// ---------------------------------------------------------------------------
// validateOrderId — only a real UUID is allowed to address an order
// ---------------------------------------------------------------------------
describe("validateOrderId", () => {
  it("returns the id for a valid UUID", () => {
    expect(validateOrderId(UUID)).toBe(UUID);
  });

  it("rejects non-UUID strings, including traversal-ish input", () => {
    expect(validateOrderId("123")).toBeNull();
    expect(validateOrderId("../../etc/passwd")).toBeNull();
    expect(validateOrderId(`${UUID}/extra`)).toBeNull();
  });

  it("rejects non-string input", () => {
    expect(validateOrderId(undefined)).toBeNull();
    expect(validateOrderId(42)).toBeNull();
    expect(validateOrderId({ id: UUID })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parcel / label / batch schemas — money-relevant input caps
// ---------------------------------------------------------------------------
describe("parcelSchema", () => {
  it("accepts a sane parcel", () => {
    expect(
      parcelSchema.safeParse({ weightOz: 32, lengthIn: 10, widthIn: 8 })
        .success,
    ).toBe(true);
  });

  it("requires a positive weight and caps it at 70 lb", () => {
    expect(parcelSchema.safeParse({ weightOz: 0 }).success).toBe(false);
    expect(parcelSchema.safeParse({ weightOz: -5 }).success).toBe(false);
    expect(parcelSchema.safeParse({ weightOz: 70 * 16 }).success).toBe(true);
    expect(parcelSchema.safeParse({ weightOz: 70 * 16 + 1 }).success).toBe(
      false,
    );
  });

  it("caps each dimension at 108 inches", () => {
    expect(
      parcelSchema.safeParse({ weightOz: 10, lengthIn: 109 }).success,
    ).toBe(false);
  });
});

describe("labelBodySchema", () => {
  it("requires a non-empty shipping service", () => {
    expect(
      labelBodySchema.safeParse({
        parcel: { weightOz: 16 },
        shippingService: "",
      }).success,
    ).toBe(false);
    expect(
      labelBodySchema.safeParse({
        parcel: { weightOz: 16 },
        shippingService: "UPS Ground",
      }).success,
    ).toBe(true);
  });
});

describe("batchBodySchema", () => {
  it("accepts 1..50 order ids and rejects empty or oversized batches", () => {
    const ids = (n: number) => Array.from({ length: n }, () => UUID);
    const base = { shippingService: "UPS Ground" };
    expect(
      batchBodySchema.safeParse({ ...base, orderIds: ids(1) }).success,
    ).toBe(true);
    expect(
      batchBodySchema.safeParse({ ...base, orderIds: ids(50) }).success,
    ).toBe(true);
    expect(batchBodySchema.safeParse({ ...base, orderIds: [] }).success).toBe(
      false,
    );
    expect(
      batchBodySchema.safeParse({ ...base, orderIds: ids(51) }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// addressLooksValid — gate for shippable orders
// ---------------------------------------------------------------------------
describe("addressLooksValid", () => {
  it("is false for a null address", () => {
    expect(addressLooksValid(null)).toBe(false);
  });

  it("is true for a complete US address", () => {
    expect(addressLooksValid(validAddress)).toBe(true);
  });

  it("is false when a required field is missing", () => {
    expect(
      addressLooksValid({
        ...validAddress,
        postalCode: "",
      } as SavedShippingAddress),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HTTP — auth gating + validation short-circuits
// ---------------------------------------------------------------------------
describe("GET /admin/shipping/xps/queue", () => {
  it("401s when no admin is signed in", async () => {
    const res = await request(makeApp()).get("/admin/shipping/xps/queue");
    expect(res.status).toBe(401);
  });

  it("maps queued orders, deriving hasAddress and addressValid", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_orders", "select", {
      data: [
        {
          id: "o1",
          status: "paid",
          customer_email: "p@example.com",
          shipping_address_json: validAddress,
          xps_label_status: null,
          created_at: "2026-06-01T00:00:00Z",
          amount_total_cents: 4999,
        },
        {
          id: "o2",
          status: "paid",
          customer_email: "q@example.com",
          shipping_address_json: null,
          xps_label_status: "staged",
          created_at: "2026-06-02T00:00:00Z",
          amount_total_cents: 1999,
        },
      ],
    });

    const res = await request(makeApp()).get("/admin/shipping/xps/queue");
    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(2);
    expect(res.body.orders[0]).toMatchObject({
      id: "o1",
      hasAddress: true,
      addressValid: true,
      shipTo: "Philadelphia, PA 19103",
    });
    expect(res.body.orders[1]).toMatchObject({
      id: "o2",
      hasAddress: false,
      addressValid: false,
      shipTo: null,
    });
  });
});

describe("order-id validation short-circuits before any vendor/DB work", () => {
  it("400s a non-UUID order id on the suggested-parcel route", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get(
      "/admin/shop/orders/not-a-uuid/shipping/suggested-parcel",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_order_id");
  });

  it("400s a non-UUID order id on the rates route", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post("/admin/shop/orders/bogus/shipping/rates")
      .send({ parcel: { weightOz: 16 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_order_id");
  });
});
