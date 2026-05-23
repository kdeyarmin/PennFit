import { describe, expect, it } from "vitest";

import { parseParachuteOrder } from "./parse-order";

const MINIMAL = {
  order_id: "PCH-0001",
  event_type: "order.created",
  occurred_at: "2026-05-22T10:00:00Z",
};

describe("parseParachuteOrder", () => {
  it("accepts a minimal payload", () => {
    const result = parseParachuteOrder(MINIMAL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.sourceOrderId).toBe("PCH-0001");
    expect(result.order.eventType).toBe("order.created");
    expect(result.order.hcpcsLines).toEqual([]);
    expect(result.order.icd10Codes).toEqual([]);
    expect(result.order.documents).toEqual([]);
  });

  it("rejects a payload missing order_id", () => {
    const result = parseParachuteOrder({ event_type: "order.created" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_shape");
    expect(result.issues.some((i) => i.path === "order_id")).toBe(true);
  });

  it("normalises HCPCS lines (uppercase code, dedup modifiers, default qty 1)", () => {
    const result = parseParachuteOrder({
      ...MINIMAL,
      items: [
        {
          code: "e0601 ",
          modifiers: ["KX", "rr", ""],
          quantity: "2",
          description: "CPAP",
        },
        { code: "A7034", quantity: 0, modifiers: [] },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.hcpcsLines[0]).toEqual({
      code: "E0601",
      modifiers: ["KX", "RR"],
      quantity: 2,
      description: "CPAP",
    });
    // quantity 0 → falls back to 1 (orders default to qty 1).
    expect(result.order.hcpcsLines[1].quantity).toBe(1);
  });

  it("normalises NPI to digits, rejects malformed", () => {
    const a = parseParachuteOrder({
      ...MINIMAL,
      provider: { npi: "  1234567890 " },
    });
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.order.provider.npi).toBe("1234567890");

    const b = parseParachuteOrder({
      ...MINIMAL,
      provider: { npi: "not-an-npi" },
    });
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.order.provider.npi).toBe(null);
  });

  it("normalises US phone to E.164", () => {
    const a = parseParachuteOrder({
      ...MINIMAL,
      patient: { phone: "(215) 555-0100" },
    });
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.order.patient.phoneE164).toBe("+12155550100");

    const b = parseParachuteOrder({
      ...MINIMAL,
      patient: { phone: "+442071234567" },
    });
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.order.patient.phoneE164).toBe("+442071234567");

    const c = parseParachuteOrder({ ...MINIMAL, patient: { phone: "" } });
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.order.patient.phoneE164).toBe(null);
  });

  it("uppercases ICD-10 codes and strips whitespace", () => {
    const result = parseParachuteOrder({
      ...MINIMAL,
      diagnoses: ["g47.33", " G47.30 ", ""],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.icd10Codes).toEqual(["G47.33", "G47.30"]);
  });

  it("preserves unknown document kinds verbatim", () => {
    const result = parseParachuteOrder({
      ...MINIMAL,
      documents: [
        {
          id: "doc-1",
          kind: "novel_thing",
          filename: "rx.pdf",
          url: "https://example.com/rx.pdf",
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.documents[0].kind).toBe("novel_thing");
  });

  it("returns occurred_at default when source omits it", () => {
    const result = parseParachuteOrder({ order_id: "PCH-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.order.occurredAt).toBe("string");
    expect(result.order.occurredAt.length).toBeGreaterThan(0);
  });
});
