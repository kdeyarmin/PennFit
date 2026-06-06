import { describe, it, expect } from "vitest";

import {
  PACKET_TEMPLATES,
  defaultPacketDocumentKeys,
  requiredPacketDocumentKeys,
  packetRequiresDateReceived,
  getPacketTemplate,
  isValidPacketDocumentKey,
  isRequiredPacketDocumentKey,
  FALLBACK_COMPANY,
} from "./templates";

describe("patient-packet templates", () => {
  it("exposes the standard new-patient documents", () => {
    const keys = PACKET_TEMPLATES.map((t) => t.key);
    expect(keys).toContain("assignment_of_benefits");
    expect(keys).toContain("notice_of_privacy_practices");
    expect(keys).toContain("financial_responsibility");
    expect(keys).toContain("proof_of_delivery");
    // No duplicate keys.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has non-empty content for every template", () => {
    for (const t of PACKET_TEMPLATES) {
      const sections = t.build(FALLBACK_COMPANY);
      expect(sections.length).toBeGreaterThan(0);
      // Each section has at least a heading, paragraphs, or bullets.
      for (const s of sections) {
        const hasContent =
          Boolean(s.heading) ||
          (s.paragraphs?.length ?? 0) > 0 ||
          (s.bullets?.length ?? 0) > 0;
        expect(hasContent).toBe(true);
      }
    }
  });

  it("substitutes the company profile into agreement content", () => {
    const aob = getPacketTemplate("assignment_of_benefits")!;
    const text = JSON.stringify(aob.build(FALLBACK_COMPANY));
    expect(text).toContain(FALLBACK_COMPANY.legalName);
  });

  it("default keys are all valid and signature docs included", () => {
    const defaults = defaultPacketDocumentKeys();
    expect(defaults.length).toBeGreaterThan(0);
    for (const k of defaults) expect(isValidPacketDocumentKey(k)).toBe(true);
    expect(defaults).toContain("proof_of_delivery");
  });

  it("getPacketTemplate resolves and rejects unknown keys", () => {
    expect(getPacketTemplate("assignment_of_benefits")?.title).toMatch(
      /Assignment of Benefits/i,
    );
    expect(getPacketTemplate("does_not_exist")).toBeUndefined();
    expect(isValidPacketDocumentKey("does_not_exist")).toBe(false);
  });

  it("required (compliance) docs are valid and included by default", () => {
    const required = requiredPacketDocumentKeys();
    const defaults = new Set(defaultPacketDocumentKeys());
    expect(required.length).toBeGreaterThan(0);
    for (const k of required) {
      expect(isValidPacketDocumentKey(k)).toBe(true);
      expect(isRequiredPacketDocumentKey(k)).toBe(true);
      // Required docs must ship in the standard packet.
      expect(defaults.has(k)).toBe(true);
    }
    // The core signed agreements + the POD are mandatory.
    expect(required).toContain("assignment_of_benefits");
    expect(required).toContain("proof_of_delivery");
  });

  it("packetRequiresDateReceived tracks the Proof of Delivery", () => {
    expect(packetRequiresDateReceived(["proof_of_delivery"])).toBe(true);
    expect(packetRequiresDateReceived(["assignment_of_benefits"])).toBe(false);
    expect(packetRequiresDateReceived([])).toBe(false);
  });

  it("Proof of Delivery renders itemized equipment when provided", () => {
    const pod = getPacketTemplate("proof_of_delivery")!;
    const sections = pod.build(FALLBACK_COMPANY, {
      deliveryDetails: {
        items: [{ description: "CPAP machine", hcpcs: "E0601", quantity: 1 }],
        deliveryDate: "2026-06-06",
      },
    });
    const text = JSON.stringify(sections);
    expect(text).toContain("CPAP machine");
    expect(text).toContain("E0601");
    expect(text).toContain("2026-06-06");
  });
});
