import { describe, expect, it } from "vitest";

import {
  SAME_OR_SIMILAR_WINDOW_MONTHS,
  evaluateSameOrSimilar,
} from "./same-or-similar";

describe("evaluateSameOrSimilar", () => {
  it("is clear when there is no prior dispense", () => {
    const r = evaluateSameOrSimilar({
      lastDispenseOn: null,
      asOf: "2026-06-20",
    });
    expect(r.status).toBe("clear");
    expect(r.blocked).toBe(false);
    expect(r.clearsOn).toBeNull();
  });

  it("blocks while inside the 60-month window and dates the clear", () => {
    const r = evaluateSameOrSimilar({
      lastDispenseOn: "2024-01-15",
      asOf: "2026-06-20",
    });
    expect(r.status).toBe("active");
    expect(r.blocked).toBe(true);
    expect(r.clearsOn).toBe("2029-01-15");
    expect(r.daysUntilClear).toBeGreaterThan(0);
    expect(r.reason).toContain("clears 2029-01-15");
  });

  it("is clear once the window has fully elapsed", () => {
    const r = evaluateSameOrSimilar({
      lastDispenseOn: "2019-01-15",
      asOf: "2026-06-20",
    });
    expect(r.status).toBe("clear");
    expect(r.blocked).toBe(false);
    expect(r.clearsOn).toBe("2024-01-15");
    expect(r.daysUntilClear).toBe(0);
  });

  it("is active on the day before the window clears, clear on the clear date", () => {
    const justBefore = evaluateSameOrSimilar({
      lastDispenseOn: "2021-06-20",
      asOf: "2026-06-19",
      windowMonths: SAME_OR_SIMILAR_WINDOW_MONTHS,
    });
    expect(justBefore.status).toBe("active");
    const onClear = evaluateSameOrSimilar({
      lastDispenseOn: "2021-06-20",
      asOf: "2026-06-20",
    });
    expect(onClear.status).toBe("clear");
  });

  it("honors a custom window", () => {
    const r = evaluateSameOrSimilar({
      lastDispenseOn: "2026-01-01",
      asOf: "2026-04-01",
      windowMonths: 6,
    });
    expect(r.status).toBe("active");
    expect(r.clearsOn).toBe("2026-07-01");
  });

  it("returns unknown for an unparseable date", () => {
    const r = evaluateSameOrSimilar({
      lastDispenseOn: "not-a-date",
      asOf: "2026-06-20",
    });
    expect(r.status).toBe("unknown");
    expect(r.blocked).toBe(false);
  });
});
