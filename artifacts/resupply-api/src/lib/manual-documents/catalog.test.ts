import { describe, it, expect } from "vitest";

import {
  MANUAL_DOCUMENT_CATALOG,
  MANUAL_DOCUMENT_TYPES,
  getManualDocumentTypeDef,
  isManualDocumentType,
  manualDocumentFieldKeys,
  normalizeManualDocumentFields,
} from "./catalog";

describe("manual-document catalog", () => {
  it("exposes a def for every listed type", () => {
    for (const type of MANUAL_DOCUMENT_TYPES) {
      expect(isManualDocumentType(type)).toBe(true);
      expect(getManualDocumentTypeDef(type).type).toBe(type);
    }
  });

  it("rejects unknown types", () => {
    expect(isManualDocumentType("nope")).toBe(false);
    expect(() => getManualDocumentTypeDef("nope" as never)).toThrow();
  });

  it("has unique field keys within each type", () => {
    for (const def of MANUAL_DOCUMENT_CATALOG) {
      const keys = def.fields.map((f) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("the free-form 'other' type has no structured fields", () => {
    expect(getManualDocumentTypeDef("other").fields).toHaveLength(0);
  });

  it("marks payer-required identifiers to render as blanks without storing fake values", () => {
    const cmnFields = getManualDocumentTypeDef("cmn").fields;
    for (const key of [
      "patient_name",
      "date_of_birth",
      "ordering_physician",
      "physician_npi",
    ]) {
      expect(cmnFields.find((f) => f.key === key)?.renderWhenBlank, key).toBe(
        true,
      );
    }

    const normalized = normalizeManualDocumentFields("cmn", {
      patient_name: "",
      ordering_physician: "   ",
      diagnosis: "G47.33",
    });
    expect(normalized).toEqual({ diagnosis: "G47.33" });
  });
});

describe("normalizeManualDocumentFields", () => {
  it("keeps only catalog keys and trims values", () => {
    const out = normalizeManualDocumentFields("cmn", {
      patient_name: "  Jordan Rivera  ",
      diagnosis: "G47.33",
      not_a_field: "drop me",
    });
    expect(out).toEqual({
      patient_name: "Jordan Rivera",
      diagnosis: "G47.33",
    });
    expect(manualDocumentFieldKeys("cmn").has("not_a_field")).toBe(false);
  });

  it("drops empty / whitespace-only / null values", () => {
    const out = normalizeManualDocumentFields("prescription", {
      patient_name: "   ",
      items_ordered: "",
      directions: "Use nightly",
      length_of_need: null as unknown as string,
    });
    expect(out).toEqual({ directions: "Use nightly" });
  });

  it("returns an empty object for null/garbage input", () => {
    expect(normalizeManualDocumentFields("cmn", null)).toEqual({});
    expect(
      normalizeManualDocumentFields(
        "cmn",
        undefined as unknown as Record<string, unknown>,
      ),
    ).toEqual({});
  });
});
