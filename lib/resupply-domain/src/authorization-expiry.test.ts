import { describe, expect, it } from "vitest";

import {
  DWO_HEADS_UP_DAYS,
  PRIOR_AUTH_HEADS_UP_DAYS,
  classifyExpiry,
  headsUpSeverity,
} from "./authorization-expiry";

describe("heads-up windows + severity", () => {
  it("keeps the per-document windows distinct", () => {
    expect([...PRIOR_AUTH_HEADS_UP_DAYS]).toEqual([30, 14, 7]);
    expect([...DWO_HEADS_UP_DAYS]).toEqual([60, 30, 7]);
  });

  it("escalates to critical within 7 days", () => {
    expect(headsUpSeverity(30)).toBe("warning");
    expect(headsUpSeverity(8)).toBe("warning");
    expect(headsUpSeverity(7)).toBe("critical");
    expect(headsUpSeverity(0)).toBe("critical");
  });
});

describe("classifyExpiry", () => {
  const today = "2026-06-20";

  it("is ok when no end date / unparseable", () => {
    expect(classifyExpiry(null, today, PRIOR_AUTH_HEADS_UP_DAYS).state).toBe(
      "ok",
    );
    expect(classifyExpiry("nope", today, PRIOR_AUTH_HEADS_UP_DAYS).state).toBe(
      "ok",
    );
  });

  it("is ok well outside the widest window", () => {
    const r = classifyExpiry("2026-12-31", today, PRIOR_AUTH_HEADS_UP_DAYS);
    expect(r.state).toBe("ok");
    expect(r.daysOut).toBeGreaterThan(30);
  });

  it("is expiring inside the window, with exact window + severity", () => {
    const r = classifyExpiry("2026-07-04", today, PRIOR_AUTH_HEADS_UP_DAYS); // 14 days out
    expect(r.state).toBe("expiring");
    expect(r.daysOut).toBe(14);
    expect(r.matchedWindow).toBe(14);
    expect(r.severity).toBe("warning");
  });

  it("is critical within 7 days", () => {
    const r = classifyExpiry("2026-06-25", today, PRIOR_AUTH_HEADS_UP_DAYS); // 5 days
    expect(r.state).toBe("expiring");
    expect(r.severity).toBe("critical");
    expect(r.matchedWindow).toBeNull(); // 5 isn't an exact window
  });

  it("is expired when the end date is in the past", () => {
    const r = classifyExpiry("2026-06-10", today, PRIOR_AUTH_HEADS_UP_DAYS);
    expect(r.state).toBe("expired");
    expect(r.daysOut).toBeLessThan(0);
    expect(r.severity).toBe("critical");
  });
});
