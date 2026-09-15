import { describe, expect, it } from "vitest";
import {
  ownerAnalyticsCsv,
  ownerDateRangeError,
} from "./owner-analytics-report";
import type { OwnerAnalyticsResponse } from "./owner-analytics-api";

describe("Owner report date boundaries", () => {
  const now = new Date("2026-09-14T12:00:00Z");
  it("accepts an inclusive leap-year 366-day window and rejects the next day", () => {
    expect(ownerDateRangeError("2024-01-01", "2024-12-31", now)).toBeNull();
    expect(ownerDateRangeError("2024-01-01", "2025-01-01", now)).toContain(
      "366 days",
    );
  });
  it("rejects impossible, reverse and future dates without normalizing them", () => {
    expect(ownerDateRangeError("2026-02-30", "2026-03-01", now)).toContain(
      "valid dates",
    );
    expect(ownerDateRangeError("2026-09-14", "2026-09-13", now)).toContain(
      "on or after",
    );
    expect(ownerDateRangeError("2026-09-14", "2026-09-15", now)).toContain(
      "earlier end date",
    );
  });
});

it("quotes CSV values, neutralizes formula-like free text and documents missing sections", () => {
  const report: OwnerAnalyticsResponse = {
    generatedAt: "2026-09-14T12:00:00Z",
    window: {
      from: "2026-08-15T12:00:00Z",
      to: "2026-09-14T12:00:00Z",
      previousFrom: "2026-07-16T12:00:00Z",
      previousTo: "2026-08-15T12:00:00Z",
    },
    business: {
      status: "unavailable",
      message: ' \t=HYPERLINK("example")\nUnavailable',
    },
    financial: { status: "unavailable", message: "Retry financial data." },
  };
  const csv = ownerAnalyticsCsv(report);
  expect(csv).toContain('"\' \t=HYPERLINK(""example"")\nUnavailable"');
  expect(csv).toContain('"Financial","Unavailable","Excluded from export"');
  expect(csv).toContain("Equal elapsed duration");
  expect(csv).toContain("not company profit");
});
