// Tests for pages/admin/admin-therapy-usage-report.tsx
//
// The vitest environment is "node" (no DOM). We read the source as a
// string and assert structural invariants — exported symbols, imported
// dependencies, key formatting helpers, component presence, and print
// behaviour. Mirrors the approach used in admin-analytics.test.ts.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-therapy-usage-report.tsx"),
  "utf8",
);

// ── Exports ───────────────────────────────────────────────────────────────────

describe("admin-therapy-usage-report — exports", () => {
  it("exports AdminTherapyUsageReportPage", () => {
    expect(SRC).toContain("export function AdminTherapyUsageReportPage");
  });
});

// ── Imports ───────────────────────────────────────────────────────────────────

describe("admin-therapy-usage-report — imports", () => {
  it("imports from the therapy-usage-report-api lib", () => {
    expect(SRC).toContain("@/lib/admin/therapy-usage-report-api");
  });

  it("imports fetchTherapyUsageReport", () => {
    expect(SRC).toContain("fetchTherapyUsageReport");
  });

  it("imports TherapyReportGrouping type", () => {
    expect(SRC).toContain("TherapyReportGrouping");
  });

  it("imports useQuery from @tanstack/react-query", () => {
    expect(SRC).toContain("@tanstack/react-query");
    expect(SRC).toContain("useQuery");
  });

  it("imports useState from react", () => {
    expect(SRC).toContain("useState");
  });

  it("imports useMemo from react", () => {
    expect(SRC).toContain("useMemo");
  });

  it("imports recharts components for the bar chart", () => {
    expect(SRC).toContain("recharts");
    expect(SRC).toContain("BarChart");
    expect(SRC).toContain("ResponsiveContainer");
  });

  it("imports Printer icon from lucide-react", () => {
    expect(SRC).toContain("Printer");
  });

  it("imports Spinner from @/components/admin/Spinner", () => {
    expect(SRC).toContain("Spinner");
  });

  it("imports ErrorPanel from @/components/admin/ErrorPanel", () => {
    expect(SRC).toContain("ErrorPanel");
  });
});

// ── Formatting helpers ────────────────────────────────────────────────────────

describe("admin-therapy-usage-report — formatting helpers", () => {
  it("defines a pct() helper for percentage formatting", () => {
    expect(SRC).toContain("function pct(");
  });

  it("pct returns '—' for null values", () => {
    // The null guard must be present.
    const fnStart = SRC.indexOf("function pct(");
    const fnEnd = SRC.indexOf("\n}", fnStart);
    const fnBody = SRC.slice(fnStart, fnEnd);
    expect(fnBody).toContain("null");
    expect(fnBody).toContain("—");
  });

  it("defines a hours() helper for duration formatting", () => {
    expect(SRC).toContain("function hours(");
  });

  it("hours() appends 'h' suffix via template literal", () => {
    const fnStart = SRC.indexOf("function hours(");
    const fnEnd = SRC.indexOf("\n}", fnStart);
    const fnBody = SRC.slice(fnStart, fnEnd);
    // The implementation uses a template literal: `${value}h`
    expect(fnBody).toContain("h`");
  });

  it("defines a num() helper for plain number formatting", () => {
    expect(SRC).toContain("function num(");
  });

  it("defines a formatDate() helper for ISO date display", () => {
    expect(SRC).toContain("function formatDate(");
  });

  it("formatDate uses toLocaleDateString", () => {
    const fnStart = SRC.indexOf("function formatDate(");
    const fnEnd = SRC.indexOf("\n}", fnStart);
    const fnBody = SRC.slice(fnStart, fnEnd);
    expect(fnBody).toContain("toLocaleDateString");
  });

  it("defines a titleCase() helper", () => {
    expect(SRC).toContain("function titleCase(");
  });
});

// ── Component structure ───────────────────────────────────────────────────────

describe("admin-therapy-usage-report — component structure", () => {
  it("defines ReportSheet component", () => {
    expect(SRC).toContain("function ReportSheet(");
  });

  it("defines CoverBand component", () => {
    expect(SRC).toContain("function CoverBand(");
  });

  it("defines HeroStats component", () => {
    expect(SRC).toContain("function HeroStats(");
  });

  it("defines AdherenceChart component", () => {
    expect(SRC).toContain("function AdherenceChart(");
  });

  it("defines DetailTable component", () => {
    expect(SRC).toContain("function DetailTable(");
  });

  it("defines CapabilitiesSection component", () => {
    expect(SRC).toContain("function CapabilitiesSection(");
  });

  it("defines ReportFooter component", () => {
    expect(SRC).toContain("function ReportFooter(");
  });

  it("defines Segmented control component", () => {
    expect(SRC).toContain("function Segmented(");
  });

  it("defines ComplianceCell component", () => {
    expect(SRC).toContain("function ComplianceCell(");
  });

  it("defines SectionTitle component", () => {
    expect(SRC).toContain("function SectionTitle(");
  });

  it("defines ReportPrintStyles component that injects CSS", () => {
    expect(SRC).toContain("function ReportPrintStyles(");
  });
});

// ── Groupings and windows ─────────────────────────────────────────────────────

describe("admin-therapy-usage-report — grouping constants", () => {
  it("declares all three grouping axes: provider, patient, manufacturer", () => {
    expect(SRC).toContain('"provider"');
    expect(SRC).toContain('"patient"');
    expect(SRC).toContain('"manufacturer"');
  });

  it("default grouping state is 'provider'", () => {
    // The useState initial value for grouping.
    expect(SRC).toContain('useState<TherapyReportGrouping>("provider")');
  });

  it("default window days state is 90", () => {
    expect(SRC).toContain("useState(90)");
  });

  it("defines WINDOWS array with typical reporting periods", () => {
    expect(SRC).toContain("WINDOWS");
    // 30, 90, 180, 365 should all be present
    expect(SRC).toContain("30");
    expect(SRC).toContain("90");
    expect(SRC).toContain("180");
    expect(SRC).toContain("365");
  });
});

// ── Print / PDF support ───────────────────────────────────────────────────────

describe("admin-therapy-usage-report — print and PDF support", () => {
  it("has a print button that calls window.print()", () => {
    expect(SRC).toContain("window.print()");
  });

  it("uses data-print-hide attribute to hide controls from print", () => {
    expect(SRC).toContain("data-print-hide");
  });

  it("scopes print CSS to #therapy-report id", () => {
    expect(SRC).toContain("#therapy-report");
    expect(SRC).toContain("@media print");
  });

  it("uses visibility: hidden trick to isolate the report for printing", () => {
    expect(SRC).toContain("visibility: hidden");
    expect(SRC).toContain("visibility: visible");
  });

  it("defines @page margin for print layout", () => {
    expect(SRC).toContain("@page");
    expect(SRC).toContain("margin");
  });
});

// ── Query / data loading ──────────────────────────────────────────────────────

describe("admin-therapy-usage-report — query wiring", () => {
  it("uses queryKey prefixed with 'admin' and 'therapy-usage-report'", () => {
    expect(SRC).toContain('"admin"');
    expect(SRC).toContain('"therapy-usage-report"');
  });

  it("handles isPending state with a Spinner", () => {
    expect(SRC).toContain("isPending");
    expect(SRC).toContain("Spinner");
  });

  it("handles isError state with an ErrorPanel", () => {
    expect(SRC).toContain("isError");
    expect(SRC).toContain("ErrorPanel");
  });

  it("provides a retry callback to ErrorPanel", () => {
    expect(SRC).toContain("onRetry");
    expect(SRC).toContain("refetch");
  });
});

// ── CMS compliance narrative ──────────────────────────────────────────────────

describe("admin-therapy-usage-report — CMS compliance messaging", () => {
  it("mentions CMS 4-hour threshold", () => {
    expect(SRC).toContain("4");
    // The "4h" / "4-hour" / "≥4h" must appear somewhere.
    const hasCmsRef =
      SRC.includes("≥4h") ||
      SRC.includes("≥ 4") ||
      SRC.includes("4 hours") ||
      SRC.includes("4-hour");
    expect(hasCmsRef).toBe(true);
  });

  it("mentions 70% night threshold", () => {
    const has70 =
      SRC.includes("70%") || SRC.includes("70 percent") || SRC.includes("≥70%");
    expect(has70).toBe(true);
  });

  it("shows de-identification disclaimer in footer", () => {
    expect(SRC).toContain("de-identified");
  });

  it("references CHART_TOP_N constant to cap the chart to top N cohorts", () => {
    expect(SRC).toContain("CHART_TOP_N");
  });
});

// ── Marketing capabilities section ───────────────────────────────────────────

describe("admin-therapy-usage-report — capabilities section", () => {
  it("defines CAPABILITIES array", () => {
    expect(SRC).toContain("CAPABILITIES");
  });

  it("mentions ResMed in the cloud-platform description", () => {
    expect(SRC).toContain("ResMed");
  });

  it("mentions Philips in the cloud-platform description", () => {
    expect(SRC).toContain("Philips");
  });

  it("renders each capability with an icon", () => {
    expect(SRC).toContain("CloudCog");
    expect(SRC).toContain("Activity");
    expect(SRC).toContain("ShieldCheck");
    expect(SRC).toContain("HeartPulse");
    expect(SRC).toContain("Truck");
    expect(SRC).toContain("Sparkles");
  });
});