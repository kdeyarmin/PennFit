// Tests for the per-page React.lazy() refactor in console.tsx.
//
// PR change (admin perf): all ~70 admin pages were converted from
// eager static imports to per-page lazy() chunks so that a staff user
// who only opens 3 pages downloads 3 chunks instead of the full 70+.
//
// This file guards the structural invariants of that refactor:
//   1. DashboardPage stays eager (it's the /admin default — a Suspense
//      flash there is the FIRST thing a staff user sees).
//   2. All other pages are wrapped in lazy().
//   3. The Suspense boundary with the correct fallback spinner is present.
//   4. ErrorBoundary still wraps the Suspense (error paths unchanged).
//   5. Pennpaps pages use the renamed source exports.
//   6. lazy() + import().then({ default: m.X }) pattern — not bare dynamic
//      imports — so the .then() re-export avoids Vite's name-mangling.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "console.tsx"), "utf8");

// ---------------------------------------------------------------------------
// React imports: Suspense and lazy must be imported
// ---------------------------------------------------------------------------

describe("console.tsx — Suspense + lazy React imports", () => {
  it("imports Suspense from react", () => {
    expect(SRC).toMatch(/import\s*\{[^}]*\bSuspense\b[^}]*\}\s*from\s*["']react["']/);
  });

  it("imports lazy from react", () => {
    expect(SRC).toMatch(/import\s*\{[^}]*\blazy\b[^}]*\}\s*from\s*["']react["']/);
  });
});

// ---------------------------------------------------------------------------
// DashboardPage — must remain as an eager static import
// ---------------------------------------------------------------------------

describe("console.tsx — DashboardPage stays eager", () => {
  it("imports DashboardPage with a static import (not lazy)", () => {
    expect(SRC).toContain(
      'import { DashboardPage } from "@/pages/admin/dashboard"',
    );
  });

  it("does NOT wrap DashboardPage in lazy()", () => {
    // The lazy() declarations all follow the pattern `const X = lazy(…)`
    // DashboardPage must never appear on the right-hand side of such a
    // declaration.
    expect(SRC).not.toMatch(/const\s+DashboardPage\s*=\s*lazy\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// Per-page lazy() wrapping — representative sample
// ---------------------------------------------------------------------------
//
// Exhaustively asserting all 65+ pages would make this file brittle.
// We verify a representative cross-section: patient-facing heavy pages,
// billing pages (added in the same PR), and one shop page.

describe("console.tsx — core admin pages are lazy-loaded", () => {
  const lazyPages: ReadonlyArray<[string, string]> = [
    ["PatientsPage", "@/pages/admin/patients"],
    ["PatientDetailPage", "@/pages/admin/patient-detail"],
    ["ConversationsPage", "@/pages/admin/conversations"],
    ["ConversationDetailPage", "@/pages/admin/conversation-detail"],
    ["EpisodesPage", "@/pages/admin/episodes"],
    ["RulesPage", "@/pages/admin/rules"],
    ["AdminTodayPage", "@/pages/admin/admin-today"],
    ["AdminProvidersPage", "@/pages/admin/admin-providers"],
    ["AdminAnalyticsPage", "@/pages/admin/admin-analytics"],
    ["AdminSecurityPage", "@/pages/admin/admin-security"],
    ["AdminSettingsPage", "@/pages/admin/admin-settings"],
    ["AdminNpsPage", "@/pages/admin/admin-nps"],
  ];

  for (const [symbolName, modulePath] of lazyPages) {
    it(`${symbolName} is declared as a lazy() component`, () => {
      // Must appear as `const X = lazy(…)`
      expect(SRC).toMatch(new RegExp(`const\\s+${symbolName}\\s*=\\s*lazy\\s*\\(`));
      // The factory must import from the expected module path
      expect(SRC).toContain(`import("${modulePath}")`);
      // The .then() factory must set `default: m.<symbolName>` to re-export
      // the named export as the default (required for lazy() to work)
      expect(SRC).toContain(`default: m.${symbolName}`);
    });
  }
});

describe("console.tsx — billing pages are lazy-loaded", () => {
  const billingLazyPages: ReadonlyArray<[string, string]> = [
    ["AdminBillingHubPage", "@/pages/admin/admin-billing-hub"],
    ["AdminBillingAiQueuePage", "@/pages/admin/admin-billing-ai-queue"],
    ["AdminBillingAgingPage", "@/pages/admin/admin-billing-aging"],
    ["AdminBillingDenialsPage", "@/pages/admin/admin-billing-denials"],
    ["AdminBillingEraPage", "@/pages/admin/admin-billing-era"],
    ["AdminBillingEligibilityPage", "@/pages/admin/admin-billing-eligibility"],
    ["AdminBillingPriorAuthsPage", "@/pages/admin/admin-billing-prior-auths"],
    ["AdminBillingConfigHubPage", "@/pages/admin/admin-billing-config"],
    ["AdminBillingConfigPayersPage", "@/pages/admin/admin-billing-config-payers"],
    ["AdminBillingCappedRentalsPage", "@/pages/admin/admin-billing-capped-rentals"],
    ["AdminBillingOfficeAllyPage", "@/pages/admin/admin-billing-office-ally"],
  ];

  for (const [symbolName, modulePath] of billingLazyPages) {
    it(`${symbolName} is declared as a lazy() component`, () => {
      expect(SRC).toMatch(new RegExp(`const\\s+${symbolName}\\s*=\\s*lazy\\s*\\(`));
      expect(SRC).toContain(`import("${modulePath}")`);
      expect(SRC).toContain(`default: m.${symbolName}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Pennpaps pages — renamed-export pattern
// ---------------------------------------------------------------------------
//
// The source modules export `AdminOrders`, `AdminOrderDetail`, etc. but
// console.tsx binds them to Pennpaps-prefixed locals. The .then() factory
// must map the *source* symbol name to `default`, not the local alias.

describe("console.tsx — Pennpaps pages use renamed source exports", () => {
  it("PennpapsOrdersPage factory maps m.AdminOrders → default", () => {
    expect(SRC).toMatch(
      /const\s+PennpapsOrdersPage\s*=\s*lazy\s*\(/,
    );
    expect(SRC).toContain('import("@/pages/admin/pennpaps-orders")');
    expect(SRC).toContain("default: m.AdminOrders");
  });

  it("PennpapsOrderDetailPage factory maps m.AdminOrderDetail → default", () => {
    expect(SRC).toMatch(
      /const\s+PennpapsOrderDetailPage\s*=\s*lazy\s*\(/,
    );
    expect(SRC).toContain('import("@/pages/admin/pennpaps-order-detail")');
    expect(SRC).toContain("default: m.AdminOrderDetail");
  });

  it("PennpapsRemindersPage factory maps m.AdminReminders → default", () => {
    expect(SRC).toMatch(
      /const\s+PennpapsRemindersPage\s*=\s*lazy\s*\(/,
    );
    expect(SRC).toContain('import("@/pages/admin/pennpaps-reminders")');
    expect(SRC).toContain("default: m.AdminReminders");
  });

  it("PennpapsAnalyticsPage factory maps m.AdminAnalytics → default", () => {
    expect(SRC).toMatch(
      /const\s+PennpapsAnalyticsPage\s*=\s*lazy\s*\(/,
    );
    expect(SRC).toContain('import("@/pages/admin/pennpaps-analytics")');
    expect(SRC).toContain("default: m.AdminAnalytics");
  });

  // Regression: the old eager pattern was `AdminOrders as PennpapsOrdersPage`
  // — that form must not appear in the refactored file.
  it("no longer uses the old 'as'-alias import pattern for Pennpaps pages", () => {
    expect(SRC).not.toContain("AdminOrders as PennpapsOrdersPage");
    expect(SRC).not.toContain("AdminOrderDetail as PennpapsOrderDetailPage");
    expect(SRC).not.toContain("AdminReminders as PennpapsRemindersPage");
    expect(SRC).not.toContain("AdminAnalytics as PennpapsAnalyticsPage");
  });
});

// ---------------------------------------------------------------------------
// Suspense boundary
// ---------------------------------------------------------------------------

describe("console.tsx — Suspense boundary wrapping the Switch", () => {
  it("wraps the Switch in a Suspense element", () => {
    expect(SRC).toContain("<Suspense");
    expect(SRC).toContain("</Suspense>");
  });

  it('uses a Spinner with label "Loading page…" as the Suspense fallback', () => {
    expect(SRC).toContain('fallback={<Spinner label="Loading page…" />}');
  });

  it("Switch is inside Suspense (Suspense precedes Switch in source order)", () => {
    const suspenseIdx = SRC.indexOf("<Suspense");
    const switchIdx = SRC.indexOf("<Switch>");
    expect(suspenseIdx).toBeGreaterThan(0);
    expect(switchIdx).toBeGreaterThan(suspenseIdx);
  });

  it("Suspense closes after Switch closes", () => {
    const switchCloseIdx = SRC.indexOf("</Switch>");
    const suspenseCloseIdx = SRC.indexOf("</Suspense>");
    expect(switchCloseIdx).toBeGreaterThan(0);
    expect(suspenseCloseIdx).toBeGreaterThan(switchCloseIdx);
  });
});

// ---------------------------------------------------------------------------
// ErrorBoundary still wraps the Suspense
// ---------------------------------------------------------------------------

describe("console.tsx — ErrorBoundary wraps the Suspense", () => {
  it("ErrorBoundary is present in the JSX", () => {
    expect(SRC).toContain("<ErrorBoundary>");
    expect(SRC).toContain("</ErrorBoundary>");
  });

  it("ErrorBoundary opens before the Suspense (ErrorBoundary is the outer wrapper)", () => {
    const errorBoundaryIdx = SRC.indexOf("<ErrorBoundary>");
    const suspenseIdx = SRC.indexOf("<Suspense");
    expect(errorBoundaryIdx).toBeGreaterThan(0);
    expect(suspenseIdx).toBeGreaterThan(errorBoundaryIdx);
  });

  it("ErrorBoundary closes after Suspense closes", () => {
    const suspenseCloseIdx = SRC.indexOf("</Suspense>");
    const errorBoundaryCloseIdx = SRC.indexOf("</ErrorBoundary>");
    expect(suspenseCloseIdx).toBeGreaterThan(0);
    expect(errorBoundaryCloseIdx).toBeGreaterThan(suspenseCloseIdx);
  });
});

// ---------------------------------------------------------------------------
// No remaining eager imports for lazified pages
// ---------------------------------------------------------------------------
//
// Regression guard: none of the pages that were converted to lazy()
// should still appear as a static named import.

describe("console.tsx — no remaining eager imports for lazified pages", () => {
  const lazilyConverted = [
    "PatientsPage",
    "PatientDetailPage",
    "ConversationsPage",
    "AdminBulkCampaignsPage",
    "AdminBillingHubPage",
    "AdminNpsPage",
    "AdminShopInventoryPage",
    "AdminInsuranceClaimsPage",
  ];

  for (const symbol of lazilyConverted) {
    it(`${symbol} is not eagerly imported with a static import statement`, () => {
      // A static import would look like: import { X } from "…"
      expect(SRC).not.toMatch(
        new RegExp(`import\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}`),
      );
    });
  }
});