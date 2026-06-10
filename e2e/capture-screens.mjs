// Capture storefront screenshots for the feature-guide PDF.
//
// Usage:
//   PORT=5173 BASE_PATH=/ pnpm --filter @workspace/cpap-fitter dev &
//   node e2e/capture-screens.mjs
//
// Env overrides:
//   E2E_BASE_URL — dev-server origin (default http://localhost:5173,
//                  matching e2e/playwright.config.ts)
//   SCREENSHOT_OUT_DIR — where PNGs are written (default /tmp/shots)
//
// The first four entries are named to match the files the PDF generator
// consumes from docs/feature-guide/screenshots/ (home, mask-fitter,
// reminders, privacy) — downscale those four to 2000px wide and copy
// them over (see docs/feature-guide/README.md). The rest are extra
// candidates for future use.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const OUT = process.env.SCREENSHOT_OUT_DIR ?? "/tmp/shots";
mkdirSync(OUT, { recursive: true });

const PAGES = [
  // Canonical feature-guide assets (names match the generator's inputs).
  ["home", "/"],
  ["mask-fitter", "/how-it-works"],
  ["reminders", "/reminders"],
  ["privacy", "/measure"],
  // Extra candidates.
  ["fitter-landing", "/cpap-masks"],
  ["capture", "/capture"],
  ["shop", "/shop"],
  ["learn", "/learn"],
  ["insurance", "/insurance/estimate"],
  ["track-order", "/track-order"],
];

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  reducedMotion: "reduce",
  colorScheme: "light",
});
const page = await ctx.newPage();

for (const [name, path] of PAGES) {
  try {
    await page.goto(`${BASE_URL}${path}`, {
      waitUntil: "networkidle",
      timeout: 30000,
    });
    await page.waitForTimeout(1800);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(`ok ${name} (${path})`);
  } catch (err) {
    console.log(`FAIL ${name}: ${String(err).slice(0, 120)}`);
  }
}

await browser.close();
console.log("done");
