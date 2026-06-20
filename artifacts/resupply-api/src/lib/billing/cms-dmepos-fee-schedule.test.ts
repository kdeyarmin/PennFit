import { describe, it, expect } from "vitest";

import { parseCmsDmeposFeeScheduleCsv } from "./cms-dmepos-fee-schedule";

// Mirrors the real CY2026 grid: banner rows, then a header whose first cell
// is "HCPCS", NR/R column pairs per state, and a trailing Description.
// Real PA values from the live file: E0601 RR = 50.04 (NR) / 91.18 (R);
// A7032 NU = 23.29 (NR) / 38.07 (R).
const CSV = [
  "CY2026 DMEPOS Fee Schedule,,,,,,,,,,,",
  "January 2026 release,,,,,,,,,,,",
  "HCPCS,Mod,Mod2,JURIS,CATG,Ceiling,Floor,AL (NR),AL (R),PA (NR),PA (R),Description",
  "E0601,RR,,D,CR,0.00,0.00,45.00,80.00,50.04,91.18,Cont airway pressure device",
  "A7032,NU,,D,IN,0.00,0.00,20.00,35.00,23.29,38.07,Replacement nasal cushion",
  "E1399,,,D,CR,0.00,0.00,0.00,0.00,0.00,0.00,Durable medical equipment misc",
  "",
].join("\n");

describe("parseCmsDmeposFeeScheduleCsv", () => {
  it("parses the non-rural PA column, keyed by HCPCS + modifier", () => {
    const { rows } = parseCmsDmeposFeeScheduleCsv(CSV, { state: "PA" });
    expect(rows).toEqual([
      { hcpcs: "E0601", modifier: "RR", modifier2: null, allowedCents: 5004 },
      { hcpcs: "A7032", modifier: "NU", modifier2: null, allowedCents: 2329 },
    ]);
    // E1399 has a 0.00 PA fee → "not applicable" → skipped, not a $0 row.
    expect(rows.some((r) => r.hcpcs === "E1399")).toBe(false);
  });

  it("parses the rural PA column when rural=true", () => {
    const { rows } = parseCmsDmeposFeeScheduleCsv(CSV, {
      state: "PA",
      rural: true,
    });
    expect(rows.find((r) => r.hcpcs === "E0601")?.allowedCents).toBe(9118);
    expect(rows.find((r) => r.hcpcs === "A7032")?.allowedCents).toBe(3807);
  });

  it("is state-specific (AL differs from PA)", () => {
    const { rows } = parseCmsDmeposFeeScheduleCsv(CSV, { state: "AL" });
    expect(rows.find((r) => r.hcpcs === "E0601")?.allowedCents).toBe(4500);
  });

  it("is case/space tolerant on the state and skips banner rows", () => {
    const { rows } = parseCmsDmeposFeeScheduleCsv(CSV, { state: " pa " });
    expect(rows.find((r) => r.hcpcs === "E0601")?.allowedCents).toBe(5004);
  });

  it("warns and returns nothing when the state column is absent", () => {
    const out = parseCmsDmeposFeeScheduleCsv(CSV, { state: "ZZ" });
    expect(out.rows).toEqual([]);
    expect(out.warnings[0]).toContain("ZZ");
  });

  it("warns when no header row is present", () => {
    const out = parseCmsDmeposFeeScheduleCsv("a,b,c\n1,2,3", { state: "PA" });
    expect(out.rows).toEqual([]);
    expect(out.warnings[0]).toContain("HCPCS");
  });

  it("reports a skip count in warnings", () => {
    const { warnings } = parseCmsDmeposFeeScheduleCsv(CSV, { state: "PA" });
    // E1399 (zero fee) was skipped.
    expect(warnings.join(" ")).toMatch(/1 row\(s\) skipped/);
  });
});
