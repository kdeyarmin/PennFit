import { describe, expect, it } from "vitest";

import { COMPLIANCE_NIGHT_RATIO } from "./cms-adherence";
import { scoreAdherenceTarget } from "./adherence-target";

describe("scoreAdherenceTarget", () => {
  it("is on_track (target 0) in the first week", () => {
    expect(scoreAdherenceTarget(0, 0)).toEqual({
      level: "on_track",
      target: 0,
    });
    expect(scoreAdherenceTarget(6, 0).level).toBe("on_track");
  });

  it("warns below the 0.5 target in days 7-29", () => {
    expect(scoreAdherenceTarget(7, 0.49).level).toBe("warning");
    expect(scoreAdherenceTarget(7, 0.5).level).toBe("on_track");
    expect(scoreAdherenceTarget(29, 0.4).level).toBe("warning");
  });

  it("escalates to critical below 0.4 in days 30-59", () => {
    expect(scoreAdherenceTarget(30, 0.39).level).toBe("critical");
    expect(scoreAdherenceTarget(30, 0.45).level).toBe("warning");
    expect(scoreAdherenceTarget(30, 0.6).level).toBe("on_track");
    expect(scoreAdherenceTarget(45, 0.55).target).toBe(0.6);
  });

  it("uses the 0.65 target with a 0.45 critical floor in days 60-89", () => {
    expect(scoreAdherenceTarget(60, 0.44).level).toBe("critical");
    expect(scoreAdherenceTarget(60, 0.5).level).toBe("warning");
    expect(scoreAdherenceTarget(60, 0.65).level).toBe("on_track");
    expect(scoreAdherenceTarget(75, 0.55).target).toBe(0.65);
  });

  it("anchors the 90+ bar to the CMS ratio and fails critical", () => {
    expect(scoreAdherenceTarget(90, 0.69).level).toBe("critical");
    expect(scoreAdherenceTarget(120, 0.5).level).toBe("critical");
    expect(scoreAdherenceTarget(90, 0.7).level).toBe("on_track");
    expect(scoreAdherenceTarget(95, 0.5).target).toBe(COMPLIANCE_NIGHT_RATIO);
  });
});
