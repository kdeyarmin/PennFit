// Static guard for the five billing routes registered in console.tsx.
//
// console.tsx wires up the admin router — adding or removing routes
// here changes what URLs the SPA responds to. This guard catches any
// silent regression where a route import or <Route> declaration is
// accidentally removed.
//
// Following the pattern of AppShell.nav.test.ts: we read the source
// directly rather than rendering the router, which keeps the test fast
// and dependency-free in the vitest node environment.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_SRC = readFileSync(path.join(__dirname, "console.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Import declarations
// ---------------------------------------------------------------------------
describe("console.tsx — billing page imports", () => {
  it("imports AdminBillingHubPage from admin-billing-hub", () => {
    expect(CONSOLE_SRC).toContain(
      'import { AdminBillingHubPage } from "@/pages/admin/admin-billing-hub"',
    );
  });

  it("imports AdminBillingAiQueuePage from admin-billing-ai-queue", () => {
    expect(CONSOLE_SRC).toContain(
      'import { AdminBillingAiQueuePage } from "@/pages/admin/admin-billing-ai-queue"',
    );
  });

  it("imports AdminBillingAgingPage from admin-billing-aging", () => {
    expect(CONSOLE_SRC).toContain(
      'import { AdminBillingAgingPage } from "@/pages/admin/admin-billing-aging"',
    );
  });

  it("imports AdminBillingDenialsPage from admin-billing-denials", () => {
    expect(CONSOLE_SRC).toContain(
      'import { AdminBillingDenialsPage } from "@/pages/admin/admin-billing-denials"',
    );
  });

  it("imports AdminBillingEraPage from admin-billing-era", () => {
    expect(CONSOLE_SRC).toContain(
      'import { AdminBillingEraPage } from "@/pages/admin/admin-billing-era"',
    );
  });
});

// ---------------------------------------------------------------------------
// Route declarations — path + component
// ---------------------------------------------------------------------------
describe("console.tsx — billing route declarations", () => {
  const billingRoutes: ReadonlyArray<[string, string]> = [
    ["/admin/billing", "AdminBillingHubPage"],
    ["/admin/billing/ai-queue", "AdminBillingAiQueuePage"],
    ["/admin/billing/aging", "AdminBillingAgingPage"],
    ["/admin/billing/denials", "AdminBillingDenialsPage"],
    ["/admin/billing/era", "AdminBillingEraPage"],
  ];

  for (const [routePath, component] of billingRoutes) {
    it(`registers route "${routePath}" wired to ${component}`, () => {
      expect(CONSOLE_SRC).toContain(`path="${routePath}"`);
      expect(CONSOLE_SRC).toContain(`component={${component}}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Regression: pre-existing routes are undisturbed
// ---------------------------------------------------------------------------
describe("console.tsx — pre-existing routes not removed by this PR", () => {
  const expectedRoutes = [
    "/admin/patients",
    "/admin",
    "/admin/dashboard",
  ];

  for (const route of expectedRoutes) {
    it(`retains the ${route} route`, () => {
      expect(CONSOLE_SRC).toContain(`path="${route}"`);
    });
  }
});
