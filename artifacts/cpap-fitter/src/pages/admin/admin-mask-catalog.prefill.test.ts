// Sign-off provenance decisions for the mask-catalog review queue.
//
// Exercises the REAL implementation (admin-mask-catalog.prefill.ts), which
// the page imports — an earlier version of this file re-implemented the
// logic and would have kept passing while the component drifted.
//
// Two behaviours are load-bearing:
//
//   * what the panel TELLS the reviewer they are doing. Confirming a
//     published value and auditing an estimate are different tasks, and a
//     'measured' or mixed queue is neither;
//   * what it PRE-FILLS. The reference saves typing; the evidence class
//     must not be guessed, because a wrong class prints on every sign-off
//     and on the fit report after it.

import { describe, expect, it } from "vitest";

import {
  pendingSourceKind,
  prefillFromPending,
  type PendingBand,
} from "./admin-mask-catalog.prefill";

const REF = "Fisher & Paykel … REF 620198 REV C 2020-08";

const band = (
  fitDataSource: PendingBand["fitDataSource"],
  fitDataSourceRef: string | null = null,
  needsClinicalReview = true,
): PendingBand => ({ needsClinicalReview, fitDataSource, fitDataSourceRef });

const mfr = (ref: string | null = REF) => band("manufacturer", ref);
const measured = (ref: string | null = "Calipers, 2026-08-14") =>
  band("measured", ref);
const est = () => band("estimated", null);

describe("which job the reviewer is told they are doing", () => {
  it("says manufacturer when every pending band is manufacturer-sourced", () => {
    expect(pendingSourceKind([mfr(), mfr()])).toBe("manufacturer");
  });

  it("says measured for a physically-measured queue", () => {
    // Previously this fell into the "these are estimates" branch, which
    // is simply untrue of a measured band.
    expect(pendingSourceKind([measured(), measured()])).toBe("measured");
  });

  it("says mixed when the pending bands disagree", () => {
    // One citation cannot describe a queue like this, so the panel has to
    // send the reviewer to the per-row Source column.
    expect(pendingSourceKind([mfr(), est()])).toBe("mixed");
    expect(pendingSourceKind([mfr(), measured()])).toBe("mixed");
  });

  it("says estimated for an estimated queue", () => {
    expect(pendingSourceKind([est(), est()])).toBe("estimated");
  });

  it("ignores bands that are already signed off", () => {
    const signedOff = band("estimated", null, false);
    expect(pendingSourceKind([mfr(), signedOff])).toBe("manufacturer");
  });

  it("does not claim a source when nothing is pending", () => {
    expect(pendingSourceKind([])).toBe("estimated");
    expect(pendingSourceKind([band("manufacturer", REF, false)])).toBe(
      "estimated",
    );
  });
});

describe("what the sign-off form is pre-filled with", () => {
  it("seeds the reference but NOT the class for manufacturer bands", () => {
    // `fit_data_source` names the publisher, not the document type, and
    // the schema separates a fit guide from a spec sheet. Guessing would
    // print the wrong evidence class on every sign-off.
    expect(prefillFromPending([mfr(), mfr()])).toEqual({
      kind: null,
      ref: REF,
    });
  });

  it("seeds physical_measurement for a measured band", () => {
    // The one unambiguous mapping: a physical measurement is a physical
    // measurement, whatever was measured.
    expect(prefillFromPending([measured()])).toEqual({
      kind: "physical_measurement",
      ref: "Calipers, 2026-08-14",
    });
  });

  it("seeds nothing when any pending band is an estimate", () => {
    expect(prefillFromPending([est()])).toBeNull();
    expect(prefillFromPending([mfr(), est()])).toBeNull();
  });

  it("seeds nothing when the pending bands cite different documents", () => {
    expect(prefillFromPending([mfr("Doc A"), mfr("Doc B")])).toBeNull();
  });

  it("seeds nothing when the source is named but blank", () => {
    expect(prefillFromPending([mfr(null)])).toBeNull();
  });

  it("seeds nothing when there is nothing pending", () => {
    expect(prefillFromPending([])).toBeNull();
    expect(prefillFromPending([band("manufacturer", REF, false)])).toBeNull();
  });
});
