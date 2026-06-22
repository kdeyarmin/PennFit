// Capture screenshots for the CareMetric Breathe User Manual.
//
// Drives the cpap-fitter SPA in *demo mode* (the client-only sandbox in
// artifacts/cpap-fitter/src/demo/ that answers every /api and /resupply-api
// call from in-browser fixtures) so the whole storefront AND admin console
// render with no backend, database, Supabase, or auth. Demo mode is forced
// via the `pennfit:demo-mode:v1` localStorage flag (see src/demo/state.ts)
// injected before any page script runs, so it is active on the very first
// paint and survives in-app navigation.
//
// Usage:
//   PORT=5173 BASE_PATH=/ pnpm --filter @workspace/cpap-fitter dev &   # SPA only
//   node docs/user-manual/capture-manual-screens.mjs
//
// Env overrides:
//   E2E_BASE_URL        — dev-server origin (default http://localhost:5173)
//   SCREENSHOT_OUT_DIR  — where PNGs are written
//                         (default docs/user-manual/screenshots)
//
// Pages that demo mode doesn't explicitly fixture fall through to a benign
// empty state, so they still render their real layout/header — useful for
// the manual even without seeded rows. The manual's prose never depends on
// a screenshot to be understood.
// Import the repo's pinned Playwright build directly (the same approach
// render.mjs uses) and launch the matching pre-installed Chromium via an
// explicit executablePath — this environment ships a specific browser
// build under /opt/pw-browsers, and the executablePath override skips
// Playwright's "download the matching browser" check.
import { chromium } from "/home/user/PennFit/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const CHROMIUM_EXECUTABLE =
  process.env.PW_CHROMIUM_EXECUTABLE ??
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const OUT = process.env.SCREENSHOT_OUT_DIR ?? resolve(HERE, "screenshots");
mkdirSync(OUT, { recursive: true });

// name → SPA path. Grouped by where each lands in the manual.
const PAGES = [
  // ── Storefront (patient-facing) — Introduction + overview ──────────
  ["storefront-home", "/"],
  ["storefront-shop", "/shop"],
  ["storefront-how-it-works", "/how-it-works"],

  // ── Administrator (Owner & Admin) ──────────────────────────────────
  ["admin-home", "/admin"],
  ["admin-control-center", "/admin/control-center"],
  ["admin-team", "/admin/team"],
  ["admin-operations", "/admin/operations"],
  ["admin-integrations", "/admin/integrations"],
  ["admin-setup", "/admin/setup"],
  ["admin-reports", "/admin/reports"],

  // ── CSR ────────────────────────────────────────────────────────────
  ["csr-conversations", "/admin/conversations"],
  ["csr-front-desk", "/admin/front-desk"],
  ["csr-patients", "/admin/patients"],
  ["csr-episodes", "/admin/episodes"],
  ["csr-bulk-campaigns", "/admin/bulk-campaigns"],
  ["csr-shop-orders", "/admin/pennpaps/orders"],
  ["csr-company-calendar", "/admin/company-calendar"],

  // ── Documents, intake & e-signature ────────────────────────────────
  ["admin-referral-reviewer", "/admin/referral-reviews"],
  ["admin-signature-tracking", "/admin/signature-tracking"],

  // ── Biller ─────────────────────────────────────────────────────────
  ["biller-billing-hub", "/admin/billing"],
  ["biller-eligibility", "/admin/billing/eligibility"],
  ["biller-aging", "/admin/billing/aging"],
  ["biller-denials-worklist", "/admin/billing/denials-worklist"],
  ["biller-prior-auths", "/admin/billing/prior-auths"],
  ["biller-era", "/admin/billing/era"],
  ["biller-office-ally", "/admin/billing/office-ally"],

  // ── Respiratory Therapist ──────────────────────────────────────────
  ["rt-overview", "/admin/rt-overview"],
  ["rt-therapy-fleet", "/admin/therapy-fleet"],
  ["rt-clinical", "/admin/clinical"],
  ["rt-therapy-compliance", "/admin/therapy-compliance"],
  ["rt-therapy-resupply", "/admin/therapy-resupply"],
];

const browser = await chromium.launch({ executablePath: CHROMIUM_EXECUTABLE });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  reducedMotion: "reduce",
  colorScheme: "light",
});
// Force demo mode before any page script runs.
await ctx.addInitScript(() => {
  try {
    window.localStorage.setItem("pennfit:demo-mode:v1", "1");
  } catch {
    /* storage disabled — ignore */
  }
});

const page = await ctx.newPage();
let ok = 0;
let failed = 0;
for (const [name, path] of PAGES) {
  try {
    await page.goto(`${BASE_URL}${path}`, {
      waitUntil: "networkidle",
      timeout: 45000,
    });
    // Let charts / lazy panels settle.
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(`ok   ${name} (${path})`);
    ok += 1;
  } catch (err) {
    console.log(`FAIL ${name} (${path}): ${String(err).slice(0, 140)}`);
    failed += 1;
  }
}

await browser.close();
console.log(`done — ${ok} captured, ${failed} failed → ${OUT}`);
