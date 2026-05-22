// Pure date-preset helpers extracted from admin-reports.tsx so they
// can be unit-tested without spinning up a TSX/JSX-aware test
// runner. The admin-reports.tsx file re-exports DATE_PRESETS from
// here so the UI keeps a single import point.
//
// Semantics:
//   * "Last N days" — TO is `now`, FROM is `now - N days`.
//   * "This month" — first of current month → today.
//   * "Last month" — first → last of previous calendar month.
//   * "Last quarter" — full prior calendar quarter (Jan-Mar, Apr-
//      Jun, Jul-Sep, Oct-Dec).
//   * "Year to date" — Jan 1 of current year → today.
//
// Date math runs in UTC so a developer on PT and one on ET get the
// same answer for "today". The Reports backend also parses ranges
// in UTC (parseRange in routes/admin/reports.ts), so this matches.

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface DatePreset {
  label: string;
  testId: string;
  compute: (now: Date) => { from: string; to: string };
}

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function endOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

function startOfQuarter(d: Date): Date {
  const month = Math.floor(d.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(d.getUTCFullYear(), month, 1));
}

export const DATE_PRESETS: ReadonlyArray<DatePreset> = [
  {
    label: "Last 7 days",
    testId: "preset-7d",
    compute: (now) => {
      const from = new Date(now.getTime() - 7 * 86400_000);
      return { from: isoDate(from), to: isoDate(now) };
    },
  },
  {
    label: "Last 30 days",
    testId: "preset-30d",
    compute: (now) => {
      const from = new Date(now.getTime() - 30 * 86400_000);
      return { from: isoDate(from), to: isoDate(now) };
    },
  },
  {
    label: "This month",
    testId: "preset-this-month",
    compute: (now) => ({
      from: isoDate(startOfMonth(now)),
      to: isoDate(now),
    }),
  },
  {
    label: "Last month",
    testId: "preset-last-month",
    compute: (now) => {
      const lastMonth = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
      );
      return {
        from: isoDate(startOfMonth(lastMonth)),
        to: isoDate(endOfMonth(lastMonth)),
      };
    },
  },
  {
    label: "Last quarter",
    testId: "preset-last-quarter",
    compute: (now) => {
      const currentQuarterStart = startOfQuarter(now);
      const lastQuarterEnd = new Date(
        currentQuarterStart.getTime() - 86400_000,
      );
      const lastQuarterStart = startOfQuarter(lastQuarterEnd);
      return {
        from: isoDate(lastQuarterStart),
        to: isoDate(lastQuarterEnd),
      };
    },
  },
  {
    label: "Year to date",
    testId: "preset-ytd",
    compute: (now) => ({
      from: isoDate(new Date(Date.UTC(now.getUTCFullYear(), 0, 1))),
      to: isoDate(now),
    }),
  },
];
