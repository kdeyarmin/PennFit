// Shared harness to drive the public fitter funnel
// (/consent → /capture → /measure → /questionnaire → /results) under
// headless Chromium. The camera + MediaPipe mock is copied verbatim from
// results-page-resilience.spec.ts (the proven flow); factoring it here
// lets the fitter-funnel a11y sweep reuse the exact same setup without
// disturbing that spec.
//
// IMPORTANT: like results-page-resilience.spec.ts, this only works
// against the unbundled Vite *dev* server — a bundled `vite preview`
// build inlines the @mediapipe/tasks-vision module so the route stub
// never intercepts it and /measure never advances. Callers MUST honour
// the boolean returned by `captureToQuestionnaire` and `test.skip` when
// it's false.

import { type Page } from "@playwright/test";

/** Shared flag: did the MediaPipe ES *module* request get intercepted?
 * (Distinct from the wasm/model files, which are fetched over the
 * network even in a bundled build.) When false after reaching the
 * capture step, the build is bundled and the stub can't take effect. */
export type InterceptState = { moduleIntercepted: boolean };

export async function mockCameraAndMediaPipe(
  page: Page,
  state: InterceptState,
): Promise<void> {
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
  // serve a tiny replacement that returns deterministic landmarks (same
  // fixture as results-page-resilience.spec.ts).
  //
  // The landmarks below are the CANONICAL FACE — MediaPipe's own metric
  // reference mesh — back-projected so that `extractMeasurementValues`
  // recovers its true spans (alar 35.7 mm, bridge→tip 29.4, tip→chin
  // 89.4, mouth 49.1, silhouette 153.3) at a 1280×720 frame with the
  // 12.8 px iris below. They were previously hand-picked "in-range"
  // numbers that described no real face: bridge→tip came out 58% ABOVE
  // the average adult while every other span sat 8–29% below it, which
  // only passed because the plausibility ceiling for that span used to
  // be 2.4x the canonical value. Keep them anatomically consistent —
  // /measure's gate is entitled to reject a face that isn't one.
  await page.route(/(tasks-vision|mediapipe)/, async (route) => {
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

/** /consent → fill the email + opt-in gate → land on /capture. */
export async function consentToCapture(page: Page): Promise<void> {
  // The fitter funnel is invitation-only: every step (starting at
  // /consent) bounces to /fitter-invite unless an invite token is in
  // sessionStorage (see GuardedConsent / useFitterInviteGate in App.tsx).
  // Seed one before navigating, exactly as results-page-resilience.spec.ts
  // does, so the guarded flow renders instead of redirecting.
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem("fitter_invite_token", "e2e-invite-token");
    } catch {
      /* sessionStorage blocked — the gate will redirect, test will surface it */
    }
  });
  await page.goto("/consent");
  await page.getByLabel(/email/i).first().fill("a11y@example.com");
  await page
    .getByRole("checkbox", { name: /confirm|consent/i })
    .first()
    .check();
  await page.getByRole("checkbox", { name: /email/i }).first().check();
  await page.getByRole("button", { name: /continue/i }).click();
  await page.waitForURL(/\/capture/, { timeout: 5_000 });
}

/**
 * Click Take Photo on /capture and wait for MediaPipe to advance to
 * /questionnaire. Returns false (rather than throwing) when the build is
 * bundled — the module stub never took, so the caller should test.skip.
 */
export async function captureToQuestionnaire(
  page: Page,
  state: InterceptState,
): Promise<boolean> {
  await page.getByTestId("button-capture").waitFor({ state: "visible" });
  await page.waitForTimeout(800);
  await page.getByTestId("button-capture").click({ timeout: 10_000 });
  try {
    await page.waitForURL(/\/questionnaire/, { timeout: 15_000 });
    return true;
  } catch (err) {
    if (!state.moduleIntercepted) return false;
    throw err;
  }
}

/** Answer each questionnaire item until the page lands on /results. */
export async function questionnaireToResults(page: Page): Promise<void> {
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
}
