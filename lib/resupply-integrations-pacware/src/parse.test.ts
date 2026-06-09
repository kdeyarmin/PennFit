import { describe, it, expect } from "vitest";

import { parsePacwarePatientCsv, pacwarePatientRowSchema } from "./parse";

describe("parsePacwarePatientCsv", () => {
  it("parses a clean roster with canonical headers", () => {
    const csv = [
      "pacware_id,legal_first_name,legal_last_name,date_of_birth,phone_e164,insurance_payer",
      "PW1001,Jane,Doe,1970-05-04,+14155551212,Medicare",
    ].join("\n");
    const res = parsePacwarePatientCsv(csv);
    expect(res.errors).toEqual([]);
    expect(res.totalDataRows).toBe(1);
    expect(res.rows[0]).toMatchObject({
      pacwareId: "PW1001",
      legalFirstName: "Jane",
      legalLastName: "Doe",
      dateOfBirth: "1970-05-04",
      phoneE164: "+14155551212",
      insurancePayer: "Medicare",
    });
  });

  it("maps PacWare-style header aliases", () => {
    // Headers as a real PacWare patient report might spell them.
    const csv = [
      "Account Number,First Name,Last Name,DOB,Phone,Address,City,State,Zip,Primary Insurance",
      "42,Jane,Doe,1970-05-04,+14155551212,123 Main St,Philadelphia,PA,19104,Aetna",
    ].join("\n");
    const res = parsePacwarePatientCsv(csv);
    expect(res.errors).toEqual([]);
    expect(res.rows[0]).toMatchObject({
      pacwareId: "42",
      legalFirstName: "Jane",
      legalLastName: "Doe",
      phoneE164: "+14155551212",
      addressLine1: "123 Main St",
      city: "Philadelphia",
      state: "PA",
      postalCode: "19104",
      insurancePayer: "Aetna",
    });
  });

  it("reports missing required fields by row + field, never the value", () => {
    const csv = [
      "pacware_id,legal_first_name,legal_last_name,date_of_birth",
      ",Jane,Doe,1970-05-04",
    ].join("\n");
    const res = parsePacwarePatientCsv(csv);
    expect(res.rows).toEqual([]);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].rowIndex).toBe(1);
    expect(res.errors[0].field).toBe("pacwareId");
  });

  it("rejects a bad date-of-birth format", () => {
    const csv = [
      "pacware_id,legal_first_name,legal_last_name,date_of_birth",
      "PW1,Jane,Doe,05/04/1970",
    ].join("\n");
    const res = parsePacwarePatientCsv(csv);
    expect(res.rows).toEqual([]);
    expect(res.errors[0].field).toBe("dateOfBirth");
    // The bad value must NOT leak into the error message (it is PHI).
    expect(res.errors[0].message).not.toContain("05/04/1970");
  });

  it("rejects a non-E.164 phone", () => {
    const csv = [
      "pacware_id,legal_first_name,legal_last_name,date_of_birth,phone_e164",
      "PW1,Jane,Doe,1970-05-04,(415) 555-1212",
    ].join("\n");
    const res = parsePacwarePatientCsv(csv);
    expect(res.errors[0].field).toBe("phoneE164");
  });

  it("flags a partial address", () => {
    const csv = [
      "pacware_id,legal_first_name,legal_last_name,date_of_birth,address_line1,city",
      "PW1,Jane,Doe,1970-05-04,123 Main St,",
    ].join("\n");
    const res = parsePacwarePatientCsv(csv);
    expect(res.errors[0].field).toBe("address");
  });

  it("accepts a full address", () => {
    const csv = [
      "pacware_id,legal_first_name,legal_last_name,date_of_birth,address_line1,city,state,postal_code",
      "PW1,Jane,Doe,1970-05-04,123 Main St,Philadelphia,PA,19104",
    ].join("\n");
    const res = parsePacwarePatientCsv(csv);
    expect(res.errors).toEqual([]);
    expect(res.rows[0]).toMatchObject({
      addressLine1: "123 Main St",
      city: "Philadelphia",
      state: "PA",
      postalCode: "19104",
    });
  });

  it("skips blank rows and reports unmapped headers", () => {
    const csv = [
      "pacware_id,legal_first_name,legal_last_name,date_of_birth,balance_due",
      "PW1,Jane,Doe,1970-05-04,123.45",
      "",
      "   ",
    ].join("\n");
    const res = parsePacwarePatientCsv(csv);
    expect(res.totalDataRows).toBe(1);
    expect(res.rows).toHaveLength(1);
    expect(res.unmappedHeaders).toContain("balance_due");
  });

  it("collects mixed valid + invalid rows", () => {
    const csv = [
      "pacware_id,legal_first_name,legal_last_name,date_of_birth",
      "PW1,Jane,Doe,1970-05-04",
      "PW2,Bob,,1980-01-01",
      "PW3,Sue,Lee,1990-02-02",
    ].join("\n");
    const res = parsePacwarePatientCsv(csv);
    expect(res.rows).toHaveLength(2);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].rowIndex).toBe(2);
  });
});

describe("pacwarePatientRowSchema", () => {
  it("is exported for server-side re-validation", () => {
    const ok = pacwarePatientRowSchema.safeParse({
      pacwareId: "PW1",
      legalFirstName: "Jane",
      legalLastName: "Doe",
      dateOfBirth: "1970-05-04",
    });
    expect(ok.success).toBe(true);
  });

  it("rejects unknown keys (strict)", () => {
    const bad = pacwarePatientRowSchema.safeParse({
      pacwareId: "PW1",
      legalFirstName: "Jane",
      legalLastName: "Doe",
      dateOfBirth: "1970-05-04",
      ssn: "000-00-0000",
    });
    expect(bad.success).toBe(false);
  });
});
