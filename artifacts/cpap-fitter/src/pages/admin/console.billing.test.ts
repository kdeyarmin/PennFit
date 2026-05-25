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
//
// Admin pages were lazy-loaded per-route in the perf-scale pass so
// each one is its own chunk. The static guard now matches the
// dynamic-import shape:
//
//   import("@/pages/admin/admin-billing-hub").then((m) => ({
//     default: m.AdminBillingHubPage,
//   }))
//
// instead of the original eager `import { X } from "@/pages/admin/Y"`.
// The regex below tolerates either shape so a future refactor that
// flips a page back to eager doesn't break the guard, and so this
// test can also catch typos in the page-source-path or symbol name.

function expectPageWired(symbolName: string, modulePath: string): void {
  // Eager import shape, kept here to cover any page that's deliberately
  // not lazy-loaded (DashboardPage today; possibly others later).
  const eagerPattern = new RegExp(
    `import \\{ ${symbolName} \\} from "${modulePath}"`,
  );
  // Lazy factory shape:
  //   import("…/admin-billing-hub").then((m) => ({ default: m.X }))
  const lazyPattern = new RegExp(
    `import\\("${modulePath}"\\)[\\s\\S]{0,100}default: m\\.${symbolName}`,
  );
  expect(
    eagerPattern.test(CONSOLE_SRC) || lazyPattern.test(CONSOLE_SRC),
  ).toBe(true);
}

describe("console.tsx — billing page imports", () => {
  it("wires AdminBillingHubPage from admin-billing-hub", () => {
    expectPageWired("AdminBillingHubPage", "@/pages/admin/admin-billing-hub");
  });

  it("wires AdminBillingAiQueuePage from admin-billing-ai-queue", () => {
    expectPageWired(
      "AdminBillingAiQueuePage",
      "@/pages/admin/admin-billing-ai-queue",
    );
  });

  it("wires AdminBillingAgingPage from admin-billing-aging", () => {
    expectPageWired(
      "AdminBillingAgingPage",
      "@/pages/admin/admin-billing-aging",
    );
  });

  it("wires AdminBillingDenialsPage from admin-billing-denials", () => {
    expectPageWired(
      "AdminBillingDenialsPage",
      "@/pages/admin/admin-billing-denials",
    );
  });

  it("wires AdminBillingEraPage from admin-billing-era", () => {
    expectPageWired("AdminBillingEraPage", "@/pages/admin/admin-billing-era");
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
