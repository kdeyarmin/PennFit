// Tests for the AI patch parser. The applier itself is exercised
// by the route-level tests; here we lock down the schema gate that
// keeps hallucinated patches out of the DB.

import { describe, expect, it } from "vitest";

import { aiPatchSchema, parseAiPatches } from "./ai-patch";

describe("aiPatchSchema", () => {
  it("accepts a well-formed set_line_modifier patch", () => {
    const r = aiPatchSchema.safeParse({
      kind: "set_line_modifier",
      hcpcsCode: "E0601",
      modifierCsv: "RR,KX",
      rationale: "Compliance proven; capped-rental month 5",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown kind", () => {
    const r = aiPatchSchema.safeParse({
      kind: "set_patient_name",
      value: "NEW NAME",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a set_claim_field with a non-whitelisted field", () => {
    const r = aiPatchSchema.safeParse({
      kind: "set_claim_field",
      field: "patient_id",
      value: "00000000-0000-4000-8000-000000000000",
    });
    expect(r.success).toBe(false);
  });

  it("uppercases the modifier CSV via transform", () => {
    const r = aiPatchSchema.safeParse({
      kind: "set_line_modifier",
      hcpcsCode: "E0601",
      modifierCsv: "rr,kx",
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.kind === "set_line_modifier") {
      expect(r.data.modifierCsv).toBe("RR,KX");
    }
  });

  it("rejects bogus modifier characters", () => {
    const r = aiPatchSchema.safeParse({
      kind: "set_line_modifier",
      hcpcsCode: "E0601",
      modifierCsv: "RR;KX",
    });
    expect(r.success).toBe(false);
  });

  it("validates HCPCS shape strictly", () => {
    const bad = aiPatchSchema.safeParse({
      kind: "set_line_billed_cents",
      hcpcsCode: "not_a_hcpcs",
      billedCents: 100,
    });
    expect(bad.success).toBe(false);
    const good = aiPatchSchema.safeParse({
      kind: "set_line_billed_cents",
      hcpcsCode: "E0601",
      billedCents: 100,
    });
    expect(good.success).toBe(true);
  });

  it("validates ICD-10 shape for add_diagnosis", () => {
    const bad = aiPatchSchema.safeParse({
      kind: "add_diagnosis",
      icd10: "not-icd",
    });
    expect(bad.success).toBe(false);
    const good = aiPatchSchema.safeParse({
      kind: "add_diagnosis",
      icd10: "G47.33",
    });
    expect(good.success).toBe(true);
  });

  it("rejects negative billed cents", () => {
    const r = aiPatchSchema.safeParse({
      kind: "set_line_billed_cents",
      hcpcsCode: "E0601",
      billedCents: -1,
    });
    expect(r.success).toBe(false);
  });
});

describe("parseAiPatches", () => {
  it("returns empty arrays when input is not an array", () => {
    const r = parseAiPatches(null);
    expect(r.patches).toEqual([]);
    expect(r.dropped).toEqual([]);
  });

  it("separates valid patches from invalid ones with reasons", () => {
    const r = parseAiPatches([
      { kind: "set_line_modifier", hcpcsCode: "E0601", modifierCsv: "RR,KX" },
      { kind: "wat", garbage: true },
      { kind: "add_diagnosis", icd10: "G47.33" },
      "not even an object",
      { kind: "set_line_billed_cents", hcpcsCode: "E0601", billedCents: -5 },
    ]);
    expect(r.patches).toHaveLength(2);
    expect(r.dropped).toHaveLength(3);
    expect(r.dropped.map((d) => d.index)).toEqual([1, 3, 4]);
  });

  it("strips out an add_line patch with bad shape but keeps a good sibling", () => {
    const r = parseAiPatches([
      {
        kind: "add_line",
        hcpcsCode: "A7032",
        modifierCsv: "NU",
        quantity: 1,
        billedCents: 2899,
      },
      {
        kind: "add_line",
        hcpcsCode: "BAD",
        modifierCsv: "NU",
        quantity: 1,
        billedCents: 2899,
      },
    ]);
    expect(r.patches).toHaveLength(1);
    expect(r.dropped).toHaveLength(1);
  });
});
