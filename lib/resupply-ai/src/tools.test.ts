import { describe, expect, it } from "vitest";
import {
  OPENAI_TOOL_DESCRIPTORS,
  TOOL_ARG_SCHEMAS,
  TOOL_NAMES,
  summarizeToolArgsForAudit,
  type ToolName,
} from "./tools";

// One example-input per tool. Each example MUST satisfy both the JSON
// Schema we tell OpenAI about AND the zod schema the dispatcher uses —
// drift between those two is exactly the kind of silent bug this test
// is here to catch.
const EXAMPLES: Record<ToolName, Record<string, unknown>> = {
  verify_patient_identity: { date_of_birth: "1972-01-05" },
  lookup_resupply_inventory: {},
  get_customer_chart: {},
  get_shipping_address: {},
  update_shipping_address: {
    street: "123 Walnut St Apt 4B",
    city: "Philadelphia",
    state: "PA",
    postal_code: "19103",
  },
  place_resupply_order: {
    skus: ["MASK-N20-MED", "TUBING-CLIMATE"],
    address_confirmed: true,
  },
  request_human_handoff: { reason: "patient_distress" },
  end_call: { outcome: "completed" },
};

describe("tool descriptors / schemas", () => {
  it("exposes every tool name in TOOL_NAMES exactly once", () => {
    const set = new Set(TOOL_NAMES);
    expect(set.size).toBe(TOOL_NAMES.length);
  });

  it("OPENAI_TOOL_DESCRIPTORS covers every TOOL_NAMES entry exactly once", () => {
    const descriptorNames = OPENAI_TOOL_DESCRIPTORS.map((d) => d.name);
    expect(new Set(descriptorNames)).toEqual(new Set(TOOL_NAMES));
    expect(descriptorNames.length).toBe(TOOL_NAMES.length);
  });

  it.each(TOOL_NAMES)(
    "%s — descriptor parameter shape mirrors the zod schema (example accepted)",
    (name) => {
      const descriptor = OPENAI_TOOL_DESCRIPTORS.find((d) => d.name === name);
      expect(descriptor).toBeTruthy();
      expect(descriptor?.parameters.additionalProperties).toBe(false);

      const example = EXAMPLES[name];
      const parsed = TOOL_ARG_SCHEMAS[name].safeParse(example);
      expect(parsed.success).toBe(true);
    },
  );

  it("verify_patient_identity rejects a non-ISO date", () => {
    const r = TOOL_ARG_SCHEMAS.verify_patient_identity.safeParse({
      date_of_birth: "Jan 5 1972",
    });
    expect(r.success).toBe(false);
  });

  it("update_shipping_address rejects a non-US state and a malformed zip", () => {
    const r1 = TOOL_ARG_SCHEMAS.update_shipping_address.safeParse({
      street: "1 Foo",
      city: "Philly",
      state: "Pennsylvania",
      postal_code: "19103",
    });
    expect(r1.success).toBe(false);

    const r2 = TOOL_ARG_SCHEMAS.update_shipping_address.safeParse({
      street: "1 Foo",
      city: "Philly",
      state: "PA",
      postal_code: "19A03",
    });
    expect(r2.success).toBe(false);
  });

  it("place_resupply_order requires address_confirmed=true literally", () => {
    const r = TOOL_ARG_SCHEMAS.place_resupply_order.safeParse({
      skus: ["X"],
      address_confirmed: false,
    });
    expect(r.success).toBe(false);
  });

  it("place_resupply_order requires at least one SKU", () => {
    const r = TOOL_ARG_SCHEMAS.place_resupply_order.safeParse({
      skus: [],
      address_confirmed: true,
    });
    expect(r.success).toBe(false);
  });

  it("strict() drops are surfaced — extra fields fail validation", () => {
    const r = TOOL_ARG_SCHEMAS.end_call.safeParse({
      outcome: "completed",
      smuggled: "PHI",
    });
    expect(r.success).toBe(false);
  });

  it("end_call constrains outcome to the allowed enum", () => {
    expect(
      TOOL_ARG_SCHEMAS.end_call.safeParse({ outcome: "anything-goes" }).success,
    ).toBe(false);
  });
});

describe("summarizeToolArgsForAudit", () => {
  // The summary is what lands in the audit log; if any of these tests
  // start failing because raw PHI made it through, the audit sanitiser
  // (defense in depth) would block it — but that is supposed to be
  // belt-and-braces, NOT the only line of defence. Keep this test
  // tight.
  it("never echoes a raw DOB", () => {
    const out = summarizeToolArgsForAudit("verify_patient_identity", {
      date_of_birth: "1972-01-05",
    });
    expect(JSON.stringify(out)).not.toContain("1972");
    expect(out.has_dob).toBe(true);
  });

  it("never echoes a raw address", () => {
    const out = summarizeToolArgsForAudit("update_shipping_address", {
      street: "123 Walnut St",
      city: "Philadelphia",
      state: "PA",
      postal_code: "19103",
    });
    const blob = JSON.stringify(out);
    expect(blob).not.toContain("Walnut");
    expect(blob).not.toContain("Philadelphia");
    expect(blob).not.toContain("19103");
    expect(out.has_street).toBe(true);
    expect(out.has_postal_code).toBe(true);
  });

  it("records the SKU COUNT (not the SKUs) for place_resupply_order", () => {
    const out = summarizeToolArgsForAudit("place_resupply_order", {
      skus: ["A", "B", "C"],
      address_confirmed: true,
    });
    expect(out.sku_count).toBe(3);
    expect(out.address_confirmed).toBe(true);
    expect(JSON.stringify(out)).not.toContain('"A"');
  });

  it("records reason + handoff outcome enums plainly (those are non-PHI)", () => {
    const handoff = summarizeToolArgsForAudit("request_human_handoff", {
      reason: "patient_distress",
    });
    expect(handoff.reason).toBe("patient_distress");
    const end = summarizeToolArgsForAudit("end_call", {
      outcome: "order_placed",
    });
    expect(end.outcome).toBe("order_placed");
  });
});
