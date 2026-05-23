// Tests for App.tsx — new routes added in this PR
//
// This PR registered four new routes in the PatientRouter:
//   - /stories                          → Stories
//   - /learn/reading-your-sleep-report  → LearnReadingYourSleepReport
//   - /learn/sleep-hygiene              → LearnSleepHygiene
//   - /learn/cpap-and-weight-loss       → LearnCpapAndWeightLoss
//
// It also:
//   - Removed AdminChangePasswordPage lazy import and /admin/change-password route
//   - Changed wildcard route patterns from /* to /:rest* for sign-in, sign-up,
//     admin, and resupply routes
//   - Updated /resupply/:rest* param access from params["*"] to params["rest*"]
//
// Tests use static source analysis (same pattern as admin.scope.test.ts and
// AppShell.nav.test.ts) because the node vitest environment has no DOM.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "App.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape regex metacharacters in user-supplied strings. */
function escapeRegExp(input: string): string {
  return input.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

/** True when the source contains a Route element with path and component. */
function hasRoute(src: string, routePath: string, component: string): boolean {
  const re = new RegExp(
    `path="${escapeRegExp(routePath)}"[\\s\\S]{0,120}component=\\{${escapeRegExp(component)}\\}`,
  );
  return re.test(src);
}

/** True when the source contains a lazy() declaration importing the given module. */
function hasLazyImport(src: string, modulePath: string, exportName: string): boolean {
  return (
    src.includes(`import("@/pages/${modulePath}")`) &&
    src.includes(`m.${exportName}`)
  );
}

// ---------------------------------------------------------------------------
// New routes added in this PR
// ---------------------------------------------------------------------------

describe("App.tsx — /stories route registered", () => {
  it("registers <Route path='/stories' component={Stories} />", () => {
    expect(hasRoute(SRC, "/stories", "Stories")).toBe(true);
  });

  it("lazy-imports Stories from @/pages/stories", () => {
    expect(hasLazyImport(SRC, "stories", "Stories")).toBe(true);
  });

  it("lazy import uses 'm.Stories' named export", () => {
    expect(SRC).toContain("m.Stories");
  });
});

describe("App.tsx — /learn/reading-your-sleep-report route registered", () => {
  it("registers <Route path='/learn/reading-your-sleep-report' />", () => {
    expect(hasRoute(SRC, "/learn/reading-your-sleep-report", "LearnReadingYourSleepReport")).toBe(true);
  });

  it("lazy-imports LearnReadingYourSleepReport from @/pages/learn-reading-your-sleep-report", () => {
    expect(hasLazyImport(SRC, "learn-reading-your-sleep-report", "LearnReadingYourSleepReport")).toBe(true);
  });
});

describe("App.tsx — /learn/sleep-hygiene route registered", () => {
  it("registers <Route path='/learn/sleep-hygiene' component={LearnSleepHygiene} />", () => {
    expect(hasRoute(SRC, "/learn/sleep-hygiene", "LearnSleepHygiene")).toBe(true);
  });

  it("lazy-imports LearnSleepHygiene from @/pages/learn-sleep-hygiene", () => {
    expect(hasLazyImport(SRC, "learn-sleep-hygiene", "LearnSleepHygiene")).toBe(true);
  });
});

describe("App.tsx — /learn/cpap-and-weight-loss route registered", () => {
  it("registers <Route path='/learn/cpap-and-weight-loss' component={LearnCpapAndWeightLoss} />", () => {
    expect(hasRoute(SRC, "/learn/cpap-and-weight-loss", "LearnCpapAndWeightLoss")).toBe(true);
  });

  it("lazy-imports LearnCpapAndWeightLoss from @/pages/learn-cpap-and-weight-loss", () => {
    expect(hasLazyImport(SRC, "learn-cpap-and-weight-loss", "LearnCpapAndWeightLoss")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// New-route comment block
// ---------------------------------------------------------------------------

describe("App.tsx — explanatory comment block for new additions", () => {
  it("has a comment explaining the patient stories and learn additions", () => {
    expect(SRC).toContain("patient stories landing");
  });

  it("comment mentions the three new learn pages", () => {
    expect(SRC).toContain("sleep-report explainer");
    expect(SRC).toContain("sleep");
    expect(SRC).toContain("weight-loss");
  });
});

// ---------------------------------------------------------------------------
// AdminChangePasswordPage removed
// ---------------------------------------------------------------------------

describe("App.tsx — AdminChangePasswordPage removed", () => {
  it("no longer has a lazy import for AdminChangePasswordPage", () => {
    expect(SRC).not.toContain("AdminChangePasswordPage");
  });

  it("no longer has an /admin/change-password route", () => {
    expect(SRC).not.toContain('path="/admin/change-password"');
  });

  it("no longer imports from @/pages/admin/change-password", () => {
    expect(SRC).not.toContain("admin/change-password");
  });
});

// ---------------------------------------------------------------------------
// Route wildcard patterns updated: /* → /:rest*
// ---------------------------------------------------------------------------

describe("App.tsx — wildcard route patterns updated to /:rest*", () => {
  it("uses /sign-in/:rest* (not /sign-in/*) for multi-step auth flows", () => {
    expect(SRC).toContain('path="/sign-in/:rest*"');
    expect(SRC).not.toContain('path="/sign-in/*"');
  });

  it("uses /sign-up/:rest* (not /sign-up/*)", () => {
    expect(SRC).toContain('path="/sign-up/:rest*"');
    expect(SRC).not.toContain('path="/sign-up/*"');
  });

  it("uses /admin/:rest* (not /admin/*) for the catch-all admin route", () => {
    expect(SRC).toContain('path="/admin/:rest*"');
    expect(SRC).not.toContain('path="/admin/*"');
  });

  it("uses /resupply/:rest* (not /resupply/*) for the legacy resupply redirect", () => {
    expect(SRC).toContain('path="/resupply/:rest*"');
    expect(SRC).not.toContain('path="/resupply/*"');
  });
});

// ---------------------------------------------------------------------------
// /resupply/:rest* param access updated
// ---------------------------------------------------------------------------

describe("App.tsx — legacy resupply redirect param access", () => {
  it("accesses params[\"rest*\"] (not params[\"*\"]) for the resupply wildcard", () => {
    expect(SRC).toContain('params["rest*"]');
  });

  it("no longer uses params[\"*\"] for resupply wildcard extraction", () => {
    // The old code used params["*"] which is invalid in regexparam 3.x
    expect(SRC).not.toContain('params["*"]');
  });
});

// ---------------------------------------------------------------------------
// Regression: pre-existing routes must still be present
// ---------------------------------------------------------------------------

describe("App.tsx — pre-existing routes not regressed", () => {
  it("still registers /learn route", () => {
    expect(SRC).toContain('path="/learn"');
  });

  it("still registers /masks route", () => {
    expect(SRC).toContain('path="/masks"');
  });

  it("still registers /consent route", () => {
    expect(SRC).toContain('path="/consent"');
  });

  it("still registers /learn/sleep-apnea-quiz route", () => {
    expect(SRC).toContain('path="/learn/sleep-apnea-quiz"');
  });

  it("still registers /learn/device-setup route", () => {
    expect(SRC).toContain('path="/learn/device-setup"');
  });

  it("still registers /cpap-masks route", () => {
    expect(SRC).toContain('path="/cpap-masks"');
  });

  it("still registers /admin route", () => {
    expect(SRC).toContain('path="/admin"');
  });

  it("still registers /admin/verify-email route", () => {
    expect(SRC).toContain('path="/admin/verify-email"');
  });

  it("still registers /admin/sign-in route", () => {
    expect(SRC).toContain('path="/admin/sign-in"');
  });

  it("still registers /learn/nasal-congestion route", () => {
    expect(SRC).toContain('path="/learn/nasal-congestion"');
  });
});

// ---------------------------------------------------------------------------
// Structural: comment update for route comment
// ---------------------------------------------------------------------------

describe("App.tsx — route comment updated for regexparam 3.x", () => {
  it("uses ':rest*' syntax in the TopRouter comment", () => {
    expect(SRC).toContain("`/sign-in/:rest*`");
  });

  it("no longer references the old 'rest*' literal-name workaround comment", () => {
    // Old comment: "(regexparam 3.x parses `:rest*` as a single-segment param
    // literally named `rest*`, not as a wildcard — use `*`.)"
    // This confusing note was removed when we switched to :rest*
    expect(SRC).not.toContain("literally named `rest*`");
  });
});