// Static guard for admin-billing-ai-queue.tsx — the AI billing work queue.
//
// We read the source directly (no rendering) following the project's
// established pattern for React pages that cannot be rendered in the
// vitest node environment.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-billing-ai-queue.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Imports from billing-api
// ---------------------------------------------------------------------------
describe("admin-billing-ai-queue — billing-api imports", () => {
  it("imports fetchAiQueue", () => {
    expect(SRC).toContain("fetchAiQueue");
  });

  it("imports formatMoneyCents", () => {
    expect(SRC).toContain("formatMoneyCents");
  });

  it("imports formatPercent", () => {
    expect(SRC).toContain("formatPercent");
  });

  it("imports AutoResubmitReadyItem type", () => {
    expect(SRC).toContain("AutoResubmitReadyItem");
  });

  it("imports ClaimQueueItem type", () => {
    expect(SRC).toContain("ClaimQueueItem");
  });
});

// ---------------------------------------------------------------------------
// Root data-testid
// ---------------------------------------------------------------------------
describe("admin-billing-ai-queue — root data-testid", () => {
  it('renders with data-testid="admin-billing-ai-queue"', () => {
    expect(SRC).toContain('data-testid="admin-billing-ai-queue"');
  });
});

// ---------------------------------------------------------------------------
// Page heading
// ---------------------------------------------------------------------------
describe("admin-billing-ai-queue — page heading", () => {
  it('renders "AI billing queue" as the h1 text', () => {
    expect(SRC).toContain("AI billing queue");
  });
});

// ---------------------------------------------------------------------------
// Four claim sections with titles and data sources
// ---------------------------------------------------------------------------
describe("admin-billing-ai-queue — four claim sections", () => {
  it("renders 'Scrubber blocked' section", () => {
    expect(SRC).toContain("Scrubber blocked");
  });

  it("renders 'Scrubber fixable' section", () => {
    expect(SRC).toContain("Scrubber fixable");
  });

  it("renders 'Denials awaiting analysis' section", () => {
    expect(SRC).toContain("Denials awaiting analysis");
  });

  it("renders 'Auto-resubmit ready' section", () => {
    expect(SRC).toContain("Auto-resubmit ready");
  });
});

// ---------------------------------------------------------------------------
// Data sources from AiQueueResponse
// ---------------------------------------------------------------------------
describe("admin-billing-ai-queue — AiQueueResponse data bindings", () => {
  it("uses scrubBlockingClaims from the response", () => {
    expect(SRC).toContain("scrubBlockingClaims");
  });

  it("uses scrubFixableClaims from the response", () => {
    expect(SRC).toContain("scrubFixableClaims");
  });

  it("uses deniedNeedsAnalysis from the response", () => {
    expect(SRC).toContain("deniedNeedsAnalysis");
  });

  it("uses autoResubmitReady from the response", () => {
    expect(SRC).toContain("autoResubmitReady");
  });
});

// ---------------------------------------------------------------------------
// Per-row deep-link to patient claim workbench
// ---------------------------------------------------------------------------
describe("admin-billing-ai-queue — patient claim deep-link", () => {
  it("links claim rows to /admin/patients/:patientId/insurance-claims", () => {
    expect(SRC).toContain(
      "/admin/patients/${c.patientId}/insurance-claims",
    );
  });

  it("links auto-resubmit rows to /admin/billing/claims/:claimId", () => {
    expect(SRC).toContain("/admin/billing/claims/${a.claimId}");
  });
});

// ---------------------------------------------------------------------------
// Confidence display (two-decimal precision formatting)
// ---------------------------------------------------------------------------
describe("admin-billing-ai-queue — confidence display", () => {
  it("renders confidence via formatPercent", () => {
    expect(SRC).toContain("formatPercent(a.confidence");
  });

  it("displays the 'conf' label prefix before the confidence value", () => {
    expect(SRC).toContain("conf ");
  });
});

// ---------------------------------------------------------------------------
// Empty-state messages per section
// ---------------------------------------------------------------------------
describe("admin-billing-ai-queue — empty state messages", () => {
  it("shows 'Nothing blocked right now. Nice.' for empty blocked list", () => {
    expect(SRC).toContain("Nothing blocked right now. Nice.");
  });

  it("shows 'No outstanding fixable scrubs.' for empty fixable list", () => {
    expect(SRC).toContain("No outstanding fixable scrubs.");
  });

  it("shows 'No fresh denials waiting.' for empty needs-analysis list", () => {
    expect(SRC).toContain("No fresh denials waiting.");
  });

  it("shows 'No claims queued for auto-resubmit.' for empty resubmit list", () => {
    expect(SRC).toContain("No claims queued for auto-resubmit.");
  });
});

// ---------------------------------------------------------------------------
// ClaimSection and AutoResubmitSection helper components
// ---------------------------------------------------------------------------
describe("admin-billing-ai-queue — helper components", () => {
  it("defines ClaimSection component", () => {
    expect(SRC).toContain("function ClaimSection");
  });

  it("defines AutoResubmitSection component", () => {
    expect(SRC).toContain("function AutoResubmitSection");
  });
});

// ---------------------------------------------------------------------------
// Lucide icon imports
// ---------------------------------------------------------------------------
describe("admin-billing-ai-queue — lucide-react icon imports", () => {
  const icons = ["AlertTriangle", "Bot", "ClipboardList", "Sparkles"];

  for (const icon of icons) {
    it(`imports ${icon} from lucide-react`, () => {
      expect(SRC).toContain(icon);
    });
  }
});

// ---------------------------------------------------------------------------
// React-query cache key
// ---------------------------------------------------------------------------
describe("admin-billing-ai-queue — react-query cache key", () => {
  it("uses 'admin-billing-ai-queue' as the queryKey", () => {
    expect(SRC).toContain('"admin-billing-ai-queue"');
  });

  it("uses a 30-second staleTime", () => {
    expect(SRC).toContain("staleTime: 30_000");
  });
});

// ---------------------------------------------------------------------------
// Count display in section action slot
// ---------------------------------------------------------------------------
describe("admin-billing-ai-queue — count display per section", () => {
  it("displays items.length count for ClaimSection", () => {
    expect(SRC).toContain("items.length");
  });
});