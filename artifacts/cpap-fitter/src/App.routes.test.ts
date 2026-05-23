// Tests for App.tsx — routes and lazy imports after this PR's cleanup
//
// This PR removed a large number of routes and lazy-loaded components:
//   REMOVED patient routes:
//   - /cpap-masks, /cpap-masks/react-health, /cpap-masks/resmed, /cpap-masks/fisher-paykel
//   - /learn/sleep-apnea-explained, /learn/health-risks, /learn/pap-therapy-benefits
//   - /learn/how-pap-works, /learn/therapy-types, /learn/sleep-apnea-heart-health
//   - /learn/first-two-weeks, /learn/traveling-with-cpap, /learn/cleaning-routine
//   - /learn/myths-debunked, /learn/glossary, /learn/insurance-guide
//   - /sleep-apnea-101
//   - /learn/sleep-apnea-women, /learn/sleep-apnea-diabetes, /learn/sleep-apnea-mental-health
//   - /learn/pediatric-sleep-apnea, /learn/sleep-apnea-seniors
//   - /learn/partner-guide, /learn/talking-to-a-loved-one
//   - /learn/dry-mouth, /learn/cpap-bloating, /learn/mask-leaks
//   - /learn/cpap-claustrophobia, /learn/nasal-congestion
//   - /account/billing
//   - /admin/change-password
//
//   REMOVED lazy imports:
//   - AccountBillingPage, AdminChangePasswordPage
//   - All Learn* educational article components
//   - CpapMasks, CpapMasksReactHealth, CpapMasksResmed, CpapMasksFisherPaykel
//   - SleepApnea101
//
//   REMOVED component functions:
//   - GuardedAccountBilling

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "App.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegExp(input: string): string {
  return input.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

function hasRoute(src: string, routePath: string): boolean {
  return src.includes(`path="${routePath}"`);
}

function hasLazyImport(src: string, modulePath: string): boolean {
  return src.includes(`import("@/pages/${modulePath}")`);
}

// ---------------------------------------------------------------------------
// Removed brand-page routes must NOT be present
// ---------------------------------------------------------------------------

describe("App.tsx — removed /cpap-masks routes are absent", () => {
  it("does not register /cpap-masks route", () => {
    expect(hasRoute(SRC, "/cpap-masks")).toBe(false);
  });

  it("does not register /cpap-masks/react-health route", () => {
    expect(hasRoute(SRC, "/cpap-masks/react-health")).toBe(false);
  });

  it("does not register /cpap-masks/resmed route", () => {
    expect(hasRoute(SRC, "/cpap-masks/resmed")).toBe(false);
  });

  it("does not register /cpap-masks/fisher-paykel route", () => {
    expect(hasRoute(SRC, "/cpap-masks/fisher-paykel")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Removed educational article routes must NOT be present
// ---------------------------------------------------------------------------

describe("App.tsx — removed /learn/* article routes are absent", () => {
  it("does not register /learn/sleep-apnea-explained route", () => {
    expect(hasRoute(SRC, "/learn/sleep-apnea-explained")).toBe(false);
  });

  it("does not register /learn/health-risks route", () => {
    expect(hasRoute(SRC, "/learn/health-risks")).toBe(false);
  });

  it("does not register /learn/pap-therapy-benefits route", () => {
    expect(hasRoute(SRC, "/learn/pap-therapy-benefits")).toBe(false);
  });

  it("does not register /learn/how-pap-works route", () => {
    expect(hasRoute(SRC, "/learn/how-pap-works")).toBe(false);
  });

  it("does not register /learn/therapy-types route", () => {
    expect(hasRoute(SRC, "/learn/therapy-types")).toBe(false);
  });

  it("does not register /learn/sleep-apnea-heart-health route", () => {
    expect(hasRoute(SRC, "/learn/sleep-apnea-heart-health")).toBe(false);
  });

  it("does not register /learn/first-two-weeks route", () => {
    expect(hasRoute(SRC, "/learn/first-two-weeks")).toBe(false);
  });

  it("does not register /learn/traveling-with-cpap route", () => {
    expect(hasRoute(SRC, "/learn/traveling-with-cpap")).toBe(false);
  });

  it("does not register /learn/cleaning-routine route", () => {
    expect(hasRoute(SRC, "/learn/cleaning-routine")).toBe(false);
  });

  it("does not register /learn/myths-debunked route", () => {
    expect(hasRoute(SRC, "/learn/myths-debunked")).toBe(false);
  });

  it("does not register /learn/glossary route", () => {
    expect(hasRoute(SRC, "/learn/glossary")).toBe(false);
  });

  it("does not register /learn/insurance-guide route", () => {
    expect(hasRoute(SRC, "/learn/insurance-guide")).toBe(false);
  });

  it("does not register /sleep-apnea-101 route", () => {
    expect(hasRoute(SRC, "/sleep-apnea-101")).toBe(false);
  });

  it("does not register /learn/sleep-apnea-women route", () => {
    expect(hasRoute(SRC, "/learn/sleep-apnea-women")).toBe(false);
  });

  it("does not register /learn/sleep-apnea-diabetes route", () => {
    expect(hasRoute(SRC, "/learn/sleep-apnea-diabetes")).toBe(false);
  });

  it("does not register /learn/sleep-apnea-mental-health route", () => {
    expect(hasRoute(SRC, "/learn/sleep-apnea-mental-health")).toBe(false);
  });

  it("does not register /learn/pediatric-sleep-apnea route", () => {
    expect(hasRoute(SRC, "/learn/pediatric-sleep-apnea")).toBe(false);
  });

  it("does not register /learn/sleep-apnea-seniors route", () => {
    expect(hasRoute(SRC, "/learn/sleep-apnea-seniors")).toBe(false);
  });

  it("does not register /learn/partner-guide route", () => {
    expect(hasRoute(SRC, "/learn/partner-guide")).toBe(false);
  });

  it("does not register /learn/talking-to-a-loved-one route", () => {
    expect(hasRoute(SRC, "/learn/talking-to-a-loved-one")).toBe(false);
  });

  it("does not register /learn/dry-mouth route", () => {
    expect(hasRoute(SRC, "/learn/dry-mouth")).toBe(false);
  });

  it("does not register /learn/cpap-bloating route", () => {
    expect(hasRoute(SRC, "/learn/cpap-bloating")).toBe(false);
  });

  it("does not register /learn/mask-leaks route", () => {
    expect(hasRoute(SRC, "/learn/mask-leaks")).toBe(false);
  });

  it("does not register /learn/cpap-claustrophobia route", () => {
    expect(hasRoute(SRC, "/learn/cpap-claustrophobia")).toBe(false);
  });

  it("does not register /learn/nasal-congestion route", () => {
    expect(hasRoute(SRC, "/learn/nasal-congestion")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Removed account and admin routes must NOT be present
// ---------------------------------------------------------------------------

describe("App.tsx — removed /account/billing and /admin/change-password routes are absent", () => {
  it("does not register /account/billing route", () => {
    expect(hasRoute(SRC, "/account/billing")).toBe(false);
  });

  it("does not register /admin/change-password route", () => {
    expect(hasRoute(SRC, "/admin/change-password")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Removed lazy imports must NOT be present
// ---------------------------------------------------------------------------

describe("App.tsx — removed lazy imports are absent", () => {
  it("does not lazy-import account-billing page", () => {
    expect(hasLazyImport(SRC, "account-billing")).toBe(false);
  });

  it("does not lazy-import admin/change-password page", () => {
    expect(hasLazyImport(SRC, "admin/change-password")).toBe(false);
  });

  it("does not lazy-import cpap-masks page", () => {
    expect(hasLazyImport(SRC, "cpap-masks")).toBe(false);
  });

  it("does not lazy-import cpap-masks-react-health page", () => {
    expect(hasLazyImport(SRC, "cpap-masks-react-health")).toBe(false);
  });

  it("does not lazy-import cpap-masks-resmed page", () => {
    expect(hasLazyImport(SRC, "cpap-masks-resmed")).toBe(false);
  });

  it("does not lazy-import cpap-masks-fisher-paykel page", () => {
    expect(hasLazyImport(SRC, "cpap-masks-fisher-paykel")).toBe(false);
  });

  it("does not lazy-import learn-sleep-apnea-explained page", () => {
    expect(hasLazyImport(SRC, "learn-sleep-apnea-explained")).toBe(false);
  });

  it("does not lazy-import learn-health-risks page", () => {
    expect(hasLazyImport(SRC, "learn-health-risks")).toBe(false);
  });

  it("does not lazy-import learn-pap-therapy-benefits page", () => {
    expect(hasLazyImport(SRC, "learn-pap-therapy-benefits")).toBe(false);
  });

  it("does not lazy-import learn-how-pap-works page", () => {
    expect(hasLazyImport(SRC, "learn-how-pap-works")).toBe(false);
  });

  it("does not lazy-import learn-therapy-types page", () => {
    expect(hasLazyImport(SRC, "learn-therapy-types")).toBe(false);
  });

  it("does not lazy-import learn-sleep-apnea-heart-health page", () => {
    expect(hasLazyImport(SRC, "learn-sleep-apnea-heart-health")).toBe(false);
  });

  it("does not lazy-import sleep-apnea-101 page", () => {
    expect(hasLazyImport(SRC, "sleep-apnea-101")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Removed guard function must NOT be present
// ---------------------------------------------------------------------------

describe("App.tsx — removed GuardedAccountBilling component is absent", () => {
  it("does not define GuardedAccountBilling function", () => {
    expect(SRC).not.toContain("GuardedAccountBilling");
  });

  it("does not reference AccountBillingPage", () => {
    expect(SRC).not.toContain("AccountBillingPage");
  });

  it("does not reference AdminChangePasswordPage", () => {
    expect(SRC).not.toContain("AdminChangePasswordPage");
  });
});

// ---------------------------------------------------------------------------
// Surviving routes must still be present (regression guard)
// ---------------------------------------------------------------------------

describe("App.tsx — surviving patient routes are still present", () => {
  it("still registers / (home) route", () => {
    expect(hasRoute(SRC, "/")).toBe(true);
  });

  it("still registers /consent route", () => {
    expect(hasRoute(SRC, "/consent")).toBe(true);
  });

  it("still registers /capture route", () => {
    expect(hasRoute(SRC, "/capture")).toBe(true);
  });

  it("still registers /masks route", () => {
    expect(hasRoute(SRC, "/masks")).toBe(true);
  });

  it("still registers /how-it-works route", () => {
    expect(hasRoute(SRC, "/how-it-works")).toBe(true);
  });

  it("still registers /faq route", () => {
    expect(hasRoute(SRC, "/faq")).toBe(true);
  });

  it("still registers /learn route", () => {
    expect(hasRoute(SRC, "/learn")).toBe(true);
  });

  it("still registers /learn/replacement-schedule route", () => {
    expect(hasRoute(SRC, "/learn/replacement-schedule")).toBe(true);
  });

  it("still registers /learn/device-setup route", () => {
    expect(hasRoute(SRC, "/learn/device-setup")).toBe(true);
  });

  it("still registers /learn/sleep-apnea-quiz route", () => {
    expect(hasRoute(SRC, "/learn/sleep-apnea-quiz")).toBe(true);
  });

  it("still registers /comfort-guarantee route", () => {
    expect(hasRoute(SRC, "/comfort-guarantee")).toBe(true);
  });

  it("still registers /insurance route", () => {
    expect(hasRoute(SRC, "/insurance")).toBe(true);
  });

  it("still registers /insurance/estimate route", () => {
    expect(hasRoute(SRC, "/insurance/estimate")).toBe(true);
  });

  it("still registers /account route", () => {
    expect(hasRoute(SRC, "/account")).toBe(true);
  });

  it("still registers /shop route", () => {
    expect(hasRoute(SRC, "/shop")).toBe(true);
  });

  it("still registers /shop/cart route", () => {
    expect(hasRoute(SRC, "/shop/cart")).toBe(true);
  });

  it("still registers /shop/checkout-success route", () => {
    expect(hasRoute(SRC, "/shop/checkout-success")).toBe(true);
  });

  it("still registers /shop/orders route", () => {
    expect(hasRoute(SRC, "/shop/orders")).toBe(true);
  });

  it("still registers /privacy route", () => {
    expect(hasRoute(SRC, "/privacy")).toBe(true);
  });

  it("still registers /terms route", () => {
    expect(hasRoute(SRC, "/terms")).toBe(true);
  });
});

describe("App.tsx — surviving admin routes are still present", () => {
  it("still registers /admin/sign-in route", () => {
    expect(hasRoute(SRC, "/admin/sign-in")).toBe(true);
  });

  it("still registers /admin/forgot-password route", () => {
    expect(hasRoute(SRC, "/admin/forgot-password")).toBe(true);
  });

  it("still registers /admin/reset-password route", () => {
    expect(hasRoute(SRC, "/admin/reset-password")).toBe(true);
  });

  it("still registers /admin/verify-email route", () => {
    expect(hasRoute(SRC, "/admin/verify-email")).toBe(true);
  });

  it("still registers /admin console route", () => {
    expect(hasRoute(SRC, "/admin")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Surviving lazy imports must still be present
// ---------------------------------------------------------------------------

describe("App.tsx — surviving lazy imports are still present", () => {
  it("still lazy-imports consent page", () => {
    expect(hasLazyImport(SRC, "consent")).toBe(true);
  });

  it("still lazy-imports account page", () => {
    expect(hasLazyImport(SRC, "account")).toBe(true);
  });

  it("still lazy-imports shop-cart page", () => {
    expect(hasLazyImport(SRC, "shop-cart")).toBe(true);
  });

  it("still lazy-imports device-setup page", () => {
    expect(hasLazyImport(SRC, "device-setup")).toBe(true);
  });

  it("still lazy-imports replacement-schedule page", () => {
    expect(hasLazyImport(SRC, "replacement-schedule")).toBe(true);
  });

  it("still lazy-imports admin/console page", () => {
    expect(hasLazyImport(SRC, "admin/console")).toBe(true);
  });

  it("still lazy-imports admin/sign-in page", () => {
    expect(hasLazyImport(SRC, "admin/sign-in")).toBe(true);
  });

  it("still lazy-imports returns page", () => {
    expect(hasLazyImport(SRC, "returns")).toBe(true);
  });
});
