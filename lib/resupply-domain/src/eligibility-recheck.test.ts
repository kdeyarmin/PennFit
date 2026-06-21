import { describe, it, expect } from "vitest";

import {
  buildVerificationWorklist,
  classifyEligibilityRecency,
  DEFAULT_ELIGIBILITY_STALE_DAYS,
  type CoverageInput,
} from "./eligibility-recheck";

const ASOF = "2026-05-31T12:00:00.000Z";

const coverage = (over: Partial<CoverageInput>): CoverageInput => ({
  id: "cov-1",
  patientId: "pat-1",
  rank: "primary",
  payerName: "Acme Health",
  memberIdTail: "1234",
  verifiedAt: "2026-05-20",
  terminationDate: null,
  ...over,
});

describe("DEFAULT_ELIGIBILITY_STALE_DAYS", () => {
  it("is the documented 30-day cadence", () => {
    expect(DEFAULT_ELIGIBILITY_STALE_DAYS).toBe(30);
  });
});

describe("classifyEligibilityRecency", () => {
  const nowMs = Date.parse(ASOF);

  it("bands a coverage with no verifiedAt as never_verified", () => {
    const r = classifyEligibilityRecency(coverage({ verifiedAt: null }), {
      nowMs,
    });
    expect(r.status).toBe("never_verified");
    expect(r.daysSinceVerified).toBeNull();
  });

  it("bands a coverage terminating within the lookahead as terminating_soon", () => {
    // termination 10 days out, verified recently.
    const r = classifyEligibilityRecency(
      coverage({ verifiedAt: "2026-05-29", terminationDate: "2026-06-10" }),
      { nowMs },
    );
    expect(r.status).toBe("terminating_soon");
    expect(r.daysUntilTermination).toBe(10);
  });

  it("bands a coverage verified beyond staleDays as stale", () => {
    // verified 2026-04-01 → ~60 days before asOf, > 30.
    const r = classifyEligibilityRecency(
      coverage({ verifiedAt: "2026-04-01" }),
      { nowMs },
    );
    expect(r.status).toBe("stale");
    expect(r.daysSinceVerified).toBeGreaterThan(30);
  });

  it("bands a recently-verified coverage with no imminent termination as ok", () => {
    const r = classifyEligibilityRecency(
      coverage({ verifiedAt: "2026-05-29" }),
      { nowMs },
    );
    expect(r.status).toBe("ok");
  });

  it("respects a custom staleDays threshold", () => {
    const cov = coverage({ verifiedAt: "2026-05-10" }); // 21 days out
    expect(classifyEligibilityRecency(cov, { nowMs }).status).toBe("ok"); // 21 <= 30
    expect(
      classifyEligibilityRecency(cov, { nowMs, staleDays: 14 }).status,
    ).toBe("stale"); // 21 > 14
  });
});

describe("buildVerificationWorklist", () => {
  it("sorts most-urgent first and counts each band", () => {
    const wl = buildVerificationWorklist(
      [
        coverage({ id: "ok", verifiedAt: "2026-05-29" }),
        coverage({ id: "never", verifiedAt: null }),
        coverage({
          id: "term",
          verifiedAt: "2026-05-29",
          terminationDate: "2026-06-05",
        }),
        coverage({ id: "stale", verifiedAt: "2026-03-01" }),
      ],
      { asOf: ASOF },
    );

    expect(wl.items.map((i) => i.id)).toEqual(["term", "never", "stale", "ok"]);
    expect(wl.counts).toEqual({
      neverVerified: 1,
      terminatingSoon: 1,
      stale: 1,
      ok: 1,
      total: 4,
    });
  });

  it("tie-breaks terminating_soon by soonest termination first", () => {
    const wl = buildVerificationWorklist(
      [
        coverage({
          id: "later",
          verifiedAt: "2026-05-29",
          terminationDate: "2026-06-20",
        }),
        coverage({
          id: "sooner",
          verifiedAt: "2026-05-29",
          terminationDate: "2026-06-03",
        }),
      ],
      { asOf: ASOF },
    );
    expect(wl.items.map((i) => i.id)).toEqual(["sooner", "later"]);
  });

  it("tie-breaks stale by longest-stale first", () => {
    const wl = buildVerificationWorklist(
      [
        coverage({ id: "lessStale", verifiedAt: "2026-04-15" }),
        coverage({ id: "moreStale", verifiedAt: "2026-02-01" }),
      ],
      { asOf: ASOF },
    );
    expect(wl.items.map((i) => i.id)).toEqual(["moreStale", "lessStale"]);
  });

  it("falls back to now for an unparseable asOf", () => {
    const wl = buildVerificationWorklist([coverage({ verifiedAt: null })], {
      asOf: "not-a-date",
    });
    expect(wl.items[0]!.status).toBe("never_verified");
    expect(wl.counts.total).toBe(1);
  });
});
