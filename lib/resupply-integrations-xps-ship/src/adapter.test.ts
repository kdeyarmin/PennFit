import { describe, expect, it, vi } from "vitest";

import { createXpsShipAdapter } from "./adapter";
import type { XpsAddress } from "./config";

const FULL_ENV: NodeJS.ProcessEnv = {
  XPS_SHIP_API_KEY: "test-key",
  XPS_SHIP_CUSTOMER_ID: "CUST1",
  XPS_SHIP_INTEGRATION_ID: "INT1",
  XPS_SHIP_FROM_NAME: "Penn Home Medical",
  XPS_SHIP_FROM_ADDRESS1: "1 Supply Way",
  XPS_SHIP_FROM_CITY: "Philadelphia",
  XPS_SHIP_FROM_STATE: "PA",
  XPS_SHIP_FROM_ZIP: "19103",
};

const RECEIVER: XpsAddress = {
  name: "Jane Patient",
  address1: "54 Green St",
  city: "Salt Lake City",
  state: "UT",
  zip: "84106",
  country: "US",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createXpsShipAdapter availability", () => {
  it("reports stub with no_credentials when unconfigured", () => {
    const adapter = createXpsShipAdapter({});
    expect(adapter.availability()).toEqual({
      status: "stub",
      reason: "no_credentials",
    });
  });

  it("reports stub with incomplete_config when partially configured", () => {
    const adapter = createXpsShipAdapter({ XPS_SHIP_API_KEY: "k" });
    expect(adapter.availability()).toEqual({
      status: "stub",
      reason: "incomplete_config",
    });
  });

  it("reports configured when fully configured", () => {
    const adapter = createXpsShipAdapter(FULL_ENV);
    expect(adapter.availability()).toEqual({ status: "configured" });
  });
});

describe("createXpsShipAdapter calls (stub mode)", () => {
  it("returns unavailable without crashing when unconfigured", async () => {
    const adapter = createXpsShipAdapter({});
    const res = await adapter.quoteRates({
      receiver: RECEIVER,
      parcels: [{ weightOz: 16 }],
    });
    expect(res).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("quoteRates", () => {
  it("parses rates and converts dollars to cents", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        quotes: [
          {
            carrierCode: "ups",
            serviceCode: "ups_ground",
            serviceDescription: "Ground",
            totalAmount: "8.75",
            zone: 4,
          },
          {
            carrierCode: "usps",
            serviceCode: "usps_priority",
            totalAmount: 9.1,
          },
        ],
      }),
    );
    const adapter = createXpsShipAdapter(FULL_ENV, { fetchImpl });
    const res = await adapter.quoteRates({
      receiver: RECEIVER,
      parcels: [{ weightOz: 32 }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(2);
    expect(res.value[0]).toMatchObject({
      serviceCode: "ups_ground",
      totalCents: 875,
      zone: "4",
    });
    expect(res.value[1]).toMatchObject({
      serviceCode: "usps_priority",
      totalCents: 910,
    });
    // Auth header + lb conversion (32oz = 2.00lb).
    const [, init] = fetchImpl.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "RSIS test-key",
    );
    expect(JSON.parse(init.body).pieces[0].weight).toBe("2.00");
  });

  it("maps a 401 to auth_failed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    const adapter = createXpsShipAdapter(FULL_ENV, { fetchImpl });
    const res = await adapter.quoteRates({
      receiver: RECEIVER,
      parcels: [{ weightOz: 16 }],
    });
    expect(res).toEqual({ ok: false, error: "auth_failed" });
  });
});

describe("createOrder", () => {
  it("PUTs to the orders endpoint with merged sender + receiver", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true }, 201));
    const adapter = createXpsShipAdapter(FULL_ENV, { fetchImpl });
    const res = await adapter.createOrder({
      orderId: "abc-123",
      receiver: RECEIVER,
      parcels: [{ weightOz: 24, lengthIn: 6, widthIn: 5, heightIn: 3 }],
      shippingService: "ups_ground",
    });
    expect(res).toEqual({ ok: true, value: { orderId: "abc-123" } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("/customers/CUST1/integrations/INT1/orders/abc-123");
    expect(init.method).toBe("PUT");
    const sent = JSON.parse(init.body);
    expect(sent.sender.zip).toBe("19103");
    expect(sent.receiver.name).toBe("Jane Patient");
    expect(sent.shippingService).toBe("ups_ground");
    expect(sent.packages[0].weight).toBe("1.50");
  });
});

describe("findShipmentByOrderId", () => {
  it("returns the exact-orderId match over a fuzzy one", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        shipments: [
          { bookNumber: 111, orderId: "other", trackingNumber: "T-OTHER" },
          {
            bookNumber: 222,
            orderId: "abc-123",
            trackingNumber: "1Z999",
            carrierCode: "ups",
            serviceCode: "ups_ground",
            totalShippingCost: 8.75,
          },
        ],
      }),
    );
    const adapter = createXpsShipAdapter(FULL_ENV, { fetchImpl });
    const res = await adapter.findShipmentByOrderId("abc-123");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toMatchObject({
      bookNumber: "222",
      trackingNumber: "1Z999",
      carrierCode: "ups",
      totalCostCents: 875,
    });
  });

  it("returns null when no shipment exists yet", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ shipments: [] }));
    const adapter = createXpsShipAdapter(FULL_ENV, { fetchImpl });
    const res = await adapter.findShipmentByOrderId("abc-123");
    expect(res).toEqual({ ok: true, value: null });
  });
});

describe("getLabel", () => {
  it("returns PDF bytes verbatim", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(pdf, {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );
    const adapter = createXpsShipAdapter(FULL_ENV, { fetchImpl });
    const res = await adapter.getLabel("222", "PDF");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.format).toBe("PDF");
    expect(Array.from(res.value.bytes)).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it("decodes a base64 PNG label", async () => {
    const raw = Buffer.from([1, 2, 3, 4]).toString("base64");
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ labelImageFormat: "PNG", base64Images: [raw] }),
      );
    const adapter = createXpsShipAdapter(FULL_ENV, { fetchImpl });
    const res = await adapter.getLabel("222", "PNG");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.format).toBe("PNG");
    expect(Array.from(res.value.bytes)).toEqual([1, 2, 3, 4]);
  });
});
