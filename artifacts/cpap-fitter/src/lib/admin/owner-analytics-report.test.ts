import { describe, expect, it } from "vitest";
import {
  ownerAnalyticsCsv,
  ownerDateRangeError,
} from "./owner-analytics-report";
import type { OwnerAnalyticsResponse } from "./owner-analytics-api";
import Papa from "papaparse";
import { ownerAnalyticsFixture } from "../../pages/admin/owner-analytics.fixture";

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

describe("Owner CSV numeric money", () => {
  it("keeps refunds, credits, previous amounts and lifetime losses numeric and summable", () => {
    const report = ownerAnalyticsFixture();
    if (report.financial.status !== "available")
      throw new Error("Expected financial fixture");
    const f = report.financial.data;
    Object.assign(f.current, { revenueCents: -12345, costCents: -200 });
    Object.assign(f.previous, { revenueCents: -1, costCents: -75 });
    Object.assign(f.settled, {
      netRevenueCents: 10005,
      netCostCents: 60010,
      contributionCents: -50005,
    });
    f.daily = [
      {
        date: "2026-09-13",
        revenueCents: -13345,
        costCents: -250,
        eventCount: 2,
      },
      { date: "2026-09-14", revenueCents: 1000, costCents: 50, eventCount: 2 },
    ];
    f.costSources = [
      { source: "supplier_invoice", costCents: -250, eventCount: 1 },
      { source: "manual", costCents: 50, eventCount: 1 },
    ];
    const csv = ownerAnalyticsCsv(report);
    const result = Papa.parse<Array<string | number>>(csv, {
      dynamicTyping: true,
      skipEmptyLines: true,
    });
    expect(result.errors).toEqual([]);
    const rows = result.data;
    const financial = (scope: string, metric: string) =>
      rows.find(
        (row) =>
          row[0] === "Financial" && row[1] === scope && row[2] === metric,
      )!;
    const period = "Recorded revenue and cost events in period";
    expect(financial(period, "Revenue").slice(3, 6)).toEqual([
      -123.45,
      -0.01,
      "USD",
    ]);
    expect(financial(period, "Cost").slice(3, 6)).toEqual([-2, -0.75, "USD"]);
    const lifetime =
      "Lifetime bound reviews; contribution only completed reviews";
    expect(financial(lifetime, "Contribution")[3]).toBe(-500.05);
    expect(
      Math.round(Number(financial(lifetime, "Net Revenue")[3]) * 100) -
        Math.round(Number(financial(lifetime, "Net Cost")[3]) * 100),
    ).toBe(-50005);
    const sumCents = (scope: string, metric: string) =>
      rows
        .filter(
          (row) =>
            row[0] === "Financial" && row[1] === scope && row[2] === metric,
        )
        .reduce((sum, row) => {
          expect(typeof row[3]).toBe("number");
          return sum + Math.round(Number(row[3]) * 100);
        }, 0);
    expect(sumCents("Daily recorded event activity", "Revenue")).toBe(-12345);
    expect(sumCents("Daily recorded event activity", "Cost")).toBe(-200);
    expect(sumCents("Recorded cost sources", "Cost")).toBe(-200);
    expect(csv).toContain('"Revenue","-123.45","-0.01","USD"');
    expect(csv).toContain('"Cost","-2.00","-0.75","USD"');
    expect(csv).not.toContain("\"'-");
  });

  it("formats the full safe signed-cent range exactly with two decimal places", () => {
    const report = ownerAnalyticsFixture();
    if (report.financial.status !== "available")
      throw new Error("Expected financial fixture");
    report.financial.data.current.revenueCents = -Number.MAX_SAFE_INTEGER;
    report.financial.data.previous.revenueCents = Number.MAX_SAFE_INTEGER;
    report.financial.data.current.costCents = 0;
    report.financial.data.previous.costCents = -1;
    const rows = Papa.parse<string[]>(ownerAnalyticsCsv(report), {
      skipEmptyLines: true,
    }).data;
    const revenue = rows.find(
      (row) =>
        row[0] === "Financial" &&
        row[1] === "Recorded revenue and cost events in period" &&
        row[2] === "Revenue",
    )!;
    expect(revenue.slice(3, 5)).toEqual([
      "-90071992547409.91",
      "90071992547409.91",
    ]);
    expect(BigInt(revenue[3].replace(".", ""))).toBe(
      -BigInt(Number.MAX_SAFE_INTEGER),
    );
    expect(
      rows
        .find(
          (row) =>
            row[0] === "Financial" &&
            row[1] === "Recorded revenue and cost events in period" &&
            row[2] === "Cost",
        )!
        .slice(3, 5),
    ).toEqual(["0.00", "-0.01"]);
  });

  it.each([
    "-123.45",
    "=1+1",
    "+SUM(A1:A2)",
    "@SUM(A1:A2)",
    " \t-123.45",
    "\u0000\u001f=1+1",
    ' \n=HYPERLINK("example")',
  ])(
    "still protects untrusted text %j, including numeric-looking text",
    (message) => {
      const report = ownerAnalyticsFixture();
      report.financial = { status: "unavailable", message };
      const rows = Papa.parse<string[]>(ownerAnalyticsCsv(report), {
        skipEmptyLines: true,
      }).data;
      const row = rows.find(
        (row) => row[0] === "Financial" && row[1] === "Unavailable",
      )!;
      expect(row[6]).toBe(`'${message}`);
    },
  );
});
