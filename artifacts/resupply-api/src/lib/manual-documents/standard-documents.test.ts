import { describe, it, expect } from "vitest";

import {
  isManualDocumentType,
  manualDocumentFieldKeys,
  normalizeManualDocumentFields,
} from "./catalog";
import {
  STANDARD_DOCUMENT_LIBRARY,
  STANDARD_PACKET_LIBRARY,
  getStandardDocumentPacket,
  getStandardDocumentTemplate,
} from "./standard-documents";

describe("standard payer-document library", () => {
  it("includes the core Medicare/payer document set", () => {
    const keys = STANDARD_DOCUMENT_LIBRARY.map((t) => t.key);
    for (const expected of [
      "swo_pap",
      "cmn_pap",
      "abn_medicare",
      "aob_financial",
      "supplier_standards",
      "pod_pap",
      "refill_continued_use",
    ]) {
      expect(keys).toContain(expected);
    }
  });

  it("has unique keys and resolvable lookups", () => {
    const keys = STANDARD_DOCUMENT_LIBRARY.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const t of STANDARD_DOCUMENT_LIBRARY) {
      expect(getStandardDocumentTemplate(t.key)).toBe(t);
    }
    expect(getStandardDocumentTemplate("nope")).toBeNull();
  });

  it("uses only known document types", () => {
    for (const t of STANDARD_DOCUMENT_LIBRARY) {
      expect(isManualDocumentType(t.documentType)).toBe(true);
    }
  });

  it("prefills only field keys the type's catalog defines, and the wording survives normalization", () => {
    for (const t of STANDARD_DOCUMENT_LIBRARY) {
      const allowed = manualDocumentFieldKeys(t.documentType);
      for (const key of Object.keys(t.fields)) {
        expect(allowed.has(key), `${t.key}: unknown field ${key}`).toBe(true);
      }
      // The exact normalization the create route applies must not drop
      // or alter any of the standard wording.
      const normalized = normalizeManualDocumentFields(t.documentType, {
        ...t.fields,
      });
      expect(normalized).toEqual(t.fields);
    }
  });

  it("respects the create route's size limits (title ≤ 200, field ≤ 8000, body ≤ 20000)", () => {
    for (const t of STANDARD_DOCUMENT_LIBRARY) {
      expect(t.title.trim().length).toBeGreaterThan(0);
      expect(t.title.length).toBeLessThanOrEqual(200);
      expect(t.body.length).toBeLessThanOrEqual(20000);
      for (const value of Object.values(t.fields)) {
        expect(value.length).toBeLessThanOrEqual(8000);
      }
    }
  });

  it("contains no patient-identifying prefill — name/DOB/address fields stay blank", () => {
    const phiKeys = [
      "patient_name",
      "date_of_birth",
      "party_name",
      "delivery_address",
      "ordering_physician",
      "prescriber_name",
    ];
    for (const t of STANDARD_DOCUMENT_LIBRARY) {
      for (const key of phiKeys) {
        expect(
          t.fields[key],
          `${t.key}: must not prefill ${key}`,
        ).toBeUndefined();
      }
    }
  });
});

describe("standard packet library", () => {
  it("includes the new-patient setup packet with the intake trio in order", () => {
    const packet = getStandardDocumentPacket("new_patient_setup");
    expect(packet).not.toBeNull();
    expect(packet!.templateKeys).toEqual([
      "aob_financial",
      "supplier_standards",
      "abn_medicare",
    ]);
    expect(packet!.includeCoverSheet).toBe(true);
  });

  it("has unique keys and every member key resolves to a template", () => {
    const keys = STANDARD_PACKET_LIBRARY.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of STANDARD_PACKET_LIBRARY) {
      expect(p.templateKeys.length).toBeGreaterThan(0);
      expect(new Set(p.templateKeys).size).toBe(p.templateKeys.length);
      for (const key of p.templateKeys) {
        expect(
          getStandardDocumentTemplate(key),
          `${p.key}: unknown template ${key}`,
        ).not.toBeNull();
      }
    }
    expect(getStandardDocumentPacket("nope")).toBeNull();
  });

  it("respects the packet create route's title limit (≤ 160)", () => {
    for (const p of STANDARD_PACKET_LIBRARY) {
      expect(p.title.trim().length).toBeGreaterThan(0);
      expect(p.title.length).toBeLessThanOrEqual(160);
    }
  });
});
