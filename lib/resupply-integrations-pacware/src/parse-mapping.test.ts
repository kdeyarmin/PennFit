import { describe, it, expect } from "vitest";

import {
  parsePatientCsvWithMapping,
  previewPatientCsvHeaders,
  patientImportFields,
  normalizeDateToIso,
  normalizePhoneToE164,
  type PatientColumnMapping,
} from "./parse";

describe("normalizeDateToIso", () => {
  it("passes through valid ISO dates", () => {
    expect(normalizeDateToIso("1970-05-04")).toBe("1970-05-04");
  });
  it("coerces US M/D/Y with slashes, dashes, dots", () => {
    expect(normalizeDateToIso("5/4/1970")).toBe("1970-05-04");
    expect(normalizeDateToIso("05/04/1970")).toBe("1970-05-04");
    expect(normalizeDateToIso("12-31-1985")).toBe("1985-12-31");
    expect(normalizeDateToIso("3.7.1990")).toBe("1990-03-07");
  });
  it("expands 2-digit years with a 70 pivot", () => {
    expect(normalizeDateToIso("5/4/70")).toBe("1970-05-04");
    expect(normalizeDateToIso("5/4/69")).toBe("2069-05-04");
  });
  it("accepts Y/M/D too", () => {
    expect(normalizeDateToIso("1970/05/04")).toBe("1970-05-04");
  });
  it("rejects impossible calendar dates", () => {
    expect(normalizeDateToIso("02/31/1970")).toBeNull();
    expect(normalizeDateToIso("13/05/1970")).toBeNull();
  });
  it("rejects free text", () => {
    expect(normalizeDateToIso("not a date")).toBeNull();
  });
});

describe("normalizePhoneToE164", () => {
  it("passes through valid E.164", () => {
    expect(normalizePhoneToE164("+14155551212")).toBe("+14155551212");
  });
  it("coerces formatted 10-digit US numbers", () => {
    expect(normalizePhoneToE164("(415) 555-1212")).toBe("+14155551212");
    expect(normalizePhoneToE164("415.555.1212")).toBe("+14155551212");
    expect(normalizePhoneToE164("415-555-1212")).toBe("+14155551212");
  });
  it("coerces 11-digit leading-1 US numbers", () => {
    expect(normalizePhoneToE164("1-415-555-1212")).toBe("+14155551212");
  });
  it("keeps +country numbers with separators", () => {
    expect(normalizePhoneToE164("+44 20 7946 0958")).toBe("+442079460958");
  });
  it("rejects junk", () => {
    expect(normalizePhoneToE164("call me")).toBeNull();
    expect(normalizePhoneToE164("12345")).toBeNull();
  });
});

describe("parsePatientCsvWithMapping", () => {
  // A roster exported from some other CRM, with its own header names,
  // US-formatted dates, and formatted phone numbers.
  const foreignCsv = [
    "MRN,Given,Surname,Birthday,Cell,Plan",
    "A-100,Jane,Doe,5/4/1970,(415) 555-1212,Medicare",
    "A-101,John,Roe,12/31/1985,415.555.9999,Aetna",
  ].join("\n");

  const mapping: PatientColumnMapping = {
    pacwareId: "MRN",
    legalFirstName: "Given",
    legalLastName: "Surname",
    dateOfBirth: "Birthday",
    phoneE164: "Cell",
    insurancePayer: "Plan",
  };

  it("imports an arbitrary CSV via the column mapping with coercion", () => {
    const res = parsePatientCsvWithMapping(foreignCsv, mapping);
    expect(res.errors).toEqual([]);
    expect(res.totalDataRows).toBe(2);
    expect(res.rows[0]).toMatchObject({
      pacwareId: "A-100",
      legalFirstName: "Jane",
      legalLastName: "Doe",
      dateOfBirth: "1970-05-04",
      phoneE164: "+14155551212",
      insurancePayer: "Medicare",
    });
    expect(res.rows[1]).toMatchObject({
      pacwareId: "A-101",
      dateOfBirth: "1985-12-31",
      phoneE164: "+14155559999",
    });
    // The mapped fields are reported as present so the fill-only sync touches
    // exactly those columns.
    expect(new Set(res.presentFields)).toEqual(
      new Set([
        "pacwareId",
        "legalFirstName",
        "legalLastName",
        "dateOfBirth",
        "phoneE164",
        "insurancePayer",
      ]),
    );
  });

  it("still enforces the schema (missing required field errors, no row)", () => {
    const res = parsePatientCsvWithMapping(foreignCsv, {
      // pacwareId intentionally not mapped -> required field missing.
      legalFirstName: "Given",
      legalLastName: "Surname",
      dateOfBirth: "Birthday",
    });
    expect(res.rows).toEqual([]);
    expect(res.errors.length).toBe(2);
    expect(res.errors[0].field).toBe("pacwareId");
  });

  it("surfaces a precise error for an uncoercible date instead of dropping", () => {
    const csv = ["MRN,Given,Surname,Birthday", "A-1,Jane,Doe,someday"].join(
      "\n",
    );
    const res = parsePatientCsvWithMapping(csv, {
      pacwareId: "MRN",
      legalFirstName: "Given",
      legalLastName: "Surname",
      dateOfBirth: "Birthday",
    });
    expect(res.rows).toEqual([]);
    expect(res.errors[0]).toMatchObject({ rowIndex: 1, field: "dateOfBirth" });
  });

  it("ignores mapping entries that name unknown fields", () => {
    const res = parsePatientCsvWithMapping(foreignCsv, {
      ...mapping,
      // @ts-expect-error — exercising the runtime guard against bogus fields.
      notAField: "MRN",
    });
    expect(res.errors).toEqual([]);
    expect(res.rows.length).toBe(2);
  });
});

describe("previewPatientCsvHeaders", () => {
  it("returns the header labels and auto-suggests obvious mappings", () => {
    const csv = [
      "Account Number,First Name,Last Name,DOB,Phone,Primary Insurance",
      "42,Jane,Doe,1970-05-04,+14155551212,Aetna",
    ].join("\n");
    const preview = previewPatientCsvHeaders(csv);
    expect(preview.headers).toEqual([
      "Account Number",
      "First Name",
      "Last Name",
      "DOB",
      "Phone",
      "Primary Insurance",
    ]);
    // Alias table should recognize these spellings.
    expect(preview.suggestedMapping).toMatchObject({
      pacwareId: "Account Number",
      legalFirstName: "First Name",
      legalLastName: "Last Name",
      dateOfBirth: "DOB",
      phoneE164: "Phone",
      insurancePayer: "Primary Insurance",
    });
    // Field catalog is exposed for the picker, with required flags.
    const fields = patientImportFields();
    const pacwareId = fields.find((f) => f.field === "pacwareId");
    expect(pacwareId?.required).toBe(true);
  });

  it("leaves unknown headers unmapped", () => {
    const csv = ["Widget,Sprocket", "1,2"].join("\n");
    const preview = previewPatientCsvHeaders(csv);
    expect(preview.headers).toEqual(["Widget", "Sprocket"]);
    expect(preview.suggestedMapping).toEqual({});
  });
});
