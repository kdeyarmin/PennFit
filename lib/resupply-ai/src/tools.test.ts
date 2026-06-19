import { describe, expect, it } from "vitest";
import {
  BREATHE_SALES_TOOL_NAMES,
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
  verify_shop_customer_identity: { last_four: "4242" },
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
  identify_call_reason: { reason: "sales" },
  send_info_email: { email: "owner@acme-dme.example", topic: "pricing" },
  capture_sales_lead: {
    contact_name: "Pat Owner",
    company_name: "Acme DME",
    phone: "+18145551212",
    email: "owner@acme-dme.example",
    interest_tier: "growth",
    message: "Wants a callback about pricing for ~3000 patients.",
  },
  start_breathe_signup: {
    org_name: "Acme DME",
    admin_email: "owner@acme-dme.example",
  },
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

  it("BREATHE_SALES_TOOL_NAMES is a subset of TOOL_NAMES with no patient/shop tools", () => {
    const all = new Set<ToolName>(TOOL_NAMES);
    for (const name of BREATHE_SALES_TOOL_NAMES)
      expect(all.has(name)).toBe(true);
    // The sales line must NOT expose any patient/shop side-effect tool.
    const forbidden: ToolName[] = [
      "verify_patient_identity",
      "verify_shop_customer_identity",
      "lookup_resupply_inventory",
      "place_resupply_order",
      "get_customer_chart",
      "update_shipping_address",
    ];
    const sales = new Set<ToolName>(BREATHE_SALES_TOOL_NAMES);
    for (const f of forbidden) expect(sales.has(f)).toBe(false);
  });

  it("start_breathe_signup has NO password field (no spoken passwords)", () => {
    const withPassword = TOOL_ARG_SCHEMAS.start_breathe_signup.safeParse({
      org_name: "Acme DME",
      admin_email: "owner@acme-dme.example",
      password: "hunter2hunter2",
    });
    expect(withPassword.success).toBe(false);
    const descriptor = OPENAI_TOOL_DESCRIPTORS.find(
      (d) => d.name === "start_breathe_signup",
    );
    expect(Object.keys(descriptor?.parameters.properties ?? {})).not.toContain(
      "password",
    );
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

  it("never echoes a lead's contact PII (capture_sales_lead)", () => {
    const out = summarizeToolArgsForAudit("capture_sales_lead", {
      contact_name: "Pat Owner",
      company_name: "Acme DME",
      phone: "+18145551212",
      email: "owner@acme-dme.example",
      interest_tier: "growth",
      message: "Call me back about pricing.",
    });
    const blob = JSON.stringify(out);
    expect(blob).not.toContain("Pat Owner");
    expect(blob).not.toContain("Acme DME");
    expect(blob).not.toContain("8145551212");
    expect(blob).not.toContain("owner@acme-dme.example");
    expect(blob).not.toContain("Call me back");
    expect(out.has_email).toBe(true);
    expect(out.interest_tier).toBe("growth");
    expect(out.message_len).toBeGreaterThan(0);
  });

  it("never echoes the recipient or signup details (send_info_email / start_breathe_signup)", () => {
    const email = summarizeToolArgsForAudit("send_info_email", {
      email: "owner@acme-dme.example",
      topic: "pricing",
      notes: "secret note",
    });
    const emailBlob = JSON.stringify(email);
    expect(emailBlob).not.toContain("owner@acme-dme.example");
    expect(emailBlob).not.toContain("secret note");
    expect(email.topic).toBe("pricing");
    expect(email.has_email).toBe(true);

    const signup = summarizeToolArgsForAudit("start_breathe_signup", {
      org_name: "Acme DME",
      admin_email: "owner@acme-dme.example",
    });
    const signupBlob = JSON.stringify(signup);
    expect(signupBlob).not.toContain("Acme DME");
    expect(signupBlob).not.toContain("owner@acme-dme.example");
    expect(signup.has_org_name).toBe(true);
    expect(signup.has_admin_email).toBe(true);
  });
});
