import { describe, it, expect } from "vitest";

import {
  MANUAL_DOCUMENT_CATALOG,
  MANUAL_DOCUMENT_TYPES,
  REQUIRED_FIELD_KEYS,
  getManualDocumentTypeDef,
  isManualDocumentType,
  isRequiredManualDocumentField,
  manualDocumentFieldKeys,
  missingRequiredManualDocumentFields,
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

describe("required fields & completeness", () => {
  it("every required key is a real field of its type", () => {
    for (const type of MANUAL_DOCUMENT_TYPES) {
      const keys = manualDocumentFieldKeys(type);
      for (const reqKey of REQUIRED_FIELD_KEYS[type]) {
        expect(keys.has(reqKey), `${type}.${reqKey}`).toBe(true);
        expect(isRequiredManualDocumentField(type, reqKey)).toBe(true);
      }
    }
  });

  it("the free-form 'other' type requires nothing", () => {
    expect(REQUIRED_FIELD_KEYS.other.size).toBe(0);
    expect(missingRequiredManualDocumentFields("other", {})).toEqual([]);
  });

  it("flags every required field that is blank/whitespace/missing", () => {
    const missing = missingRequiredManualDocumentFields("prescription", {
      patient_name: "Jordan Rivera",
      date_of_birth: "1980-02-02",
      prescriber_name: "  ", // whitespace → still missing
      // prescriber_npi, items_ordered, icd10_codes, length_of_need omitted
      directions: "Use nightly", // not required → irrelevant
    });
    expect(missing.map((m) => m.key).sort()).toEqual([
      "icd10_codes",
      "items_ordered",
      "length_of_need",
      "prescriber_name",
      "prescriber_npi",
    ]);
    // Labels come through for the UI flag.
    expect(missing.find((m) => m.key === "prescriber_npi")?.label).toBe(
      "Prescriber NPI",
    );
  });

  it("returns no missing fields once every required field is filled", () => {
    const complete = {
      patient_name: "Jordan Rivera",
      date_of_birth: "1980-02-02",
      ordering_physician: "Dr. Ada Lin",
      physician_npi: "1234567890",
      diagnosis: "G47.33", // ICD-10, auto-pulled from a validated source
      length_of_need: "99 months", // supplied by the DME
    };
    expect(missingRequiredManualDocumentFields("cmn", complete)).toEqual([]);
  });

  it("treats a wholly-empty document as missing all required fields", () => {
    const missing = missingRequiredManualDocumentFields("delivery_ticket", {});
    expect(missing.map((m) => m.key).sort()).toEqual([
      "delivery_address",
      "delivery_date",
      "items_delivered",
      "patient_name",
    ]);
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
