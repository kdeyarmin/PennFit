import { describe, expect, it } from "vitest";

import {
  applyRequiredModifierBaseline,
  buildClaimLineRows,
  cappedRentalRotationForLine,
  type ProposedClaimLine,
} from "./claim-builder";

function line(overrides: Partial<ProposedClaimLine> = {}): ProposedClaimLine {
  return {
    hcpcsCode: "A7034",
    modifiers: ["RR", "KX"],
    description: "Nasal mask",
    quantity: 1,
    billedCents: 12000,
    sourceKind: "product_map",
    sourceRef: null,
    feeScheduleRowId: null,
    ...overrides,
  };
}

describe("cappedRentalRotationForLine", () => {
  it("returns the CMS rotation for an adherence-gated capped-rental code", () => {
    // Month 1 → KH; months 2-3 → KI; months 4+ → KJ (+ KX when compliant).
    expect(cappedRentalRotationForLine("E0601", 1, false)).toEqual([
      "RR",
      "KH",
    ]);
    expect(cappedRentalRotationForLine("E0601", 2, false)).toEqual([
      "RR",
      "KI",
    ]);
    expect(cappedRentalRotationForLine("E0601", 3, true)).toEqual(["RR", "KI"]);
    // The bug fixed here: months 4+ must be KJ (not the old seed's KI), and KX
    // only rides along when adherence is documented.
    expect(cappedRentalRotationForLine("E0601", 4, true)).toEqual([
      "RR",
      "KJ",
      "KX",
    ]);
    expect(cappedRentalRotationForLine("E0601", 5, false)).toEqual([
      "RR",
      "KJ",
    ]);
    // Other adherence-gated codes follow the same rotation.
    expect(cappedRentalRotationForLine("E0470", 4, true)).toEqual([
      "RR",
      "KJ",
      "KX",
    ]);
    expect(cappedRentalRotationForLine("E0471", 1, false)).toEqual([
      "RR",
      "KH",
    ]);
  });

  it("returns [] for a non-capped-rental code (no spurious RR on supplies)", () => {
    expect(cappedRentalRotationForLine("A7034", 4, true)).toEqual([]);
    expect(cappedRentalRotationForLine("A7030", 1, false)).toEqual([]);
  });

  it("returns [] when the rental month is unknown", () => {
    expect(cappedRentalRotationForLine("E0601", null, true)).toEqual([]);
  });
});

describe("applyRequiredModifierBaseline", () => {
  it("prepends the first required modifier when none are present", () => {
    expect(applyRequiredModifierBaseline([], ["KX"])).toEqual(["KX"]);
    expect(applyRequiredModifierBaseline(["RR"], ["KX"])).toEqual(["KX", "RR"]);
  });

  it("is a no-op when at least one required modifier is already present", () => {
    expect(applyRequiredModifierBaseline(["KX", "RR"], ["KX"])).toEqual([
      "KX",
      "RR",
    ]);
  });

  it("matches case-insensitively when checking presence", () => {
    expect(applyRequiredModifierBaseline(["kx"], ["KX"])).toEqual(["kx"]);
  });

  it("treats any element of required[] as sufficient (KX or RR…)", () => {
    expect(applyRequiredModifierBaseline(["RR"], ["KX", "RR", "NU"])).toEqual([
      "RR",
    ]);
    expect(applyRequiredModifierBaseline([], ["KX", "RR"])).toEqual(["KX"]);
  });

  it("is a no-op when required[] is empty", () => {
    expect(applyRequiredModifierBaseline(["RR"], [])).toEqual(["RR"]);
  });

  it("respects the 4-modifier EDI cap", () => {
    expect(
      applyRequiredModifierBaseline(["A1", "B2", "C3", "D4"], ["KX"]),
    ).toEqual(["A1", "B2", "C3", "D4"]);
    expect(applyRequiredModifierBaseline(["A1", "B2", "C3"], ["KX"])).toEqual([
      "KX",
      "A1",
      "B2",
      "C3",
    ]);
  });
});

describe("buildClaimLineRows", () => {
  const CAPTURED = "2026-05-31T12:00:00.000Z";

  it("maps core fields and joins modifiers", () => {
    const [row] = buildClaimLineRows("claim_1", [line()], CAPTURED);
    expect(row).toMatchObject({
      claim_id: "claim_1",
      hcpcs_code: "A7034",
      modifier: "RR,KX",
      description: "Nasal mask",
      quantity: 1,
      billed_cents: 12000,
      status: "pending",
    });
  });

  it("nulls the modifier when there are none", () => {
    const [row] = buildClaimLineRows("c", [line({ modifiers: [] })], CAPTURED);
    expect(row.modifier).toBeNull();
  });

  it("carries the COGS snapshot when the line has a cost", () => {
    const [row] = buildClaimLineRows(
      "c",
      [line({ unitCostCents: 4200, costSource: "invoice" })],
      CAPTURED,
    );
    expect(row.unit_cost_cents).toBe(4200);
    expect(row.cost_source).toBe("invoice");
    expect(row.cost_captured_at).toBe(CAPTURED);
  });

  it("leaves cost null (and no captured_at) when the line has no cost", () => {
    const [row] = buildClaimLineRows("c", [line()], CAPTURED);
    expect(row.unit_cost_cents).toBeNull();
    expect(row.cost_source).toBeNull();
    expect(row.cost_captured_at).toBeNull();
  });

  it("treats a known zero cost as captured, defaulting the source", () => {
    const [row] = buildClaimLineRows(
      "c",
      [line({ unitCostCents: 0 })],
      CAPTURED,
    );
    expect(row.unit_cost_cents).toBe(0);
    expect(row.cost_source).toBe("manual");
    expect(row.cost_captured_at).toBe(CAPTURED);
  });
});
