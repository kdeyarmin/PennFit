import { describe, expect, it } from "vitest";

import {
  ADR_AT_RISK_DAYS,
  ADR_HEADS_UP_DAYS,
  classifyAdrSla,
} from "./claim-adr";

describe("ADR heads-up windows", () => {
  it("uses the short, unforgiving ADR windows", () => {
    expect([...ADR_HEADS_UP_DAYS]).toEqual([14, 7, 2]);
    expect(ADR_AT_RISK_DAYS).toBe(7);
  });
});

describe("classifyAdrSla", () => {
  const today = "2026-06-20";

  it("is decided once submitted/closed, regardless of date", () => {
    const r = classifyAdrSla("2026-06-01", today, { decided: true });
    expect(r.status).toBe("decided");
    expect(r.daysOut).toBeNull();
  });

  it("is on_track with a null daysOut when there is no due date", () => {
    const r = classifyAdrSla(null, today);
    expect(r.status).toBe("on_track");
    expect(r.daysOut).toBeNull();
  });

  it("is on_track well before the deadline", () => {
    const r = classifyAdrSla("2026-07-31", today); // 41 days out
    expect(r.status).toBe("on_track");
    expect(r.daysOut).toBe(41);
  });

  it("is at_risk inside the at-risk window", () => {
    const r = classifyAdrSla("2026-06-25", today); // 5 days out
    expect(r.status).toBe("at_risk");
    expect(r.daysOut).toBe(5);
  });

  it("flags the exact heads-up window for the sweep", () => {
    const r = classifyAdrSla("2026-06-27", today); // 7 days out — a window
    expect(r.status).toBe("at_risk");
    expect(r.matchedWindow).toBe(7);
  });

  it("is at_risk exactly on the boundary day", () => {
    const r = classifyAdrSla("2026-06-27", today, { atRiskDays: 7 });
    expect(r.status).toBe("at_risk");
  });

  it("is overdue once past the deadline", () => {
    const r = classifyAdrSla("2026-06-18", today); // 2 days late
    expect(r.status).toBe("overdue");
    expect(r.daysOut).toBeLessThan(0);
  });

  it("honors a custom at-risk threshold", () => {
    const r = classifyAdrSla("2026-07-04", today, { atRiskDays: 14 }); // 14 out
    expect(r.status).toBe("at_risk");
  });
});
