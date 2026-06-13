// Static guard for admin-billing-hub.tsx — the Billing Hub page.
//
// The component uses React + @tanstack/react-query which cannot be
// rendered in the vitest node environment without jsdom. We read the
// source directly and assert structural invariants that matter most:
// the data-testid, KPI tiles, deep-link hrefs, and correct imports.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "admin-billing-hub.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Imports from billing-api
// ---------------------------------------------------------------------------
describe("admin-billing-hub — billing-api imports", () => {
  it("imports fetchDirectorSummary from billing-api", () => {
    expect(SRC).toContain("fetchDirectorSummary");
  });

  it("imports fetchBillingDashboard from billing-api", () => {
    expect(SRC).toContain("fetchBillingDashboard");
  });

  it("imports createClaimFromFulfillment from billing-api", () => {
    expect(SRC).toContain("createClaimFromFulfillment");
  });

  it("imports formatMoneyCents from billing-api", () => {
    expect(SRC).toContain("formatMoneyCents");
  });

  it("imports formatPercent from billing-api", () => {
    expect(SRC).toContain("formatPercent");
  });

  it("imports DirectorSummaryResponse type from billing-api", () => {
    expect(SRC).toContain("DirectorSummaryResponse");
  });
});

// ---------------------------------------------------------------------------
// Root element data-testid
// ---------------------------------------------------------------------------
describe("admin-billing-hub — root data-testid", () => {
  it('renders with data-testid="admin-billing-hub"', () => {
    expect(SRC).toContain('data-testid="admin-billing-hub"');
  });
});

// ---------------------------------------------------------------------------
// KPI tiles — labels and deep-link hrefs
// ---------------------------------------------------------------------------
describe("admin-billing-hub — KPI tile labels", () => {
  const kpiLabels = [
    "Stale drafts",
    "Fresh denials",
    "Submitted, no 999",
    "Auto-resubmit ready",
    "Partial ERAs",
    "Ready to bill",
    "Patient $ open",
  ];

  for (const label of kpiLabels) {
    it(`includes KPI tile labeled "${label}"`, () => {
      expect(SRC).toContain(label);
    });
  }
});

describe("admin-billing-hub — KPI tile data-testid attributes", () => {
  it("uses a dynamic billing-kpi-{label} data-testid pattern", () => {
    // The source contains the template literal:
    // `billing-kpi-${k.label.replace(/\s+/g, "-").toLowerCase()}`
    expect(SRC).toContain("billing-kpi-");
    expect(SRC).toContain("k.label.replace(");
  });

  it("generates KPI testIds from labels lowercased with hyphens", () => {
    expect(SRC).toContain("toLowerCase()");
  });
});

describe("admin-billing-hub — KPI deep-link hrefs", () => {
  const kpiHrefs = [
    "/admin/billing/ai-queue",
    "/admin/billing/aging",
    "/admin/billing/era",
  ];

  for (const href of kpiHrefs) {
    it(`links a KPI tile to "${href}"`, () => {
      expect(SRC).toContain(`href: "${href}"`);
    });
  }
});

// ---------------------------------------------------------------------------
// Section titles and subtitles
// ---------------------------------------------------------------------------
describe("admin-billing-hub — section card titles", () => {
  const sectionTitles = [
    "AI work queue",
    "Money in flight",
    "Denial rate trend",
    "Top payers by open patient $",
    "Operational health",
    "Quick links",
    "Fulfillments ready to bill",
    "Billing Hub",
  ];

  for (const title of sectionTitles) {
    it(`includes section titled "${title}"`, () => {
      expect(SRC).toContain(title);
    });
  }
});

// ---------------------------------------------------------------------------
// Denial-rate trend window labels (WINDOW_LABEL map)
// ---------------------------------------------------------------------------
describe("admin-billing-hub — denial-rate trend window labels", () => {
  it("maps d0_30 to 'Last 30 days'", () => {
    expect(SRC).toContain("Last 30 days");
  });

  it("maps d30_60 to '30 – 60 days'", () => {
    expect(SRC).toContain("30 – 60 days");
  });

  it("maps d60_90 to '60 – 90 days'", () => {
    expect(SRC).toContain("60 – 90 days");
  });
});

// ---------------------------------------------------------------------------
// Quick-link deep-links
// ---------------------------------------------------------------------------
describe("admin-billing-hub — quick links", () => {
  const quickLinks = [
    ["/admin/billing/aging", "A/R aging by payer"],
    ["/admin/billing/denials", "Denial rate by payer"],
    ["/admin/billing/era", "ERA file upload & history"],
    ["/admin/billing/ai-queue", "AI billing queue"],
  ];

  for (const [href, label] of quickLinks) {
    it(`includes quick link to "${href}" labeled "${label}"`, () => {
      expect(SRC).toContain(
        `href="/admin/billing/${href.split("/admin/billing/")[1]}"`,
      );
      expect(SRC).toContain(label);
    });
  }
});

// ---------------------------------------------------------------------------
// Operational health fields
// ---------------------------------------------------------------------------
describe("admin-billing-hub — operational health fields", () => {
  it("displays webhooksQueued count", () => {
    expect(SRC).toContain("webhooksQueued");
  });

  it("displays webhooksExhausted24h count", () => {
    expect(SRC).toContain("webhooksExhausted24h");
  });

  it("displays generatedAt timestamp", () => {
    expect(SRC).toContain("generatedAt");
  });
});

// ---------------------------------------------------------------------------
// QueueRow helper for AI work queue section
// ---------------------------------------------------------------------------
describe("admin-billing-hub — AI queue row entries", () => {
  it("includes 'Scrubber blocked' row", () => {
    expect(SRC).toContain("Scrubber blocked");
  });

  it("includes 'Scrubber fixable' row", () => {
    expect(SRC).toContain("Scrubber fixable");
  });

  it("includes 'Denials awaiting analysis' row", () => {
    expect(SRC).toContain("Denials awaiting analysis");
  });

  it("includes 'Auto-resubmit ready' row", () => {
    expect(SRC).toContain("Auto-resubmit ready");
  });
});

// ---------------------------------------------------------------------------
// Money-in-flight labels
// ---------------------------------------------------------------------------
describe("admin-billing-hub — money-in-flight labels", () => {
  it("includes 'Submitted, no 999 ack' row", () => {
    expect(SRC).toContain("Submitted, no 999 ack");
  });

  it("includes 'Denied — last 14 days' row", () => {
    expect(SRC).toContain("Denied — last 14 days");
  });

  it("includes 'Patient responsibility — open' row", () => {
    expect(SRC).toContain("Patient responsibility — open");
  });
});

// ---------------------------------------------------------------------------
// Query key used to cache the director summary
// ---------------------------------------------------------------------------
describe("admin-billing-hub — react-query cache key", () => {
  it("uses 'admin-billing-director-summary' as the queryKey", () => {
    expect(SRC).toContain('"admin-billing-director-summary"');
  });

  it("uses 'admin-billing-dashboard' as the dashboard queryKey", () => {
    expect(SRC).toContain('"admin-billing-dashboard"');
  });
});

describe("admin-billing-hub - ready-to-bill actions", () => {
  it("renders the create-claim action", () => {
    expect(SRC).toContain("Create claim");
  });

  it("links created claims back to the patient claim workbench", () => {
    expect(SRC).toContain("Open claim workbench");
    expect(SRC).toContain("/insurance-claims");
  });
});

// ---------------------------------------------------------------------------
// Lucide icon imports
// ---------------------------------------------------------------------------
describe("admin-billing-hub — lucide-react icon imports", () => {
  const icons = [
    "AlertTriangle",
    "Bot",
    "ClipboardCheck",
    "ClipboardList",
    "DollarSign",
    "ListFilter",
    "Send",
    "Sparkles",
    "TrendingDown",
    "Wallet",
  ];

  for (const icon of icons) {
    it(`imports ${icon} from lucide-react`, () => {
      expect(SRC).toContain(icon);
    });
  }
});
