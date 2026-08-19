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

// ── The /results fit diagram ────────────────────────────────────────────
// Not in PAGES above because it can't be reached by URL alone: the fitter
// is invitation-only, and /results renders from a fitter store that only a
// completed capture+measure fills in. So we mint an invite, seed the store
// with synthetic measurements, and screenshot the diagram element itself.
//
// REQUIRES THE FULL BACKEND, not the Vite dev server — the diagram is drawn
// from the mask catalog's real size bands, so /api/* must reach a migrated
// database. Stand the stack up the way ci.yml's backend-backed e2e job does
// (Postgres + scripts/ci/start-test-postgrest.sh + the built API co-serving
// the SPA), then point E2E_BASE_URL at it.
//
// Set FIT_INVITE_TOKEN to a token minted with RESUPPLY_LINK_HMAC_KEY over
// `fi|<fitter_invites.id>|<expiry-unix-seconds>` (see
// artifacts/resupply-api/src/lib/fitter-invite-token.ts). Skipped when unset.
//
// The measurements below are synthetic and deliberately mid-range so the
// fitting lands on a normal recommendation rather than an edge case. No
// real patient data is ever used to produce a marketing asset.
const FIT_INVITE_TOKEN = process.env.FIT_INVITE_TOKEN ?? "";
if (!FIT_INVITE_TOKEN) {
  console.log("skip results-diagram (FIT_INVITE_TOKEN unset)");
} else {
  const MEASUREMENTS = {
    noseWidth: 34.2,
    noseHeight: 46.8,
    noseToChin: 62.4,
    mouthWidth: 48.1,
    faceWidthAtCheekbones: 139.5,
    calibrationMethod: "iris",
  };
  const SCAN = {
    frameCount: 3,
    quality: {
      lighting: 0.88,
      distance: 0.91,
      pose: 0.93,
      occlusion: 0.96,
      motion: 0.9,
      framing: 0.92,
    },
    agreement: {
      noseWidth: 0.94,
      noseHeight: 0.91,
      noseToChin: 0.9,
      mouthWidth: 0.92,
      faceWidthAtCheekbones: 0.93,
    },
    measurementConfidence: 0.9,
    band: "high",
  };
  const ANSWERS = {
    mouthBreather: false,
    claustrophobic: false,
    sideOrStomachSleeper: true,
    heavyFacialHair: false,
    wearsGlasses: true,
    frequentCongestion: false,
    priorMaskExperience: "none",
    mobilityLimitations: false,
    sensitiveSkin: false,
    siliconeSensitivity: false,
    cpapPressureSetting: "unknown",
  };

  // deviceScaleFactor 3: the diagram is a small element, and the asset is
  // shown near-full-width on /breathe/mask-fitting.
  const fitCtx = await browser.newContext({
    viewport: { width: 900, height: 1000 },
    deviceScaleFactor: 3,
    reducedMotion: "reduce",
    colorScheme: "light",
  });
  const fitPage = await fitCtx.newPage();
  await fitPage.addInitScript(
    ([m, sc, a, t]) => {
      sessionStorage.setItem("fitter_measurements", JSON.stringify(m));
      sessionStorage.setItem("fitter_scan_signals", JSON.stringify(sc));
      sessionStorage.setItem("fitter_answers", JSON.stringify(a));
      sessionStorage.setItem("fitter_email", "demo@example.com");
      sessionStorage.setItem("fitter_email_consent", "0");
      sessionStorage.setItem("fitter_invite_token", t);
    },
    [MEASUREMENTS, SCAN, ANSWERS, FIT_INVITE_TOKEN],
  );

  try {
    await fitPage.goto(
      `${BASE_URL}/fitter-invite?t=${encodeURIComponent(FIT_INVITE_TOKEN)}`,
      { waitUntil: "networkidle", timeout: 45000 },
    );
    await fitPage.goto(`${BASE_URL}/results`, {
      waitUntil: "networkidle",
      timeout: 45000,
    });
    await fitPage.waitForTimeout(4000);
    const diagram = fitPage
      .locator('[data-testid="fit-range-diagram"]')
      .first();
    await diagram.waitFor({ state: "visible", timeout: 15000 });
    await diagram.screenshot({ path: `${OUT}/fitter-range-diagram.png` });
    console.log("ok results-diagram (/results → fit-range-diagram)");
  } catch (err) {
    console.log(`FAIL results-diagram: ${String(err).slice(0, 200)}`);
  }
  await fitCtx.close();
}

await browser.close();
console.log("done");
