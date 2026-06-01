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
});
