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
// Sub-tree wildcards — regression for the `:rest*` named-splat bug.
//
// Wouter's matcher is regexparam, which does NOT support path-to-regexp's
// `:name*` named-splat syntax: `/admin/:rest*` compiles to a pattern that
// only matches a SINGLE segment after `/admin/`, so multi-segment URLs
// like `/admin/pennpaps/analytics` fall through to the next route (the
// patient catch-all → patient 404). The fix is the bare `*` wildcard.
// These assertions guard against re-introducing the broken form.
// ---------------------------------------------------------------------------

describe("App.tsx — sub-tree wildcards compile to deep matches", () => {
  it("never uses the broken `:rest*` named-splat syntax in a Route path", () => {
    expect(SRC).not.toMatch(/path="\/[^"]*:rest\*[^"]*"/);
  });

  it("uses /sign-in/* (not /sign-in/:rest*)", () => {
    expect(SRC).toContain('path="/sign-in/*"');
  });

  it("uses /sign-up/* (not /sign-up/:rest*)", () => {
    expect(SRC).toContain('path="/sign-up/*"');
  });

  it("uses /resupply/* (not /resupply/:rest*)", () => {
    expect(SRC).toContain('path="/resupply/*"');
  });

  it("uses /admin/* (not /admin/:rest*) for the gated console", () => {
    expect(SRC).toContain('path="/admin/*"');
  });

  it("the /admin/* regexparam compilation matches every admin route registered in console.tsx", () => {
    // Wouter compiles `/admin/*` via regexparam into the regex
    // /^\/admin\/(.*)\/?$/i  (case-insensitive by regexparam default).
    // The bug we're guarding against: `/admin/:rest*` instead compiled
    // to /^\/admin\/([^/]+?)\/?$/i — a SINGLE-segment match — so
    // multi-segment URLs like `/admin/pennpaps/analytics` fell through
    // to the next route. This test reads the live console.tsx, extracts
    // every `path="/admin/..."` registered there, and asserts that the
    // correct compiled regex matches all of them while the broken one
    // would miss every multi-segment URL. If console.tsx grows new
    // admin routes, they're picked up automatically.
    const consoleTsx = readFileSync(
      path.join(__dirname, "pages/admin/console.tsx"),
      "utf8",
    );
    const adminUrls = Array.from(
      consoleTsx.matchAll(/path="(\/admin\/[^"]+)"/g),
      (m) => m[1]!.replace(/:[A-Za-z_][A-Za-z_0-9]*/g, "sample"),
    );
    expect(adminUrls.length).toBeGreaterThan(20); // sanity floor

    // Mirrors `regexparam.parse('/admin/*').pattern` exactly — case-
    // insensitive because that's regexparam's default. We don't import
    // regexparam here (it isn't a direct dep of cpap-fitter), but the
    // shape is small and stable. If regexparam ever changes its output,
    // the "uses /admin/* …" assertion above still pins the on-disk
    // route, and the wouter version pin in package.json holds the
    // matcher steady; this test would then need a one-line update.
    const wouterAdminWildcard = /^\/admin\/(.*)\/?$/i;
    for (const url of adminUrls) {
      expect(
        wouterAdminWildcard.test(url),
        `wouter's /admin/* should match ${url}`,
      ).toBe(true);
    }

    // The broken `/admin/:rest*` (single-segment match) would miss
    // every multi-segment URL — documents WHY the fix was needed.
    const brokenNamedSplat = /^\/admin\/([^/]+?)\/?$/i;
    const multiSegmentUrls = adminUrls.filter(
      (u) => u.split("/").length > 3,
    );
    expect(multiSegmentUrls.length).toBeGreaterThan(0); // sanity
    for (const url of multiSegmentUrls) {
      expect(
        brokenNamedSplat.test(url),
        `broken pattern should NOT match ${url}`,
      ).toBe(false);
    }
  });
});