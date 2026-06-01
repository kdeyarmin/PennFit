import { describe, it, expect } from "vitest";

import { parseProductCostCsv } from "./product-cost-csv";

describe("parseProductCostCsv", () => {
  it("parses valid rows and skips a header row", () => {
    const { rows, errors } = parseProductCostCsv(
      "sku,unit_cost_cents,cost_source,notes\n" +
        "MASK,4200,invoice,from acme\n" +
        "CUSHION,1850,,\n",
    );
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      {
        sku: "MASK",
        unitCostCents: 4200,
        costSource: "invoice",
        notes: "from acme",
      },
      {
        sku: "CUSHION",
        unitCostCents: 1850,
        costSource: "catalog",
        notes: null,
      },
    ]);
  });

  it("defaults cost_source to catalog and notes to null", () => {
    const { rows } = parseProductCostCsv("MASK,4200\n");
    expect(rows[0]).toEqual({
      sku: "MASK",
      unitCostCents: 4200,
      costSource: "catalog",
      notes: null,
    });
  });

  it("preserves commas inside the notes column", () => {
    const { rows } = parseProductCostCsv(
      "MASK,4200,invoice,bulk, net-30, q3\n",
    );
    expect(rows[0]?.notes).toBe("bulk, net-30, q3");
  });

  it("treats a known zero cost as valid", () => {
    const { rows } = parseProductCostCsv("FREEBIE,0,manual\n");
    expect(rows[0]?.unitCostCents).toBe(0);
  });

  it("skips blank lines", () => {
    const { rows, errors } = parseProductCostCsv("\nMASK,4200\n\n");
    expect(rows).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("collects per-line errors and excludes the bad rows", () => {
    const { rows, errors } = parseProductCostCsv(
      "MASK,4200\n" + // ok (line 1, not a header)
        "BADCOST,nope\n" + // line 2: non-numeric cost
        ",100\n" + // line 3: missing sku
        "MASK 2,500\n" + // line 4: space in sku
        "NEG,-5\n", // line 5: negative cost
    );
    expect(rows).toEqual([
      { sku: "MASK", unitCostCents: 4200, costSource: "catalog", notes: null },
    ]);
    expect(errors.map((e) => e.line)).toEqual([2, 3, 4, 5]);
  });

  it("rejects an unknown cost_source", () => {
    const { rows, errors } = parseProductCostCsv("MASK,4200,bogus\n");
    expect(rows).toEqual([]);
    expect(errors[0]?.message).toContain("invalid cost_source");
  });

  it("rejects an out-of-range cost (dollars-vs-cents guard)", () => {
    const { rows, errors } = parseProductCostCsv("MASK,100000001\n");
    expect(rows).toEqual([]);
    expect(errors[0]?.message).toContain("out of range");
  });
});
