// The sign-off source pre-fill, as pure logic.
//
// Context: migration 0499 made the first bands `fit_data_source =
// 'manufacturer'`, each carrying the citation 0495 requires. The pre-fill
// previously mapped only 'measured' -> physical_measurement, so a
// manufacturer-sourced model seeded the REFERENCE and left the CLASS
// blank — and the class is the half that makes provenance aggregatable.
//
// It also decides which job the panel says the reviewer is doing:
// confirming a published value reads very differently from auditing an
// estimate, and getting that backwards would be worse than saying nothing.

import { describe, expect, it } from "vitest";

type Variant = {
  needsClinicalReview: boolean;
  fitDataSource: "manufacturer" | "measured" | "estimated";
  fitDataSourceRef: string | null;
};

/** Mirrors the component's derived flag. */
function pendingAllManufacturer(variants: Variant[]): boolean {
  const pending = variants.filter((v) => v.needsClinicalReview);
  return (
    pending.length > 0 &&
    pending.every((v) => v.fitDataSource === "manufacturer")
  );
}

/** Mirrors the component's pre-fill decision. */
function prefill(
  variants: Variant[],
): { kind: string | null; ref: string | null } | null {
  const pending = variants.filter((v) => v.needsClinicalReview);
  if (pending.length === 0) return null;
  if (pending.some((v) => v.fitDataSource === "estimated")) return null;
  const refs = new Set(pending.map((v) => v.fitDataSourceRef));
  const kinds = new Set(pending.map((v) => v.fitDataSource));
  if (refs.size !== 1 || kinds.size !== 1) return null;
  const [ref] = refs;
  if (!ref) return null;
  const kind = [...kinds][0];
  return {
    kind:
      kind === "measured"
        ? "physical_measurement"
        : kind === "manufacturer"
          ? "manufacturer_fit_guide"
          : null,
    ref: String(ref),
  };
}

const REF = "Fisher & Paykel … REF 620198 REV C 2020-08";
const mfr = (ref: string | null = REF): Variant => ({
  needsClinicalReview: true,
  fitDataSource: "manufacturer",
  fitDataSourceRef: ref,
});
const est = (): Variant => ({
  needsClinicalReview: true,
  fitDataSource: "estimated",
  fitDataSourceRef: null,
});

describe("pre-filling the sign-off source", () => {
  it("fills both the class and the reference for a manufacturer-sourced model", () => {
    expect(prefill([mfr(), mfr(), mfr()])).toEqual({
      kind: "manufacturer_fit_guide",
      ref: REF,
    });
  });

  it("fills physical_measurement for a measured model", () => {
    const measured: Variant = {
      needsClinicalReview: true,
      fitDataSource: "measured",
      fitDataSourceRef: "Calipers, 2026-08-14",
    };
    expect(prefill([measured])).toEqual({
      kind: "physical_measurement",
      ref: "Calipers, 2026-08-14",
    });
  });

  it("fills nothing for estimated bands — there is no citation to offer", () => {
    expect(prefill([est(), est()])).toBeNull();
    expect(prefill([mfr(), est()])).toBeNull();
  });

  it("fills nothing when the pending bands disagree on their source", () => {
    // Two different documents cannot be summarised as one citation, and
    // picking either would misattribute the other.
    expect(prefill([mfr("Doc A"), mfr("Doc B")])).toBeNull();
  });

  it("fills nothing when the source is named but blank", () => {
    expect(prefill([mfr(null)])).toBeNull();
  });
});

describe("which job the reviewer is told they are doing", () => {
  it("says confirm when every pending band is manufacturer-sourced", () => {
    expect(pendingAllManufacturer([mfr(), mfr()])).toBe(true);
  });

  it("says audit when any pending band is still an estimate", () => {
    // The mixed case has to read as audit: one estimate among sourced
    // bands is exactly the row that needs looking at.
    expect(pendingAllManufacturer([mfr(), est()])).toBe(false);
  });

  it("says audit when there is nothing pending at all", () => {
    expect(pendingAllManufacturer([])).toBe(false);
    expect(
      pendingAllManufacturer([{ ...mfr(), needsClinicalReview: false }]),
    ).toBe(false);
  });
});
