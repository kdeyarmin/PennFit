// Regression test for the /results page rendering when the
// supporting /api/masks call returns a non-JSON response (e.g. an
// SPA HTML fallback during a deploy). Previously the
// `catalog?.masks.forEach` expression in src/pages/results.tsx
// short-circuited only on null/undefined `catalog`; if `catalog`
// landed as a string the unguarded `.masks.forEach` crashed and
// the patient saw the generic "Something went wrong" error
// boundary instead of an actionable error.
//
// This test walks the entire fitter flow with the camera +
// MediaPipe mocked so the page reaches /results, then asserts the
// ErrorBoundary never trips. The dev server doesn't proxy /api/*
// to the resupply-api process, so /api/masks naturally returns
// the SPA HTML — the same shape a deploy-window transient would
// produce in production, which is exactly the regression we want
// to lock in.

import { test, expect, Page } from "@playwright/test";

async function mockCameraAndMediaPipe(page: Page) {
  await page.addInitScript(() => {
    // Camera stream stub built from a canvas captureStream — a
    // real MediaStream so HTMLMediaElement.srcObject's type check
    // accepts it under headless Chromium.
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#cccccc";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    const realStream = (
      canvas as HTMLCanvasElement & {
        captureStream: (fps?: number) => MediaStream;
      }
    ).captureStream(30);

    // @ts-expect-error — installing a partial stub
    navigator.mediaDevices = navigator.mediaDevices ?? {};
    // @ts-expect-error — installing a partial stub
    navigator.mediaDevices.getUserMedia = () => Promise.resolve(realStream);

    // Canvas streams don't always fire `loadeddata` under headless;
    // override the srcObject setter so the capture page's
    // `setVideoReady(true)` path runs.
    const origSetter = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      "srcObject",
    )?.set;
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
      configurable: true,
      set(value: MediaStream) {
        if (origSetter) origSetter.call(this, value);
        setTimeout(() => {
          try {
            this.dispatchEvent(new Event("loadeddata"));
            if (typeof this.onloadeddata === "function") {
              this.onloadeddata(new Event("loadeddata"));
            }
          } catch {
            /* ignore */
          }
        }, 100);
      },
      get(this: HTMLMediaElement) {
        const g = Object.getOwnPropertyDescriptor(
          HTMLMediaElement.prototype,
          "srcObject",
        )?.get;
        return g ? g.call(this) : null;
      },
    });
  });

  // Intercept the MediaPipe ESM module + the .task model file and
  // serve a tiny replacement that returns deterministic, in-range
  // landmarks. Targets (with pxPerMm ≈ 1.094 from a 12.8 px iris
  // on a 1280×720 frame):
  //   noseWidth ≈ 30 mm   – within [20, 60]
  //   noseHeight ≈ 40 mm  – within [25, 70]
  //   noseToChin ≈ 55 mm  – within [40, 90]
  //   mouthWidth ≈ 45 mm  – within [30, 80]
  //   faceWidth ≈ 140 mm  – within [110, 180]
  await page.route(/(tasks-vision|mediapipe)/, async (route) => {
    const stub = `
      export class FilesetResolver {
        static async forVisionTasks() { return {}; }
      }
      const FAKE_LANDMARKS = new Array(478).fill({ x: 0.5, y: 0.5 });
      FAKE_LANDMARKS[469] = { x: 0.4950, y: 0.50 };
      FAKE_LANDMARKS[471] = { x: 0.5050, y: 0.50 };
      FAKE_LANDMARKS[129] = { x: 0.4875, y: 0.55 };
      FAKE_LANDMARKS[358] = { x: 0.5125, y: 0.55 };
      FAKE_LANDMARKS[6]   = { x: 0.50, y: 0.4595 };
      FAKE_LANDMARKS[4]   = { x: 0.50, y: 0.5205 };
      FAKE_LANDMARKS[152] = { x: 0.50, y: 0.6045 };
      FAKE_LANDMARKS[61]  = { x: 0.48075, y: 0.575 };
      FAKE_LANDMARKS[291] = { x: 0.51925, y: 0.575 };
      FAKE_LANDMARKS[234] = { x: 0.440, y: 0.50 };
      FAKE_LANDMARKS[454] = { x: 0.560, y: 0.50 };
      export class FaceLandmarker {
        static async createFromOptions() { return new FaceLandmarker(); }
        detect() { return { faceLandmarks: [FAKE_LANDMARKS] }; }
        close() {}
      }
    `;
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: stub,
    });
  });
}

test("Results page never trips the ErrorBoundary when /api/masks returns non-JSON", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => {
    pageErrors.push(`${err.name}: ${err.message}`);
  });

  await mockCameraAndMediaPipe(page);

  // Force /api/masks to return non-JSON HTML even when the API is
  // reachable. Reproduces the deploy-window scenario where the
  // Replit proxy serves the SPA shell instead of the resupply-api
  // JSON. The pre-fix code path through results.tsx's catalogById
  // useMemo crashed on `catalog.masks.forEach` because `catalog`
  // was the HTML string. /api/recommend is left alone so the page
  // still has a recommendation request in flight.
  await page.route("**/api/masks", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html><body>not the masks JSON</body></html>",
    });
  });

  // /consent — fill the email + opt-in gate.
  await page.goto("/consent");
  await page.getByLabel(/email/i).first().fill("repro@example.com");
  await page.getByRole("checkbox", { name: /confirm|consent/i }).first().check();
  await page.getByRole("checkbox", { name: /email/i }).first().check();
  await page.getByRole("button", { name: /continue/i }).click();

  // /capture — wait for the camera to warm up, click Take Photo.
  await page.waitForURL(/\/capture/, { timeout: 5_000 });
  await page.getByTestId("button-capture").waitFor({ state: "visible" });
  await page.waitForTimeout(800);
  await page.getByTestId("button-capture").click({ timeout: 10_000 });

  // /measure → /questionnaire — MediaPipe runs, measurements
  // extract, the page auto-advances.
  await page.waitForURL(/\/questionnaire/, { timeout: 15_000 });

  // /questionnaire — click any visible radio option per question
  // until we land on /results. 13 iterations is enough for the
  // 11 current questions plus headroom.
  for (let i = 0; i < 13; i++) {
    const noBtn = page
      .locator('[data-testid$="-no"]')
      .or(page.locator('[data-testid^="button-"][data-testid*="-medium"]'))
      .or(page.locator('[data-testid^="button-"][data-testid*="-none"]'));
    try {
      await noBtn.first().click({ timeout: 1500 });
    } catch {
      await page.locator('[role="radio"]').first().click({ timeout: 1500 });
    }
    await page.waitForTimeout(150);
    if (page.url().includes("/results")) break;
  }

  await page.waitForURL(/\/results/, { timeout: 5_000 });
  await page.waitForTimeout(2_000); // let the queries + render settle

  // The ErrorBoundary fallback must NOT be visible — that's the
  // exact regression. Either real recommendations render (if the
  // API is up) or the in-page "Error Generating Recommendations"
  // alert renders (if it's not). Both are acceptable; the
  // ErrorBoundary is not.
  await expect(
    page.getByTestId("error-boundary-fallback"),
  ).toBeHidden();
  expect(pageErrors).toEqual([]);
});
