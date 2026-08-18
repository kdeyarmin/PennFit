import { describe, expect, it } from "vitest";

import {
  buildFitterOutcomesReport,
  type FitSessionInput,
  type MaskFitOutcomeInput,
} from "./fitter-outcomes";

const MASK_A = "mask-a";
const MASK_B = "mask-b";

function session(over: Partial<FitSessionInput> = {}): FitSessionInput {
  return {
    id: "s1",
    createdAt: "2026-08-01T10:00:00Z",
    entryPoint: "remote_link",
    outcome: "high_confidence",
    scanQualityGrade: "good",
    degraded: false,
    primaryMaskModelId: MASK_A,
    overrideMaskModelId: null,
    overrideReason: null,
    orderedMaskModelId: MASK_A,
    reviewedAt: null,
    dispensedAt: null,
    ...over,
  };
}

function outcome(
  verdict: MaskFitOutcomeInput["verdict"],
  maskId: string | null = MASK_A,
): MaskFitOutcomeInput {
  return { maskId, verdict };
}

describe("buildFitterOutcomesReport — empty inputs", () => {
  it("reports null rates rather than zero when nothing has happened", () => {
    // THE central honesty rule. "No fitting came back as a bad fit" and
    // "nobody has reported anything yet" are different facts; rendering
    // both as 0% would let an empty dashboard read as a perfect score.
    const r = buildFitterOutcomesReport([], []);

    expect(r.sessions.total).toBe(0);
    expect(r.sessions.highConfidenceRate).toBeNull();
    expect(r.acceptance.acceptanceRate).toBeNull();
    expect(r.refit.refitRate).toBeNull();
    expect(r.dispensing.dispenseRate).toBeNull();
    expect(r.dispensing.medianHoursToReview).toBeNull();
    expect(r.refit.byMask).toEqual([]);
  });
});

describe("buildFitterOutcomesReport — refit rate", () => {
  it("counts leaking and uncomfortable against all responses", () => {
    const r = buildFitterOutcomesReport(
      [],
      [
        outcome("good"),
        outcome("good"),
        outcome("leaking"),
        outcome("uncomfortable"),
      ],
    );
    expect(r.refit.responses).toBe(4);
    expect(r.refit.good).toBe(2);
    expect(r.refit.refitRate).toBeCloseTo(0.5);
  });

  it("withholds a per-mask rate below the sample floor", () => {
    // One patient reporting a leak on a mask dispensed once is not a
    // 100% refit rate, and publishing it invites a stocking decision the
    // data cannot support.
    const r = buildFitterOutcomesReport([], [outcome("leaking")], {
      minOutcomesPerMask: 10,
    });
    expect(r.refit.byMask).toEqual([]);
    // …but the response still counts in the overall rate, and the
    // exclusion is reported so a thin list reads as thin data.
    expect(r.refit.refitRate).toBe(1);
    expect(r.refit.belowSampleFloor).toBe(1);
  });

  it("reports a per-mask rate once the floor is met, worst first", () => {
    const rows: MaskFitOutcomeInput[] = [
      ...Array.from({ length: 8 }, () => outcome("good", MASK_A)),
      ...Array.from({ length: 2 }, () => outcome("leaking", MASK_A)),
      ...Array.from({ length: 4 }, () => outcome("good", MASK_B)),
      ...Array.from({ length: 6 }, () => outcome("uncomfortable", MASK_B)),
    ];
    const r = buildFitterOutcomesReport([], rows, { minOutcomesPerMask: 10 });

    expect(r.refit.byMask).toHaveLength(2);
    expect(r.refit.byMask[0]?.maskId).toBe(MASK_B);
    expect(r.refit.byMask[0]?.refitRate).toBeCloseTo(0.6);
    expect(r.refit.byMask[1]?.maskId).toBe(MASK_A);
    expect(r.refit.byMask[1]?.refitRate).toBeCloseTo(0.2);
  });

  it("segregates responses that could not be attributed to a mask", () => {
    const rows = [
      ...Array.from({ length: 10 }, () => outcome("good", MASK_A)),
      outcome("leaking", null),
    ];
    const r = buildFitterOutcomesReport([], rows, { minOutcomesPerMask: 10 });

    expect(r.refit.unattributed).toBe(1);
    // The unattributed response still moves the headline rate — it is a
    // real bad fit — but it cannot be blamed on a specific mask.
    expect(r.refit.refitRate).toBeCloseTo(1 / 11);
    expect(r.refit.byMask).toHaveLength(1);
    expect(r.refit.byMask[0]?.outcomes).toBe(10);
  });
});

describe("buildFitterOutcomesReport — recommendation acceptance", () => {
  it("treats an un-acted-on fitting as undecided, not accepted", () => {
    // Otherwise the acceptance rate drifts as a queue ages rather than as
    // clinical opinion changes.
    const r = buildFitterOutcomesReport(
      [session({ orderedMaskModelId: null })],
      [],
    );
    expect(r.acceptance.undecided).toBe(1);
    expect(r.acceptance.decided).toBe(0);
    expect(r.acceptance.acceptanceRate).toBeNull();
  });

  it("counts an order matching the recommendation as accepted", () => {
    const r = buildFitterOutcomesReport([session()], []);
    expect(r.acceptance.accepted).toBe(1);
    expect(r.acceptance.acceptanceRate).toBe(1);
  });

  it("counts a different ordered mask as an override", () => {
    const r = buildFitterOutcomesReport(
      [session({ orderedMaskModelId: MASK_B })],
      [],
    );
    expect(r.acceptance.overridden).toBe(1);
    expect(r.acceptance.acceptanceRate).toBe(0);
  });

  it("treats an override back onto the recommended mask as agreement", () => {
    // A clinician who opens the override flow and picks the same mask has
    // agreed with the engine, whatever the button was called.
    const r = buildFitterOutcomesReport(
      [session({ overrideMaskModelId: MASK_A, overrideReason: "confirmed" })],
      [],
    );
    expect(r.acceptance.accepted).toBe(1);
    expect(r.acceptance.overridden).toBe(0);
  });

  it("surfaces missing override reasons instead of dropping them", () => {
    // An override with no stated reason is the most actionable entry on
    // the list — it means the review queue is losing the "why".
    const r = buildFitterOutcomesReport(
      [
        session({
          overrideMaskModelId: MASK_B,
          overrideReason: "leak at bridge",
        }),
        session({ overrideMaskModelId: MASK_B, overrideReason: "  " }),
        session({ overrideMaskModelId: MASK_B, overrideReason: null }),
      ],
      [],
    );
    const reasons = Object.fromEntries(
      r.acceptance.topOverrideReasons.map((x) => [x.reason, x.count]),
    );
    expect(reasons["(no reason given)"]).toBe(2);
    expect(reasons["leak at bridge"]).toBe(1);
  });

  it("ignores a session with no recommendation at all", () => {
    const r = buildFitterOutcomesReport(
      [session({ primaryMaskModelId: null, orderedMaskModelId: MASK_B })],
      [],
    );
    expect(r.acceptance.decided).toBe(0);
    expect(r.acceptance.undecided).toBe(1);
  });
});

describe("buildFitterOutcomesReport — session mix", () => {
  it("splits by entry point so in-office and remote can be compared", () => {
    const r = buildFitterOutcomesReport(
      [
        session({ entryPoint: "in_office" }),
        session({ entryPoint: "in_office" }),
        session({ entryPoint: "remote_link" }),
      ],
      [],
    );
    expect(r.sessions.byEntryPoint.in_office).toBe(2);
    expect(r.sessions.byEntryPoint.remote_link).toBe(1);
    expect(r.sessions.byEntryPoint.kiosk_qr).toBe(0);
  });

  it("counts an unrecorded outcome separately from a low-confidence one", () => {
    const r = buildFitterOutcomesReport(
      [session({ outcome: null }), session({ outcome: "low_confidence" })],
      [],
    );
    expect(r.sessions.outcomeUnknown).toBe(1);
    expect(r.sessions.byOutcome.low_confidence).toBe(1);
    expect(r.sessions.highConfidenceRate).toBe(0);
  });

  it("counts an unrecorded scan grade separately from a poor one", () => {
    const r = buildFitterOutcomesReport(
      [
        session({ scanQualityGrade: null }),
        session({ scanQualityGrade: "poor" }),
      ],
      [],
    );
    expect(r.sessions.scanQualityUnknown).toBe(1);
    expect(r.sessions.byScanQuality.poor).toBe(1);
  });
});

describe("buildFitterOutcomesReport — review latency", () => {
  it("takes the median over reviewed sessions only", () => {
    const r = buildFitterOutcomesReport(
      [
        session({
          createdAt: "2026-08-01T00:00:00Z",
          reviewedAt: "2026-08-01T02:00:00Z",
        }),
        session({
          createdAt: "2026-08-01T00:00:00Z",
          reviewedAt: "2026-08-01T10:00:00Z",
        }),
        session({ reviewedAt: null }),
      ],
      [],
    );
    expect(r.dispensing.medianHoursToReview).toBeCloseTo(6);
  });

  it("drops a negative latency rather than letting it drag the median", () => {
    // Clock skew or a backfilled row — not a review that happened before
    // the fitting.
    const r = buildFitterOutcomesReport(
      [
        session({
          createdAt: "2026-08-01T10:00:00Z",
          reviewedAt: "2026-08-01T08:00:00Z",
        }),
        session({
          createdAt: "2026-08-01T00:00:00Z",
          reviewedAt: "2026-08-01T04:00:00Z",
        }),
      ],
      [],
    );
    expect(r.dispensing.medianHoursToReview).toBeCloseTo(4);
  });
});
