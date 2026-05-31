// Static source analysis for pages/admin/admin-therapy-usage-report.tsx.
//
// The vitest environment is "node" (no DOM). We read the source as a string
// and assert structural invariants: exports, imports, component names,
// formatting helper presence, constants, and the print behaviour wiring.
// This mirrors admin-analytics.test.ts and other page-level test files.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-therapy-usage-report.tsx"),
  "utf8",
);

// ─── Page export ──────────────────────────────────────────────────────────────

describe("admin-therapy-usage-report — page export", () => {
  it("exports AdminTherapyUsageReportPage as a named export", () => {
    expect(SRC).toContain("export function AdminTherapyUsageReportPage");
  });
});

// ─── Imports ──────────────────────────────────────────────────────────────────

describe("admin-therapy-usage-report — imports", () => {
  it("imports fetchTherapyUsageReport from the lib module", () => {
    expect(SRC).toContain("fetchTherapyUsageReport");
    expect(SRC).toContain("therapy-usage-report-api");
  });

  it("imports useQuery from @tanstack/react-query", () => {
    expect(SRC).toContain("useQuery");
    expect(SRC).toContain("@tanstack/react-query");
  });

  it("imports useState from react", () => {
    expect(SRC).toContain("useState");
  });

  it("imports useMemo from react", () => {
    expect(SRC).toContain("useMemo");
  });

  it("imports Printer from lucide-react (print button icon)", () => {
    expect(SRC).toContain("Printer");
  });

  it("imports Spinner (loading state)", () => {
    expect(SRC).toContain("Spinner");
  });

  it("imports ErrorPanel (error state)", () => {
    expect(SRC).toContain("ErrorPanel");
  });
});

// ─── GROUPINGS constant ───────────────────────────────────────────────────────

describe("admin-therapy-usage-report — GROUPINGS constant", () => {
  it("declares a GROUPINGS constant", () => {
    expect(SRC).toContain("GROUPINGS");
  });

  it("GROUPINGS includes the provider axis", () => {
    expect(SRC).toContain('"provider"');
  });

  it("GROUPINGS includes the patient axis", () => {
    expect(SRC).toContain('"patient"');
  });

  it("GROUPINGS includes the manufacturer axis", () => {
    expect(SRC).toContain('"manufacturer"');
  });
});

// ─── WINDOWS constant ─────────────────────────────────────────────────────────

describe("admin-therapy-usage-report — WINDOWS constant", () => {
  it("declares a WINDOWS array", () => {
    expect(SRC).toContain("WINDOWS");
  });

  it("includes the 30-day window option", () => {
    // WINDOWS = [30, 60, 90, 180, 365]
    expect(SRC).toContain("30");
  });

  it("includes the 90-day window option", () => {
    expect(SRC).toContain("90");
  });

  it("includes the 365-day window option", () => {
    expect(SRC).toContain("365");
  });
});

// ─── Formatting helpers ───────────────────────────────────────────────────────

describe("admin-therapy-usage-report — formatting helpers", () => {
  it("defines a pct() helper that handles null (returns —)", () => {
    const fnStart = SRC.indexOf("function pct(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = SRC.indexOf("\n}", fnStart);
    const fnBody = SRC.slice(fnStart, fnEnd + 2);
    expect(fnBody).toContain("null");
    // The null branch should return a dash.
    expect(fnBody).toMatch(/[—-]/);
  });

  it("defines a hours() helper", () => {
    expect(SRC).toContain("function hours(");
  });

  it("defines a num() helper", () => {
    expect(SRC).toContain("function num(");
  });

  it("defines a formatDate() helper", () => {
    expect(SRC).toContain("function formatDate(");
  });

  it("defines a titleCase() helper", () => {
    expect(SRC).toContain("function titleCase(");
  });
});

// ─── Print / Save PDF functionality ──────────────────────────────────────────

describe("admin-therapy-usage-report — print / save PDF", () => {
  it("calls window.print() from the print button", () => {
    expect(SRC).toContain("window.print()");
  });

  it("renders a <style> block with @media print rules", () => {
    expect(SRC).toContain("@media print");
  });

  it("uses visibility:hidden / visibility:visible to isolate the report", () => {
    expect(SRC).toContain("visibility: hidden");
    expect(SRC).toContain("visibility: visible");
  });

  it("defines the therapy-report id on the article element for print isolation", () => {
    expect(SRC).toContain('id="therapy-report"');
  });

  it("hides print controls with data-print-hide during printing", () => {
    expect(SRC).toContain("data-print-hide");
  });
});

// ─── Component tree ───────────────────────────────────────────────────────────

describe("admin-therapy-usage-report — component tree", () => {
  it("defines a ReportSheet component", () => {
    expect(SRC).toContain("function ReportSheet(");
  });

  it("defines a CoverBand component", () => {
    expect(SRC).toContain("function CoverBand(");
  });

  it("defines a HeroStats component", () => {
    expect(SRC).toContain("function HeroStats(");
  });

  it("defines an AdherenceChart component", () => {
    expect(SRC).toContain("function AdherenceChart(");
  });

  it("defines a DetailTable component", () => {
    expect(SRC).toContain("function DetailTable(");
  });

  it("defines a CapabilitiesSection component", () => {
    expect(SRC).toContain("function CapabilitiesSection(");
  });

  it("defines a ReportFooter component", () => {
    expect(SRC).toContain("function ReportFooter(");
  });

  it("defines a Segmented component (grouping/window selector)", () => {
    expect(SRC).toContain("function Segmented(");
  });

  it("defines a ComplianceCell component", () => {
    expect(SRC).toContain("function ComplianceCell(");
  });
});

// ─── Chart constants ──────────────────────────────────────────────────────────

describe("admin-therapy-usage-report — chart top-N constant", () => {
  it("defines CHART_TOP_N limiting the chart to top buckets", () => {
    expect(SRC).toContain("CHART_TOP_N");
  });

  it("sets CHART_TOP_N to 8", () => {
    expect(SRC).toContain("CHART_TOP_N = 8");
  });
});

// ─── Query wiring ─────────────────────────────────────────────────────────────

describe("admin-therapy-usage-report — React Query wiring", () => {
  it("uses queryKey with admin, therapy-usage-report, grouping, and days", () => {
    expect(SRC).toContain('"admin"');
    expect(SRC).toContain('"therapy-usage-report"');
  });

  it("calls fetchTherapyUsageReport in the queryFn", () => {
    // The queryFn must delegate to fetchTherapyUsageReport.
    const queryFnIdx = SRC.indexOf("queryFn:");
    expect(queryFnIdx).toBeGreaterThan(-1);
    const nearbyFetch = SRC.slice(queryFnIdx, queryFnIdx + 120);
    expect(nearbyFetch).toContain("fetchTherapyUsageReport");
  });

  it("uses query.isPending for the loading state", () => {
    expect(SRC).toContain("query.isPending");
  });

  it("uses query.isError for the error state", () => {
    expect(SRC).toContain("query.isError");
  });

  it("calls query.refetch() from the ErrorPanel onRetry handler", () => {
    expect(SRC).toContain("query.refetch()");
  });
});

// ─── CMS compliance metadata ──────────────────────────────────────────────────

describe("admin-therapy-usage-report — CMS compliance metadata", () => {
  it("mentions the CMS ≥4h / ≥70% threshold in the cover band", () => {
    // The cover band explains the adherence basis to providers.
    expect(SRC).toMatch(/CMS.*≥4h|≥4.*hours.*CMS|4.hour.*70|70.*4.hour/i);
  });
});

// ─── CAPABILITIES array ───────────────────────────────────────────────────────

describe("admin-therapy-usage-report — CAPABILITIES array", () => {
  it("defines a CAPABILITIES constant", () => {
    expect(SRC).toContain("CAPABILITIES");
  });

  it("includes a connected therapy data capability", () => {
    expect(SRC).toMatch(/connected therapy|cloud.*data|device.*data/i);
  });

  it("includes all six capability items", () => {
    // The implementation has 6 capability items. We count title appearances.
    const capabilityTitles = [
      "Connected therapy data",
      "Always-on adherence",
      "Documentation",
      "Clinical",
      "resupply",
      "AI-assisted",
    ];
    for (const title of capabilityTitles) {
      expect(SRC.toLowerCase()).toContain(title.toLowerCase());
    }
  });
});
