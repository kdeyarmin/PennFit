import type { OwnerAnalyticsResponse } from "./owner-analytics-api";

export function ownerDateRangeError(
  from: string,
  to: string,
  now = new Date(),
): string | null {
  const start = Date.parse(`${from}T00:00:00.000Z`),
    end = Date.parse(`${to}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    new Date(start).toISOString().slice(0, 10) !== from ||
    new Date(end).toISOString().slice(0, 10) !== to
  )
    return "Enter both valid dates.";
  if (end < start) return "End date must be on or after start date.";
  if (to > now.toISOString().slice(0, 10))
    return "Choose today or an earlier end date (UTC).";
  if ((end - start) / 86_400_000 >= 366)
    return "Choose a range of 366 days or fewer.";
  return null;
}

export function ownerLabel(key: string): string {
  const labels: Record<string, string> = {
    unitsQueued: "Units prepared",
    fulfillmentLinesQueued: "Fulfillment lines prepared",
    episodesConfirmed: "Confirmed outcomes of episodes opened in period",
    episodesFulfilled: "Fulfilled outcomes of episodes opened in period",
    episodesAssumedShipped:
      "Assumed-shipped outcomes of episodes opened in period",
    claimBilledCents: "Billed on claims created in period",
    claimPaidToDateCents: "Paid to date on claims created in period",
    boundOrders: "Bound financial reviews",
    settledOrders: "Completed financial reviews",
  };
  if (labels[key]) return labels[key];
  const words = key
    .replace(/Cents$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type CsvValue = string | number | { kind: "money"; cents: number };

function reportValue(value: number | boolean, money: boolean): CsvValue {
  return typeof value === "boolean"
    ? value
      ? "Yes"
      : "No"
    : money
      ? { kind: "money", cents: value }
      : value;
}

function csvCell(value: CsvValue): string {
  if (typeof value === "object") {
    if (!Number.isSafeInteger(value.cents))
      throw new Error("Invalid report monetary amount.");
    // Keep signed cents exact, including totals near the safe-integer limit.
    // Only these explicitly typed money cells bypass text-formula protection.
    const cents = BigInt(value.cents);
    const absolute = cents < 0n ? -cents : cents;
    return `"${cents < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}"`;
  }
  let text = String(value);
  const firstSignificant = Array.from(text).find(
    (character) => character.charCodeAt(0) > 32 && !/\s/.test(character),
  );
  if (
    typeof value === "string" &&
    ["=", "+", "-", "@"].includes(firstSignificant ?? "")
  )
    text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** All values belong to this returned snapshot, never a pending filter draft. */
export function ownerAnalyticsCsv(report: OwnerAnalyticsResponse): string {
  const rows: CsvValue[][] = [
    ["Section", "Scope", "Metric", "Current", "Previous", "Unit", "Detail"],
    ["Report", "Snapshot", "Generated at", report.generatedAt, "", "UTC", ""],
    ["Report", "Period", "From (inclusive)", report.window.from, "", "UTC", ""],
    ["Report", "Period", "To (exclusive)", report.window.to, "", "UTC", ""],
    [
      "Report",
      "Comparison",
      "From (inclusive)",
      report.window.previousFrom,
      "",
      "UTC",
      "",
    ],
    [
      "Report",
      "Comparison",
      "To (exclusive)",
      report.window.previousTo,
      "",
      "UTC",
      "Equal elapsed duration",
    ],
  ];
  const record = (
    section: string,
    scope: string,
    current: Record<string, number | boolean>,
    previous?: Record<string, number | boolean>,
  ) => {
    for (const [key, value] of Object.entries(current)) {
      const money = key.endsWith("Cents");
      rows.push([
        section,
        scope,
        ownerLabel(key),
        reportValue(value, money),
        previous?.[key] === undefined ? "" : reportValue(previous[key], money),
        money ? "USD" : typeof value === "boolean" ? "Setting" : "Count",
        "",
      ]);
    }
  };
  const table = (
    section: string,
    scope: string,
    records: Array<Record<string, string | number | null>>,
  ) => {
    for (const row of records) {
      const detail = Object.entries(row)
        .filter(([, value]) => typeof value === "string")
        .map(([key, value]) => `${ownerLabel(key)}: ${value}`)
        .join("; ");
      for (const [key, value] of Object.entries(row))
        if (typeof value === "number")
          rows.push([
            section,
            scope,
            ownerLabel(key),
            reportValue(value, key.endsWith("Cents")),
            "",
            key.endsWith("Cents") ? "USD" : "Count",
            detail,
          ]);
    }
  };
  if (report.business.status === "available") {
    const b = report.business.data;
    record("Business", "Selected period", b.current, b.previous);
    record("Business", "Current snapshot", b.snapshot);
    table("Business", "Daily activity", b.daily);
    table(
      "Business",
      "Current status of order requests created in period",
      b.orderRequestStages,
    );
    table(
      "Business",
      "Current status of resupply episodes opened in period",
      b.resupplyStages,
    );
    table(
      "Business",
      "Current status of claims created in period",
      b.claimStages,
    );
    table("Business", "Current claim aging", b.claimAging);
    table(
      "Business",
      "Payers: claims created in period, paid to date",
      b.payers,
    );
    table(
      "Business",
      "Top 10 products by units shipped in period",
      b.topProducts,
    );
    table("Business", "Current low stock", b.lowStock);
    table("Business", "Outreach channels", b.outreachChannels);
  } else
    rows.push([
      "Business",
      "Unavailable",
      "Excluded from export",
      "",
      "",
      "",
      report.business.message,
    ]);
  if (report.financial.status === "available") {
    const f = report.financial.data;
    record(
      "Financial",
      "Recorded revenue and cost events in period",
      f.current,
      f.previous,
    );
    record(
      "Financial",
      "Lifetime bound reviews; contribution only completed reviews",
      f.settled,
    );
    record("Financial", "Event date quality", f.quality);
    record("Financial", "Current pricing settings", f.pricing);
    table("Financial", "Daily recorded event activity", f.daily);
    table("Financial", "Recorded cost sources", f.costSources);
  } else
    rows.push([
      "Financial",
      "Unavailable",
      "Excluded from export",
      "",
      "",
      "",
      report.financial.message,
    ]);
  rows.push(
    [
      "Definitions",
      "Financial",
      "Scope",
      "",
      "",
      "",
      "Tracked pricing reviews only. Recorded revenue and cost activity is not company profit or a complete bank/insurance ledger. Lifetime completed-review contribution is separate from period event activity.",
    ],
    [
      "Definitions",
      "Business",
      "Scope",
      "",
      "",
      "",
      "Current snapshots are not historical period balances. Billed claims and paid-to-date amounts do not measure collectible accounts receivable. Shipments, units, patients, and orders are different measures.",
    ],
  );
  return "\ufeff" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
