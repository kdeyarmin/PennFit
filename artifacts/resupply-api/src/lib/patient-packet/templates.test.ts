import { describe, it, expect } from "vitest";

import {
  PACKET_TEMPLATES,
  defaultPacketDocumentKeys,
  getPacketTemplate,
  isValidPacketDocumentKey,
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
});
