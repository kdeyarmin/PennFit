import { describe, it, expect } from "vitest";

import { buildPacwarePatientCsv, buildPacwareResupplyDueCsv } from "./export";
import { parseCsv } from "./csv";
import { parsePacwarePatientCsv } from "./parse";
import { getPacwareReportSpec } from "./reports";

describe("buildPacwarePatientCsv", () => {
  it("emits the canonical header row", () => {
    const csv = buildPacwarePatientCsv([]);
    const [header] = parseCsv(csv);
    expect(header).toEqual(
      getPacwareReportSpec("patient_roster").columns.map((c) => c.header),
    );
  });

  it("round-trips export -> import", () => {
    const csv = buildPacwarePatientCsv([
      {
        pacwareId: "PW1001",
        legalFirstName: "Jane",
        legalLastName: "Doe",
        dateOfBirth: "1970-05-04",
        phoneE164: "+14155551212",
        email: "jane@example.com",
        addressLine1: "123 Main St",
        city: "Philadelphia",
        state: "PA",
        postalCode: "19104",
        country: "US",
        insurancePayer: "Medicare",
      },
    ]);
    const res = parsePacwarePatientCsv(csv);
    expect(res.errors).toEqual([]);
    expect(res.rows[0]).toMatchObject({
      pacwareId: "PW1001",
      legalFirstName: "Jane",
      legalLastName: "Doe",
      dateOfBirth: "1970-05-04",
      phoneE164: "+14155551212",
      email: "jane@example.com",
      addressLine1: "123 Main St",
      city: "Philadelphia",
      state: "PA",
      postalCode: "19104",
      insurancePayer: "Medicare",
    });
  });

  it("renders null/undefined optionals as empty cells", () => {
    const csv = buildPacwarePatientCsv([
      {
        pacwareId: "PW1",
        legalFirstName: "Jane",
        legalLastName: "Doe",
        dateOfBirth: "1970-05-04",
        phoneE164: null,
        email: undefined,
      },
    ]);
    const rows = parseCsv(csv);
    // header + 1 data row
    expect(rows).toHaveLength(2);
    const spec = getPacwareReportSpec("patient_roster");
    const phoneIdx = spec.columns.findIndex((c) => c.field === "phoneE164");
    expect(rows[1][phoneIdx]).toBe("");
  });

  it("neutralises formula injection in a name field", () => {
    const csv = buildPacwarePatientCsv([
      {
        pacwareId: "PW1",
        legalFirstName: "=cmd|'/c calc'!A1",
        legalLastName: "Doe",
        dateOfBirth: "1970-05-04",
      },
    ]);
    // The leading apostrophe guard neutralises the formula. No comma /
    // double-quote / newline is present, so RFC 4180 quoting does not
    // wrap it — the guarded cell appears verbatim.
    expect(csv).toContain(`'=cmd|'/c calc'!A1`);
    // And it round-trips back to the original value (guard stripped).
    const reparsed = parsePacwarePatientCsv(csv);
    expect(reparsed.rows[0]?.legalFirstName).toBe("=cmd|'/c calc'!A1");
  });
});

describe("buildPacwareResupplyDueCsv", () => {
  it("emits the canonical header + one line per due item", () => {
    const csv = buildPacwareResupplyDueCsv([
      {
        pacwareId: "PW1001",
        legalLastName: "Doe",
        legalFirstName: "Jane",
        itemSku: "MASK-N20-M",
        quantity: 1,
        dueDate: "2026-06-15",
        episodeStatus: "ready",
        insurancePayer: "Medicare",
        episodeId: "ep_abc123",
      },
    ]);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual(
      getPacwareReportSpec("resupply_due").columns.map((c) => c.header),
    );
    expect(rows[1]).toEqual([
      "PW1001",
      "Doe",
      "Jane",
      "MASK-N20-M",
      "1",
      "2026-06-15",
      "ready",
      "Medicare",
      "ep_abc123",
    ]);
  });
});
