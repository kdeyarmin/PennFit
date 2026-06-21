import { describe, it, expect } from "vitest";

import { timelyFilingStatus } from "./timely-filing";

const ASOF = "2026-05-31T12:00:00.000Z";

describe("timelyFilingStatus", () => {
  it("is ok when comfortably within the window", () => {
    // DOS 2026-05-01 + 365d → deadline 2027-05-01.
    const r = timelyFilingStatus({
      dateOfService: "2026-05-01",
      filingWindowDays: 365,
      asOf: ASOF,
    });
    expect(r.status).toBe("ok");
    expect(r.deadline).toBe("2027-05-01");
    expect(r.daysRemaining).toBeGreaterThan(300);
  });

  it("is due_soon on the deadline day (0 days remaining, not overdue)", () => {
    // DOS 2026-04-01 + 60d → deadline 2026-05-31 == asOf date.
    const r = timelyFilingStatus({
      dateOfService: "2026-04-01",
      filingWindowDays: 60,
      asOf: ASOF,
    });
    expect(r.deadline).toBe("2026-05-31");
    expect(r.daysRemaining).toBe(0);
    expect(r.status).toBe("due_soon");
  });

  it("is overdue past the deadline", () => {
    // DOS 2026-01-01 + 90d → deadline 2026-04-01 < asOf.
    const r = timelyFilingStatus({
      dateOfService: "2026-01-01",
      filingWindowDays: 90,
      asOf: ASOF,
    });
    expect(r.status).toBe("overdue");
    expect(r.daysRemaining).toBeLessThan(0);
  });

  it("is unknown when the window is missing or non-positive", () => {
    expect(
      timelyFilingStatus({
        dateOfService: "2026-05-01",
        filingWindowDays: null,
        asOf: ASOF,
      }).status,
    ).toBe("unknown");
    expect(
      timelyFilingStatus({
        dateOfService: "2026-05-01",
        filingWindowDays: 0,
        asOf: ASOF,
      }),
    ).toEqual({ status: "unknown", daysRemaining: null, deadline: null });
  });

  it("is unknown when the date of service is unparseable", () => {
    expect(
      timelyFilingStatus({
        dateOfService: "not-a-date",
        filingWindowDays: 365,
        asOf: ASOF,
      }).status,
    ).toBe("unknown");
  });

  it("respects a custom due-soon threshold", () => {
    // DOS 2026-05-01 + 50d → deadline 2026-06-20 = ~20 days out.
    const base = {
      dateOfService: "2026-05-01",
      filingWindowDays: 50,
      asOf: ASOF,
    };
    expect(timelyFilingStatus(base).status).toBe("ok"); // default 14
    expect(
      timelyFilingStatus({ ...base, dueSoonThresholdDays: 30 }).status,
    ).toBe("due_soon");
  });

  it("defaults asOf to now when omitted", () => {
    // DOS today + a tiny 1-day window → deadline is yesterday/today, so the
    // count cannot be a large positive number. With a far-future DOS and a
    // huge window it must be comfortably "ok". We assert against the real
    // clock without pinning an exact day (avoids a midnight-UTC flake).
    const farFuture = new Date(Date.now() + 200 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const r = timelyFilingStatus({
      dateOfService: farFuture,
      filingWindowDays: 365,
    });
    expect(r.status).toBe("ok");
    expect(r.daysRemaining).toBeGreaterThan(0);
    expect(Number.isNaN(r.daysRemaining ?? NaN)).toBe(false);
  });

  it("falls back to now for an unparseable asOf (never fabricates overdue)", () => {
    // Same far-future DOS; a garbage asOf must NOT poison the countdown with
    // NaN — it falls back to now, yielding the same comfortable "ok".
    const farFuture = new Date(Date.now() + 200 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const r = timelyFilingStatus({
      dateOfService: farFuture,
      filingWindowDays: 365,
      asOf: "not-a-real-date",
    });
    expect(r.status).toBe("ok");
    expect(Number.isNaN(r.daysRemaining ?? NaN)).toBe(false);
  });

  it("is due_soon at exactly the threshold and ok just past it", () => {
    // asOf date = 2026-05-31. Tune the window so the deadline lands exactly
    // 14 then 15 days out, straddling the default due-soon threshold (14).
    const at14 = timelyFilingStatus({
      dateOfService: "2026-05-01", // +44d → 2026-06-14 == asOf + 14d
      filingWindowDays: 44,
      asOf: ASOF,
    });
    expect(at14.daysRemaining).toBe(14);
    expect(at14.status).toBe("due_soon"); // <= 14 is due_soon

    const at15 = timelyFilingStatus({
      dateOfService: "2026-05-01", // +45d → 2026-06-15 == asOf + 15d
      filingWindowDays: 45,
      asOf: ASOF,
    });
    expect(at15.daysRemaining).toBe(15);
    expect(at15.status).toBe("ok"); // 15 > 14 → ok
  });

  it("truncates a fractional filingWindowDays toward zero (Math.trunc)", () => {
    // 60.9 days must behave exactly like 60 (NOT round up to 61): DOS
    // 2026-04-01 + trunc(60.9)=60 → deadline 2026-05-31 == asOf → 0 remaining.
    const r = timelyFilingStatus({
      dateOfService: "2026-04-01",
      filingWindowDays: 60.9,
      asOf: ASOF,
    });
    expect(r.deadline).toBe("2026-05-31");
    expect(r.daysRemaining).toBe(0);
    expect(r.status).toBe("due_soon");
  });
});
