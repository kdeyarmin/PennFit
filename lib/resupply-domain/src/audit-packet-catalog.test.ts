import { describe, expect, it } from "vitest";

import {
  AUDIT_PACKET_CATALOG,
  AUDIT_PACKET_ITEM_KEYS,
  defaultSelection,
  getAuditPacketItem,
  isAuditPacketItemKey,
  normalizeSelection,
} from "./audit-packet-catalog";

describe("audit packet catalog", () => {
  it("has unique, stable keys", () => {
    const keys = AUDIT_PACKET_CATALOG.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(AUDIT_PACKET_ITEM_KEYS).toEqual(keys);
  });

  it("covers the core PAP device audit set by default", () => {
    const device = defaultSelection("device");
    // The non-negotiable spine of a PAP device review.
    expect(device).toEqual(
      expect.arrayContaining([
        "cover_sheet",
        "swo",
        "face_to_face_initial",
        "sleep_study",
        "reeval_31_91",
        "compliance_report",
        "proof_of_delivery",
        "claim_detail",
      ]),
    );
  });

  it("covers the resupply set by default, not the device-only clinical docs", () => {
    const supplies = defaultSelection("supplies");
    expect(supplies).toEqual(
      expect.arrayContaining([
        "refill_request",
        "continued_use",
        "replacement_schedule",
        "proof_of_delivery",
        "compliance_report",
      ]),
    );
    expect(supplies).not.toContain("sleep_study");
    expect(supplies).not.toContain("reeval_31_91");
  });

  it("returns the union for a combined review", () => {
    const both = defaultSelection("both");
    expect(both).toEqual(
      expect.arrayContaining(["sleep_study", "refill_request"]),
    );
  });

  it("returns defaults in catalog (print) order", () => {
    const device = defaultSelection("device");
    const order = AUDIT_PACKET_CATALOG.map((i) => i.key);
    const sorted = [...device].sort(
      (a, b) => order.indexOf(a) - order.indexOf(b),
    );
    expect(device).toEqual(sorted);
  });

  it("looks items up by key", () => {
    expect(getAuditPacketItem("sleep_study")?.group).toBe("clinical");
    expect(getAuditPacketItem("nope")).toBeUndefined();
    expect(isAuditPacketItemKey("swo")).toBe(true);
    expect(isAuditPacketItemKey("swo2")).toBe(false);
  });

  it("every on_file/hybrid item declares document types; generated ones don't", () => {
    for (const item of AUDIT_PACKET_CATALOG) {
      if (item.source === "generated") {
        expect(item.documentTypes).toEqual([]);
      } else {
        expect(item.documentTypes.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("normalizeSelection", () => {
  it("drops unknown keys and reports them", () => {
    const r = normalizeSelection(["swo", "bogus", "sleep_study"]);
    expect(r.items.map((i) => i.key)).toEqual(["swo", "sleep_study"]);
    expect(r.unknown).toEqual(["bogus"]);
  });

  it("de-duplicates and re-orders to print order regardless of click order", () => {
    const r = normalizeSelection(["claim_detail", "swo", "swo", "cover_sheet"]);
    expect(r.items.map((i) => i.key)).toEqual([
      "cover_sheet",
      "swo",
      "claim_detail",
    ]);
  });

  it("returns empty for an empty selection", () => {
    const r = normalizeSelection([]);
    expect(r.items).toEqual([]);
    expect(r.unknown).toEqual([]);
  });
});
