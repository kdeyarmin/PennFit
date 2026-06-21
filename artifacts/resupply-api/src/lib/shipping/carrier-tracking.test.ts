import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { autoSendMock } = vi.hoisted(() => ({
  autoSendMock: vi.fn(async () => undefined),
}));
vi.mock("../patient-packet/auto-send-on-delivery", () => ({
  autoSendPatientPacketOnDelivery: autoSendMock,
}));

import {
  applyCarrierTrackingEvent,
  parseCarrierEvent,
  verifyCarrierSignature,
} from "./carrier-tracking";

beforeEach(() => {
  supabaseMock.reset();
  autoSendMock.mockReset();
  autoSendMock.mockResolvedValue(undefined);
});

describe("parseCarrierEvent", () => {
  it("parses EasyPost tracker shape (delivered)", () => {
    expect(
      parseCarrierEvent({
        result: { tracking_code: "1Z", status: "delivered" },
      }),
    ).toEqual({ trackingNumber: "1Z", status: "delivered" });
  });
  it("parses generic shape, maps in_transit → shipped", () => {
    expect(
      parseCarrierEvent({ tracking_number: "X9", status: "in_transit" }),
    ).toEqual({ trackingNumber: "X9", status: "shipped" });
  });
  it("maps unknown status to 'other'", () => {
    expect(
      parseCarrierEvent({ tracking_number: "X9", status: "pre_transit" }),
    ).toEqual({ trackingNumber: "X9", status: "other" });
  });
  it("returns null without a tracking number", () => {
    expect(parseCarrierEvent({ status: "delivered" })).toBeNull();
    expect(parseCarrierEvent(null)).toBeNull();
  });
});

describe("verifyCarrierSignature", () => {
  const secret = "shh";
  const body = Buffer.from('{"a":1}');
  const sig = createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a valid hex HMAC", () => {
    expect(verifyCarrierSignature(body, sig, secret)).toBe(true);
  });
  it("tolerates the hmac-sha256-hex= prefix", () => {
    expect(verifyCarrierSignature(body, `hmac-sha256-hex=${sig}`, secret)).toBe(
      true,
    );
  });
  it("rejects a wrong signature and a missing one", () => {
    expect(verifyCarrierSignature(body, "deadbeef", secret)).toBe(false);
    expect(verifyCarrierSignature(body, undefined, secret)).toBe(false);
  });
});

describe("applyCarrierTrackingEvent", () => {
  it("stamps delivered_at + shipped_at and fires patient-packet auto-send", async () => {
    stageSupabaseResponse("shop_orders", "select", {
      data: { id: "o1", shipped_at: null, delivered_at: null },
    });
    stageSupabaseResponse("shop_orders", "update", { data: { id: "o1" } });

    const r = await applyCarrierTrackingEvent({
      trackingNumber: "1Z",
      status: "delivered",
    });

    expect(r).toEqual({ matched: true, updated: true });
    const patch = supabaseMock.writePayloads("shop_orders", "update")[0] as
      | Record<string, unknown>
      | undefined;
    expect(patch?.delivered_at).toBeTruthy();
    expect(patch?.shipped_at).toBeTruthy();
    expect(autoSendMock).toHaveBeenCalledWith({ orderId: "o1" });
  });

  it("is a no-op when already delivered", async () => {
    stageSupabaseResponse("shop_orders", "select", {
      data: { id: "o1", shipped_at: "t", delivered_at: "t" },
    });
    const r = await applyCarrierTrackingEvent({
      trackingNumber: "1Z",
      status: "delivered",
    });
    expect(r).toEqual({ matched: true, updated: false });
    expect(supabaseMock.callCount("shop_orders", "update")).toBe(0);
    expect(autoSendMock).not.toHaveBeenCalled();
  });

  it("stamps shipped_at on a shipped event (no auto-send)", async () => {
    stageSupabaseResponse("shop_orders", "select", {
      data: { id: "o1", shipped_at: null, delivered_at: null },
    });
    stageSupabaseResponse("shop_orders", "update", { data: { id: "o1" } });
    const r = await applyCarrierTrackingEvent({
      trackingNumber: "1Z",
      status: "shipped",
    });
    expect(r).toEqual({ matched: true, updated: true });
    expect(autoSendMock).not.toHaveBeenCalled();
  });

  it("reports unmatched when no order has the tracking number", async () => {
    stageSupabaseResponse("shop_orders", "select", { data: null });
    const r = await applyCarrierTrackingEvent({
      trackingNumber: "nope",
      status: "delivered",
    });
    expect(r).toEqual({ matched: false, updated: false });
  });
});
