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
//
// HARNESS REQUIREMENT: this spec must run against the Vite **dev**
// server (the documented `pnpm --filter @workspace/cpap-fitter dev`
// + `pnpm test:e2e` flow). It stubs MediaPipe by intercepting the
// `@mediapipe/tasks-vision` ES module *request* — which only exists
// as a separate network fetch when modules are served unbundled
// (dev). In a `vite preview` / production build the module is
// bundled into the app chunk, so the stub can't replace it, the
// real WASM-backed FaceLandmarker runs against the stubbed model
// bytes, and /measure never advances. To avoid a confusing 15s
// timeout in that harness, the test detects the bundled case (the
// module request never fires) and skips with an explanatory note
// instead of failing. CI runs the other two specs (a11y, smoke)
// against `vite preview`; this one is a dev-server regression test.

import { test, expect, Page } from "@playwright/test";

/** Shared flag: did the MediaPipe ES *module* request get intercepted?
 * (Distinct from the wasm/model files, which are fetched over the
 * network even in a bundled build.) When false after reaching the
 * capture step, the build is bundled and the stub can't take effect. */
type InterceptState = { moduleIntercepted: boolean };

async function mockCameraAndMediaPipe(page: Page, state: InterceptState) {
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
    // `setVideoReady(true)` path runs. Capture BOTH original accessors
    // BEFORE the override — the getter used to re-read the descriptor
    // after defineProperty, which resolved to itself and blew the
    // stack the first time page code READ video.srcObject (the capture
    // page's attach-stream identity guard does exactly that).
    const origDesc = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      "srcObject",
    );
    const origSetter = origDesc?.set;
    const origGetter = origDesc?.get;
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
        return origGetter ? origGetter.call(this) : null;
      },
    });
  });

  // Intercept the MediaPipe ESM module + the .task model file and
  // serve a tiny replacement that returns deterministic landmarks.
  //
  // These are the CANONICAL FACE — MediaPipe's own metric reference mesh
  // — back-projected so `extractMeasurementValues` recovers its true
  // spans (with pxPerMm ≈ 1.094 from a 12.8 px iris on a 1280×720
  // frame):
  //   noseWidth  35.7 mm  – alar span
  //   noseHeight 29.4 mm  – bridge (6) → tip (4), NOT the ~50 mm
  //                         textbook nasion→subnasale span
  //   noseToChin 89.4 mm  – tip (4) → menton (152)
  //   mouthWidth 49.1 mm
  //   faceWidth 153.3 mm  – head silhouette at 234/454
  //
  // They used to be numbers picked to sit inside the then-current
  // window rather than to describe a face, and the window they were
  // fitted to was itself wrong: bridge→tip came out 58% ABOVE the
  // average adult while every other span sat 8–29% below it. Keep this
  // fixture anatomically consistent — /measure's plausibility gate is
  // entitled to reject a face that isn't one. Mirrors the copy in
  // fitter-funnel.helper.ts.
  await page.route(/(tasks-vision|mediapipe)/, async (route) => {
    // The JS module request (dev only) carries the package name
    // "tasks-vision"; the wasm/model files carry "mediapipe" and are
    // fetched in any build. Only the former proves the stub took.
    if (/tasks-vision/.test(route.request().url())) {
      state.moduleIntercepted = true;
    }
    const stub = `
      export class FilesetResolver {
        static async forVisionTasks() { return {}; }
      }
      const FAKE_LANDMARKS = new Array(478).fill({ x: 0.5, y: 0.5 });
      FAKE_LANDMARKS[469] = { x: 0.4950, y: 0.50 };
      FAKE_LANDMARKS[471] = { x: 0.5050, y: 0.50 };
      FAKE_LANDMARKS[129] = { x: 0.484735, y: 0.55 };
      FAKE_LANDMARKS[358] = { x: 0.515265, y: 0.55 };
      FAKE_LANDMARKS[6]   = { x: 0.50, y: 0.467694 };
      FAKE_LANDMARKS[4]   = { x: 0.50, y: 0.512306 };
      FAKE_LANDMARKS[152] = { x: 0.50, y: 0.648146 };
      FAKE_LANDMARKS[61]  = { x: 0.479009, y: 0.575 };
      FAKE_LANDMARKS[291] = { x: 0.520991, y: 0.575 };
      FAKE_LANDMARKS[234] = { x: 0.434496, y: 0.50 };
      FAKE_LANDMARKS[454] = { x: 0.565504, y: 0.50 };
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

  const intercept: InterceptState = { moduleIntercepted: false };
  await mockCameraAndMediaPipe(page, intercept);

  // The virtual mask fitter is invitation-only: every fitter route
  // (starting at /consent) bounces to /fitter-invite unless an invite
  // token is present. Seed one in sessionStorage before navigation so
  // the guarded flow renders. (The server-side /api/recommend gate is
  // irrelevant here — the dev server doesn't proxy /api/*, so the call
  // returns the SPA shell and the page falls into its error-alert state,
  // which this test already treats as acceptable.)
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem("fitter_invite_token", "e2e-invite-token");
    } catch {
      /* sessionStorage blocked — the gate will redirect, test will surface it */
    }
  });

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
  await page
    .getByRole("checkbox", { name: /confirm|consent/i })
    .first()
    .check();
  await page.getByRole("checkbox", { name: /email/i }).first().check();
  await page.getByRole("button", { name: /continue/i }).click();

  // /capture — wait for the camera to warm up, click Take Photo.
  await page.waitForURL(/\/capture/, { timeout: 5_000 });
  await page.getByTestId("button-capture").waitFor({ state: "visible" });
  await page.waitForTimeout(800);
  await page.getByTestId("button-capture").click({ timeout: 10_000 });

  // /measure → /questionnaire — MediaPipe runs, measurements extract.
  // The stubbed capture reads as farther than the coached arm's-length
  // window (12.8 px iris → px/mm below the distance band), so /measure
  // shows the distance-retake hint and HOLDS instead of auto-advancing;
  // continue explicitly, as a patient would. If the MediaPipe module was
  // never intercepted (a bundled `vite preview`/prod build), the
  // real WASM landmarker runs against stubbed bytes and never
  // advances — skip with a clear note rather than time out as a
  // failure, since this spec requires the unbundled dev server.
  try {
    await page.getByTestId("measure-continue").click({ timeout: 15_000 });
  } catch {
    /* no hold — either auto-advance ran or the stub didn't take */
  }
  try {
    await page.waitForURL(/\/questionnaire/, { timeout: 15_000 });
  } catch (err) {
    test.skip(
      !intercept.moduleIntercepted,
      "Requires the Vite dev server: the @mediapipe/tasks-vision module " +
        "is bundled in this build, so the test stub cannot replace it. " +
        "Run `pnpm --filter @workspace/cpap-fitter dev` then `pnpm test:e2e`.",
    );
    throw err;
  }

  // /questionnaire — the adult-or-child gate first, then click any
  // visible radio option per question until we land on /results.
  //
  // The gate is answered explicitly rather than left to the generic
  // loop: it is the one screen where the answer decides which masks are
  // eligible at all, and drifting onto the pediatric tile would rank
  // nothing (the legacy catalog is adult-only) and fail this test far
  // from its cause.
  try {
    await page.getByTestId("button-population-adult").click({ timeout: 5_000 });
  } catch {
    /* Already past the gate. */
  }

  // 13 iterations is enough for the 11 current questions plus headroom.
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
  await expect(page.getByTestId("error-boundary-fallback")).toBeHidden();
  expect(pageErrors).toEqual([]);
});
