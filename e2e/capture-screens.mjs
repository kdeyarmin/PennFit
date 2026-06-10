// Capture storefront screenshots for the feature-guide PDF.
// Usage: node e2e/capture-screens.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const OUT = "/tmp/shots";
mkdirSync(OUT, { recursive: true });

const PAGES = [
  ["home", "/"],
  ["fitter", "/cpap-masks"],
  ["measure", "/measure"],
  ["capture", "/capture"],
  ["shop", "/shop"],
  ["reminders", "/reminders"],
  ["learn", "/learn"],
  ["how-it-works", "/how-it-works"],
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
    await page.goto(`http://localhost:5173${path}`, {
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
