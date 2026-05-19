import { describe, expect, it } from "vitest";

import {
  LEIE_CSV_EXPECTED_HEADER,
  parseLeieCsvLine,
} from "./oig-leie-screener";

function cellsForIndividual(): string[] {
  // Map of header → value. We compose the row in the canonical order.
  const m: Record<string, string> = {
    LASTNAME: "SMITH",
    FIRSTNAME: "JOHN",
    MIDNAME: "Q",
    BUSNAME: "",
    GENERAL: "INDIVIDUAL",
    SPECIALTY: "MEDICINE",
    UPIN: "",
    NPI: "1234567890",
    DOB: "19600101",
    ADDRESS: "1 MAIN ST",
    CITY: "PITTSBURGH",
    STATE: "PA",
    ZIP: "15213",
    EXCLTYPE: "1128(a)(1)",
    EXCLDATE: "20200115",
    REINDATE: "",
    WAIVERDATE: "",
    WVRSTATE: "",
  };
  return LEIE_CSV_EXPECTED_HEADER.map((c) => m[c] ?? "");
}

describe("parseLeieCsvLine", () => {
  it("parses an individual exclusion row", () => {
    const out = parseLeieCsvLine(cellsForIndividual());
    expect(out).toEqual({
      npi: "1234567890",
      lastname: "SMITH",
      firstname: "JOHN",
      middlename: "Q",
      subjectType: "INDIVIDUAL",
      exclusionType: "1128(a)(1)",
      exclusionDate: "2020-01-15",
      waiverDate: null,
      reinstateDate: null,
      addressState: "PA",
      addressCity: "PITTSBURGH",
    });
  });

  it("parses an entity row (uses BUSNAME as canonical lastname)", () => {
    const cells = cellsForIndividual();
    const lastIdx = LEIE_CSV_EXPECTED_HEADER.indexOf("LASTNAME");
    const firstIdx = LEIE_CSV_EXPECTED_HEADER.indexOf("FIRSTNAME");
    const midIdx = LEIE_CSV_EXPECTED_HEADER.indexOf("MIDNAME");
    const busIdx = LEIE_CSV_EXPECTED_HEADER.indexOf("BUSNAME");
    cells[lastIdx] = "";
    cells[firstIdx] = "";
    cells[midIdx] = "";
    cells[busIdx] = "ACME DME LLC";
    const out = parseLeieCsvLine(cells);
    expect(out?.lastname).toBe("ACME DME LLC");
    expect(out?.firstname).toBe(null);
    expect(out?.subjectType).toBe("ENTITY");
  });

  it("rejects rows with no name", () => {
    const cells = cellsForIndividual();
    const lastIdx = LEIE_CSV_EXPECTED_HEADER.indexOf("LASTNAME");
    const busIdx = LEIE_CSV_EXPECTED_HEADER.indexOf("BUSNAME");
    cells[lastIdx] = "";
    cells[busIdx] = "";
    expect(parseLeieCsvLine(cells)).toBeNull();
  });

  it("rejects rows with malformed dates", () => {
    const cells = cellsForIndividual();
    const exclDateIdx = LEIE_CSV_EXPECTED_HEADER.indexOf("EXCLDATE");
    cells[exclDateIdx] = "bogus";
    expect(parseLeieCsvLine(cells)).toBeNull();
  });

  it("treats 00000000 as null for optional dates", () => {
    const cells = cellsForIndividual();
    const reIdx = LEIE_CSV_EXPECTED_HEADER.indexOf("REINDATE");
    cells[reIdx] = "00000000";
    expect(parseLeieCsvLine(cells)?.reinstateDate).toBeNull();
  });

  it("returns null NPI when malformed", () => {
    const cells = cellsForIndividual();
    const npiIdx = LEIE_CSV_EXPECTED_HEADER.indexOf("NPI");
    cells[npiIdx] = "abc";
    expect(parseLeieCsvLine(cells)?.npi).toBeNull();
  });
});
