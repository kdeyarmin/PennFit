import { describe, expect, it } from "vitest";

import {
  type EraAdjustment,
  patientRespBreakdown,
} from "./era-patient-responsibility";

function adj(
  groupCode: string,
  reasonCode: string,
  amountCents: number,
): EraAdjustment {
  return { groupCode, reasonCode, amountCents };
}

describe("patientRespBreakdown", () => {
  it("buckets PR CARC 1/2/3 into deductible/coinsurance/copay", () => {
    const r = patientRespBreakdown({
      adjustments: [adj("PR", "1", 5000), adj("PR", "2", 2000)],
      serviceLines: [{ adjustments: [adj("PR", "3", 1000)] }],
    });
    expect(r).toEqual({
      deductibleCents: 5000,
      coinsuranceCents: 2000,
      copayCents: 1000,
    });
  });

  it("sums the same bucket across claim- and line-level CAS", () => {
    const r = patientRespBreakdown({
      adjustments: [adj("PR", "2", 1500)],
      serviceLines: [
        { adjustments: [adj("PR", "2", 500)] },
        { adjustments: [adj("PR", "2", 250)] },
      ],
    });
    expect(r.coinsuranceCents).toBe(2250);
  });

  it("ignores non-PR groups and un-bucketed PR reasons", () => {
    const r = patientRespBreakdown({
      adjustments: [
        adj("CO", "45", 9999), // contractual — not patient resp
        adj("PR", "66", 700), // PR but not 1/2/3 — not bucketed
        adj("PR", "1", 800),
      ],
      serviceLines: [],
    });
    expect(r).toEqual({
      deductibleCents: 800,
      coinsuranceCents: 0,
      copayCents: 0,
    });
  });

  it("floors a negative (reversal) adjustment at 0", () => {
    const r = patientRespBreakdown({
      adjustments: [adj("PR", "1", -500), adj("PR", "1", 1200)],
      serviceLines: [],
    });
    expect(r.deductibleCents).toBe(1200);
  });
});
