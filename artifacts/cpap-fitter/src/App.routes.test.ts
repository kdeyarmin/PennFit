// Tests for App.tsx — new routes added in this PR
//
// This PR registered ten new routes in the PatientRouter:
//   - /cpap-masks          → CpapMasks
//   - /cpap-masks/react-health → CpapMasksReactHealth
//   - /cpap-masks/resmed   → CpapMasksResmed
//   - /cpap-masks/fisher-paykel → CpapMasksFisherPaykel
//   - /learn/sleep-apnea-explained → LearnSleepApneaExplained
//   - /learn/health-risks  → LearnHealthRisks
//   - /learn/pap-therapy-benefits → LearnPapTherapyBenefits
//   - /learn/how-pap-works → LearnHowPapWorks
//   - /learn/therapy-types → LearnTherapyTypes
//   - /learn/sleep-apnea-heart-health → LearnSleepApneaHeartHealth
//
// We also verify the lazy() import declarations for each new module,
// and that the component names match the named exports from those files.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "App.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape every regex metacharacter so user-supplied strings can be
 * embedded literally inside a `new RegExp(...)` pattern. The previous
 * implementation only escaped `/` (which isn't a regex metachar in
 * `new RegExp`), leaving characters like `.`, `?`, `+`, `*`, `(`, `)`,
 * `[`, `]`, `{`, `}`, `^`, `$`, `|`, and `\` un-escaped. CodeQL
 * (js/incomplete-sanitization) flagged this as incomplete escaping. */
function escapeRegExp(input: string): string {
  return input.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

/** True when the source contains a Route element with path and component. */
function hasRoute(src: string, routePath: string, component: string): boolean {
  // Matches both single-line and multi-line Route declarations.
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
// New brand-page routes
// ---------------------------------------------------------------------------

describe("App.tsx — /cpap-masks routes registered", () => {
  it("registers <Route path='/cpap-masks' component={CpapMasks} />", () => {
    expect(hasRoute(SRC, "/cpap-masks", "CpapMasks")).toBe(true);
  });

  it("registers <Route path='/cpap-masks/react-health' component={CpapMasksReactHealth} />", () => {
    expect(hasRoute(SRC, "/cpap-masks/react-health", "CpapMasksReactHealth")).toBe(true);
  });

  it("registers <Route path='/cpap-masks/resmed' component={CpapMasksResmed} />", () => {
    expect(hasRoute(SRC, "/cpap-masks/resmed", "CpapMasksResmed")).toBe(true);
  });

  it("registers <Route path='/cpap-masks/fisher-paykel' component={CpapMasksFisherPaykel} />", () => {
    expect(hasRoute(SRC, "/cpap-masks/fisher-paykel", "CpapMasksFisherPaykel")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// New educational article routes
// ---------------------------------------------------------------------------

describe("App.tsx — /learn/* article routes registered", () => {
  it("registers <Route path='/learn/sleep-apnea-explained' component={LearnSleepApneaExplained} />", () => {
    expect(
      hasRoute(SRC, "/learn/sleep-apnea-explained", "LearnSleepApneaExplained"),
    ).toBe(true);
  });

  it("registers <Route path='/learn/health-risks' component={LearnHealthRisks} />", () => {
    expect(hasRoute(SRC, "/learn/health-risks", "LearnHealthRisks")).toBe(true);
  });

  it("registers <Route path='/learn/pap-therapy-benefits' component={LearnPapTherapyBenefits} />", () => {
    expect(
      hasRoute(SRC, "/learn/pap-therapy-benefits", "LearnPapTherapyBenefits"),
    ).toBe(true);
  });

  it("registers <Route path='/learn/how-pap-works' component={LearnHowPapWorks} />", () => {
    expect(hasRoute(SRC, "/learn/how-pap-works", "LearnHowPapWorks")).toBe(true);
  });

  it("registers <Route path='/learn/therapy-types' component={LearnTherapyTypes} />", () => {
    expect(hasRoute(SRC, "/learn/therapy-types", "LearnTherapyTypes")).toBe(true);
  });

  it("registers <Route path='/learn/sleep-apnea-heart-health' component={LearnSleepApneaHeartHealth} />", () => {
    expect(
      hasRoute(SRC, "/learn/sleep-apnea-heart-health", "LearnSleepApneaHeartHealth"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lazy import declarations — brand pages
// ---------------------------------------------------------------------------

describe("App.tsx — lazy() imports for brand pages", () => {
  it("lazy-imports CpapMasks from @/pages/cpap-masks", () => {
    expect(hasLazyImport(SRC, "cpap-masks", "CpapMasks")).toBe(true);
  });

  it("lazy-imports CpapMasksReactHealth from @/pages/cpap-masks-react-health", () => {
    expect(
      hasLazyImport(SRC, "cpap-masks-react-health", "CpapMasksReactHealth"),
    ).toBe(true);
  });

  it("lazy-imports CpapMasksResmed from @/pages/cpap-masks-resmed", () => {
    expect(hasLazyImport(SRC, "cpap-masks-resmed", "CpapMasksResmed")).toBe(true);
  });

  it("lazy-imports CpapMasksFisherPaykel from @/pages/cpap-masks-fisher-paykel", () => {
    expect(
      hasLazyImport(SRC, "cpap-masks-fisher-paykel", "CpapMasksFisherPaykel"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lazy import declarations — educational article pages
// ---------------------------------------------------------------------------

describe("App.tsx — lazy() imports for educational article pages", () => {
  it("lazy-imports LearnSleepApneaExplained from @/pages/learn-sleep-apnea-explained", () => {
    expect(
      hasLazyImport(
        SRC,
        "learn-sleep-apnea-explained",
        "LearnSleepApneaExplained",
      ),
    ).toBe(true);
  });

  it("lazy-imports LearnHealthRisks from @/pages/learn-health-risks", () => {
    expect(hasLazyImport(SRC, "learn-health-risks", "LearnHealthRisks")).toBe(
      true,
    );
  });

  it("lazy-imports LearnPapTherapyBenefits from @/pages/learn-pap-therapy-benefits", () => {
    expect(
      hasLazyImport(SRC, "learn-pap-therapy-benefits", "LearnPapTherapyBenefits"),
    ).toBe(true);
  });

  it("lazy-imports LearnHowPapWorks from @/pages/learn-how-pap-works", () => {
    expect(hasLazyImport(SRC, "learn-how-pap-works", "LearnHowPapWorks")).toBe(
      true,
    );
  });

  it("lazy-imports LearnTherapyTypes from @/pages/learn-therapy-types", () => {
    expect(hasLazyImport(SRC, "learn-therapy-types", "LearnTherapyTypes")).toBe(
      true,
    );
  });

  it("lazy-imports LearnSleepApneaHeartHealth from @/pages/learn-sleep-apnea-heart-health", () => {
    expect(
      hasLazyImport(
        SRC,
        "learn-sleep-apnea-heart-health",
        "LearnSleepApneaHeartHealth",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Comment presence — the explanatory comment block is part of the contract
// ---------------------------------------------------------------------------

describe("App.tsx — explanatory comments are present", () => {
  it("has a comment explaining that educational pages are lazy-loaded", () => {
    expect(SRC).toContain("Educational long-form articles");
    expect(SRC).toContain("Lazy-loaded");
  });

  it("has a comment explaining that brand pages are lazy-loaded SEO landing surfaces", () => {
    expect(SRC).toContain("Brand marketing pages");
    expect(SRC).toContain("SEO landing surfaces");
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
});

// ---------------------------------------------------------------------------
// Wildcard routing: :rest* replaced with * (regexparam 3.x fix)
// ---------------------------------------------------------------------------

describe("App.tsx — wildcard routes use * not :rest*", () => {
  it("uses /sign-in/* (not /sign-in/:rest*)", () => {
    expect(SRC).toContain('path="/sign-in/*"');
    expect(SRC).not.toContain('path="/sign-in/:rest*"');
  });

  it("uses /sign-up/* (not /sign-up/:rest*)", () => {
    expect(SRC).toContain('path="/sign-up/*"');
    expect(SRC).not.toContain('path="/sign-up/:rest*"');
  });

  it("uses /admin/* (not /admin/:rest*)", () => {
    expect(SRC).toContain('path="/admin/*"');
    expect(SRC).not.toContain('path="/admin/:rest*"');
  });

  it("uses /resupply/* (not /resupply/:rest*)", () => {
    expect(SRC).toContain('path="/resupply/*"');
    expect(SRC).not.toContain('path="/resupply/:rest*"');
  });

  it("LegacyResupplyRedirect reads params['*'] not params['rest*']", () => {
    expect(SRC).toContain('params["*"]');
    expect(SRC).not.toContain('params["rest*"]');
  });
});

// ---------------------------------------------------------------------------
// Removed routes/components: /admin/change-password
// ---------------------------------------------------------------------------

describe("App.tsx — /admin/change-password route and component removed", () => {
  it("does not register a route for /admin/change-password", () => {
    expect(SRC).not.toContain('path="/admin/change-password"');
  });

  it("does not lazy-import AdminChangePasswordPage", () => {
    expect(SRC).not.toContain("AdminChangePasswordPage");
  });

  it("does not import from @/pages/admin/change-password", () => {
    expect(SRC).not.toContain("admin/change-password");
  });
});