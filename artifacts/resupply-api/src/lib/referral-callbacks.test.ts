import { describe, expect, it } from "vitest";

import { buildPayload, resolveTargetKind } from "./referral-callbacks";

describe("resolveTargetKind", () => {
  it("returns 'parachute' for the parachute slug", () => {
    expect(resolveTargetKind("parachute")).toBe("parachute");
  });

  it("returns 'ehr_fhir' for any ehr_fhir_ prefix", () => {
    expect(resolveTargetKind("ehr_fhir_athena")).toBe("ehr_fhir");
    expect(resolveTargetKind("ehr_fhir_epic_clinic1")).toBe("ehr_fhir");
  });

  it("returns null for unrecognised sources", () => {
    expect(resolveTargetKind("test")).toBeNull();
    expect(resolveTargetKind("itamar_hsat")).toBeNull();
    expect(resolveTargetKind("random_thing")).toBeNull();
  });
});

describe("buildPayload", () => {
  it("includes the canonical base fields", () => {
    const payload = buildPayload({
      eventType: "order.accepted",
      source: "parachute",
      sourceOrderId: "PCH-1",
      triageStatus: "accepted",
      acceptedOrderId: "ord-1",
      acceptedOrderKind: "shop_order",
      extra: {},
    });
    expect(payload.event_type).toBe("order.accepted");
    expect(payload.source).toBe("parachute");
    expect(payload.source_order_id).toBe("PCH-1");
    expect(payload.triage_status).toBe("accepted");
    expect(payload.accepted_order_id).toBe("ord-1");
    expect(payload.accepted_order_kind).toBe("shop_order");
    expect(typeof payload.event_id).toBe("string");
    expect(typeof payload.occurred_at).toBe("string");
  });

  it("merges extra fields without clobbering base fields", () => {
    const payload = buildPayload({
      eventType: "prior_auth.decision",
      source: "ehr_fhir_athena",
      sourceOrderId: "SR-1",
      triageStatus: "triaged",
      acceptedOrderId: null,
      acceptedOrderKind: null,
      extra: {
        decision: "approved",
        auth_number: "AUTH-123",
      },
    });
    expect(payload.decision).toBe("approved");
    expect(payload.auth_number).toBe("AUTH-123");
    expect(payload.event_type).toBe("prior_auth.decision");
    expect(payload.source_order_id).toBe("SR-1");
  });

  it("generates a unique event_id per payload", () => {
    const a = buildPayload({
      eventType: "order.accepted",
      source: "parachute",
      sourceOrderId: "x",
      triageStatus: "accepted",
      acceptedOrderId: null,
      acceptedOrderKind: null,
      extra: {},
    });
    const b = buildPayload({
      eventType: "order.accepted",
      source: "parachute",
      sourceOrderId: "x",
      triageStatus: "accepted",
      acceptedOrderId: null,
      acceptedOrderKind: null,
      extra: {},
    });
    expect(a.event_id).not.toEqual(b.event_id);
  });

  it("does not include patient name, dob, or address in the payload", () => {
    const payload = buildPayload({
      eventType: "order.accepted",
      source: "parachute",
      sourceOrderId: "x",
      triageStatus: "accepted",
      acceptedOrderId: null,
      acceptedOrderKind: null,
      extra: {},
    });
    expect(payload).not.toHaveProperty("first_name");
    expect(payload).not.toHaveProperty("last_name");
    expect(payload).not.toHaveProperty("dob");
    expect(payload).not.toHaveProperty("address");
    expect(payload).not.toHaveProperty("phone");
  });
});
