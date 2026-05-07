// Pure-function tests for the adherence-scoring rule. The DB-touching
// `scanCompliance` is exercised through integration; here we lock in
// the threshold ladder so a refactor of the policy can't silently
// flip "warning" to "on_track".

import { describe, expect, it } from "vitest";

import { scoreAdherence } from "./compliance-scanner";

describe("scoreAdherence", () => {
  it("returns on_track when fewer than 7 days have elapsed", () => {
    expect(scoreAdherence(0, 0).level).toBe("on_track");
    expect(scoreAdherence(6, 0).level).toBe("on_track");
  });

  it("warns at day 7-29 when below 50%", () => {
    expect(scoreAdherence(7, 0.49).level).toBe("warning");
    expect(scoreAdherence(7, 0.5).level).toBe("on_track");
    expect(scoreAdherence(29, 0.4).level).toBe("warning");
  });

  it("escalates to critical only past day 30", () => {
    expect(scoreAdherence(30, 0.39).level).toBe("critical");
    expect(scoreAdherence(30, 0.45).level).toBe("warning");
    expect(scoreAdherence(30, 0.6).level).toBe("on_track");
  });

  it("uses the day 60-89 ladder", () => {
    expect(scoreAdherence(60, 0.44).level).toBe("critical");
    expect(scoreAdherence(60, 0.5).level).toBe("warning");
    expect(scoreAdherence(60, 0.65).level).toBe("on_track");
  });

  it("treats day 90+ failures as critical regardless of gap size", () => {
    expect(scoreAdherence(90, 0.69).level).toBe("critical");
    expect(scoreAdherence(120, 0.5).level).toBe("critical");
    expect(scoreAdherence(90, 0.7).level).toBe("on_track");
  });

  it("returns the threshold target alongside the level", () => {
    expect(scoreAdherence(45, 0.55).target).toBe(0.6);
    expect(scoreAdherence(75, 0.55).target).toBe(0.65);
    expect(scoreAdherence(95, 0.5).target).toBe(0.7);
  });
});
