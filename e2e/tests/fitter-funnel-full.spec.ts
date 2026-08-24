// End-to-end sweep of the ENTIRE virtual mask fitter, covering the
// happy path and every recoverable failure situation a patient can
// realistically hit:
//
//   1. Demo-mode full funnel: consent → capture → measure →
//      questionnaire → results (real recommendation cards) → choose →
//      order form → placed order → success page. Demo mode's in-browser
//      fetch interceptor answers /api/* from fixtures, so this walks
//      the complete product experience with zero backend — the same
//      sandbox a prospect uses.
//   2. Mid-flow refresh resilience (sessionStorage rehydration), incl.
//      the /measure cold-load-with-measurements fast-forward.
//   3. Route guards: uninvited, unconsented, and out-of-order deep
//      links all land somewhere sensible (never a blank page).
//   4. Camera permission denied / no camera device recovery UX.
//   5. Vision runtime unreachable (degraded) escape hatches.
//   6. Legacy engine failures on /results: transient (retry works),
//      permanent (no retry), and a malformed clinical 200 that must
//      fall back to the legacy engine instead of stranding skeletons.
//   7. sessionStorage fully blocked (private browsing) still completes.
//
// HARNESS REQUIREMENT: scenarios that pass through /measure stub the
// @mediapipe/tasks-vision ES module, which only works against the Vite
// dev server (see fitter-funnel.helper.ts) — those scenarios skip on a
// bundled build. Guard-and-error scenarios never reach MediaPipe and
// run against any build.

import { test, expect, type Page } from "@playwright/test";
import {
  mockCameraAndMediaPipe,
  captureToQuestionnaire,
  questionnaireToResults,
  type InterceptState,
} from "./fitter-funnel.helper";

/** Seed the client-side demo sandbox (persisted flag, no URL param —
 * the param would be scrubbed by history.replaceState anyway). */
async function enableDemoMode(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("pennfit:demo-mode:v1", "1");
    } catch {
      /* storage blocked — the test will surface it */
    }
  });
}

/** Seed the invite token exactly as /fitter-invite would. */
async function seedInviteToken(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem("fitter_invite_token", "e2e-invite-token");
    } catch {
      /* sessionStorage blocked — the gate will redirect, test will surface it */
    }
  });
}

/** Seed a completed consent step (email + the camera-consent flag the
 *  /consent Continue handler writes — the gate keys on the flag, not on
 *  the mere presence of an email). */
async function seedConsentedEmail(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem("fitter_email", "e2e@example.com");
      sessionStorage.setItem("fitter_email_consent", "0");
      sessionStorage.setItem("fitter_camera_consent", "1");
    } catch {
      /* ignore */
    }
  });
}

/**
 * Seed already-extracted measurements (the /measure output).
 *
 * The canonical face, as `extractMeasurementValues` measures it — this
 * has to be a set that the /measure plausibility gate and the server
 * windows both admit, or the funnel stops here. (It previously carried
 * a 48.2 mm `noseHeight`, the textbook nasion→subnasale span rather
 * than the ~29 mm bridge→tip span the scanner reports.)
 */
async function seedMeasurements(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem(
        "fitter_measurements",
        JSON.stringify({
          noseWidth: 35.7,
          noseHeight: 29.4,
          noseToChin: 89.4,
          mouthWidth: 49.1,
          faceWidthAtCheekbones: 153.3,
          calibrationMethod: "iris",
        }),
      );
    } catch {
      /* ignore */
    }
  });
}

/**
 * Seed the answered adult-or-child gate (the questionnaire's first
 * screen).
 *
 * Part of the pre-/results flow state, not decoration: /results refuses
 * to render without it and sends the patient back to the questionnaire,
 * because every engine reads an unset population as "adult" and a
 * seeded state that skipped the question would be silently asserting an
 * answer the patient never gave.
 */
async function seedPopulation(
  page: Page,
  population: "adult" | "pediatric" = "adult",
): Promise<void> {
  await page.addInitScript((value) => {
    try {
      sessionStorage.setItem("fitter_population", value);
    } catch {
      /* ignore */
    }
  }, population);
}

/** Minimal legacy /api/recommend payload in the shape the results page
 * renders (mirrors the demo fixture's MaskRecommendation fields). */
const LEGACY_RECOMMENDATION = {
  topRecommendations: [
    {
      maskId: "e2e-mask-n20",
      name: "ResMed AirFit N20",
      modelNumber: "63500",
      manufacturer: "ResMed",
      type: "nasal",
      confidence: 0.91,
      summary: "A great match for your measurements.",
      reasoning: ["Your nose width fits the Medium cushion range."],
      features: ["InfinitySeal cushion"],
      contraindications: [],
      imageUrl: null,
      recommendedSize: "M",
      sizeRationale: "Nose width maps to Medium.",
    },
  ],
  alternatives: [],
  disclaimer: "Test disclaimer.",
};

/** Fill the /consent gate and land on /capture. */
async function completeConsent(page: Page): Promise<void> {
  await page.goto("/consent");
  await page.getByLabel(/email/i).first().fill("e2e@example.com");
  await page
    .getByRole("checkbox", { name: /confirm|consent/i })
    .first()
    .check();
  await page.getByRole("checkbox", { name: /email/i }).first().check();
  await page.getByRole("button", { name: /continue/i }).click();
  await page.waitForURL(/\/capture/, { timeout: 5_000 });
}

// ────────────────────────────────────────────────────────────────────
// 1. The complete funnel, demo mode: consent → filed fit request.
// ────────────────────────────────────────────────────────────────────

test("demo mode: entire fitter funnel from consent to filed fit request", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(`${err.name}: ${err.message}`));

  const intercept: InterceptState = { moduleIntercepted: false };
  await enableDemoMode(page);
  await mockCameraAndMediaPipe(page, intercept);

  await completeConsent(page);

  // /capture → /measure → /questionnaire (MediaPipe stubbed).
  const advanced = await captureToQuestionnaire(page, intercept);
  test.skip(
    !advanced,
    "Requires the Vite dev server: @mediapipe/tasks-vision is bundled in " +
      "this build so the module stub cannot take effect.",
  );

  // /questionnaire → /results.
  await questionnaireToResults(page);

  // Real recommendation cards, answered by the demo interceptor.
  await expect(
    page.locator('[data-testid^="button-choose-"]').first(),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("error-boundary-fallback")).toBeHidden();

  // Choose the top mask → /fit-request.
  //
  // NOT /order. Under `fitter.lead_capture_only` — on by default, and
  // what the store falls back to when a flag can't be resolved — the
  // patient no longer files their own insurance order. The fitting ends
  // in a request a person at the DME works.
  await page.locator('[data-testid^="button-choose-"]').first().click();
  await page.waitForURL(/\/fit-request/, { timeout: 5_000 });

  // The chosen mask carries through to the request.
  await expect(page.getByTestId("fit-request-mask")).toBeVisible();

  // Fill the request. Email is prefilled from the consent gate, and —
  // the point of the change — insurance is left entirely blank, because
  // staff verify benefits either way.
  await expect(page.getByTestId("input-fit-request-email")).toHaveValue(
    "e2e@example.com",
  );
  await page.getByTestId("input-fit-request-name").fill("Casey Example");
  await page.getByTestId("input-fit-request-phone").fill("5551234567");

  await page.getByTestId("button-fit-request-submit").click();

  // The confirmation is in place, and deliberately carries NO order
  // number: nothing has been ordered.
  await expect(page.getByText(/We have your request/i)).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText(/Nothing has been ordered/i)).toBeVisible();

  expect(pageErrors).toEqual([]);
});

// ────────────────────────────────────────────────────────────────────
// 1b. The other way out of /results: ask for a call, no mask chosen.
// ────────────────────────────────────────────────────────────────────

test("demo mode: a patient can ask for a call without choosing a mask", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(`${err.name}: ${err.message}`));

  const intercept: InterceptState = { moduleIntercepted: false };
  await enableDemoMode(page);
  await mockCameraAndMediaPipe(page, intercept);
  await completeConsent(page);

  const advanced = await captureToQuestionnaire(page, intercept);
  test.skip(
    !advanced,
    "Requires the Vite dev server: @mediapipe/tasks-vision is bundled in " +
      "this build so the module stub cannot take effect.",
  );
  await questionnaireToResults(page);

  // The callback panel sits under the cards and needs no selection —
  // the patient who wants a person is usually the one who could not
  // choose between them.
  await page.getByTestId("results-request-callback").click();
  await page.waitForURL(/\/fit-request\?mode=callback/, { timeout: 5_000 });

  // Callback mode asks for contact details only.
  await expect(page.getByTestId("input-fit-request-carrier")).toHaveCount(0);
  await page.getByTestId("input-fit-request-name").fill("Casey Example");
  await page.getByTestId("input-fit-request-phone").fill("5551234567");
  await page.getByTestId("button-fit-request-submit").click();

  await expect(page.getByText(/We have your request/i)).toBeVisible({
    timeout: 10_000,
  });

  expect(pageErrors).toEqual([]);
});

// ────────────────────────────────────────────────────────────────────
// 2. Mid-flow refresh resilience.
// ────────────────────────────────────────────────────────────────────

test("refresh on /questionnaire resumes; /measure with saved measurements fast-forwards", async ({
  page,
}) => {
  const intercept: InterceptState = { moduleIntercepted: false };
  await enableDemoMode(page);
  await mockCameraAndMediaPipe(page, intercept);
  await completeConsent(page);
  const advanced = await captureToQuestionnaire(page, intercept);
  test.skip(!advanced, "Requires the Vite dev server (see header comment).");

  // A hard refresh mid-questionnaire must NOT restart the funnel: the
  // measurements + email + invite context are all rehydrated from
  // sessionStorage.
  await page.reload();
  await expect(page).toHaveURL(/\/questionnaire/);
  await expect(page.locator('[role="radio"]').first()).toBeVisible({
    timeout: 5_000,
  });

  // The adult-or-child answer is rehydrated too. Re-asking it after a
  // refresh would not merely annoy — every engine reads an unset
  // population as "adult", so a gate that forgets is a gate that can
  // silently switch a child's fitting onto the adult service line.
  await page.getByTestId("button-population-adult").click();
  await expect(page.getByTestId("button-population-adult")).toHaveCount(0);
  await page.reload();
  await expect(page).toHaveURL(/\/questionnaire/);
  await expect(page.getByTestId("button-population-adult")).toHaveCount(0);

  // Navigating to /measure with measurements already extracted (the
  // captured image is memory-only and gone after any refresh) must
  // fast-forward TO the questionnaire, not bounce back to /capture for
  // a redundant retake.
  await page.goto("/measure");
  await page.waitForURL(/\/questionnaire/, { timeout: 5_000 });
});

// ────────────────────────────────────────────────────────────────────
// 3. Route guards — deep links land somewhere sensible.
// ────────────────────────────────────────────────────────────────────

test("uninvited deep links bounce to the invitation-required explainer", async ({
  page,
}) => {
  for (const path of ["/consent", "/capture", "/results"]) {
    await page.goto(path);
    await page.waitForURL(/\/fitter-invite/, { timeout: 5_000 });
    await expect(
      page.getByRole("heading", { name: /invitation required/i }),
    ).toBeVisible();
  }
});

test("invited but unconsented deep link bounces to /consent", async ({
  page,
}) => {
  await seedInviteToken(page);
  await page.goto("/capture");
  await page.waitForURL(/\/consent/, { timeout: 5_000 });
  // The consent card title isn't a semantic heading — anchor on the
  // page copy plus the email gate the redirect exists to enforce.
  await expect(page.getByText(/privacy & consent/i).first()).toBeVisible();
  await expect(page.getByLabel(/email/i).first()).toBeVisible();
});

test("a prefilled invite email is not consent — /capture still bounces to /consent", async ({
  page,
}) => {
  // A staff invite carries a KNOWN email, and /fitter-invite prefills it
  // when the patient taps Start. The camera gate used to be
  // `Boolean(email)`, so that prefill alone marked them consented: they
  // could type /capture (or press Back out of /consent) into
  // getUserMedia having never seen the biometric disclosure or ticked
  // the box. Seed exactly that state — invite + email, no consent flag.
  await seedInviteToken(page);
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem("fitter_email", "known-patient@example.com");
    } catch {
      /* ignore */
    }
  });

  await page.goto("/capture");
  await page.waitForURL(/\/consent/, { timeout: 5_000 });
  await expect(page.getByText(/privacy & consent/i).first()).toBeVisible();

  // …and the same for the rest of the camera-bearing flow.
  await page.goto("/measure");
  await page.waitForURL(/\/consent/, { timeout: 5_000 });
});

test("consented /results without measurements goes home; /order re-routes to the request form", async ({
  page,
}) => {
  await seedInviteToken(page);
  await seedConsentedEmail(page);
  await page.goto("/results");
  await page.waitForURL(
    (url) => new URL(url).pathname === "/" || /\/$/.test(url.toString()),
    { timeout: 5_000 },
  );

  // /order is a dead end under `fitter.lead_capture_only`: the API
  // refuses the POST, so a bookmark or a back-button landing must not
  // hand the patient a form that will fail at submit. It re-routes to
  // the request form, which — unlike /order — needs no chosen mask.
  await seedMeasurements(page);
  await seedPopulation(page);
  await page.goto("/order");
  await page.waitForURL(/\/fit-request/, { timeout: 5_000 });
  await expect(page.getByTestId("button-fit-request-submit")).toBeVisible();
});

test("/fit-request without an adult-or-child answer returns to the questionnaire", async ({
  page,
}) => {
  // The same guard GuardedResults applies. Without it the form would
  // serialize `population ?? "adult"`, so the filed request and the team
  // email would claim an adult fitting nobody was ever asked about.
  await seedInviteToken(page);
  await seedConsentedEmail(page);
  await seedMeasurements(page);
  await page.goto("/fit-request");
  await page.waitForURL(/\/questionnaire/, { timeout: 5_000 });
  await expect(page.getByTestId("button-population-adult")).toBeVisible();
});

test("/results with measurements but no adult-or-child answer returns to the questionnaire", async ({
  page,
}) => {
  // Not a cosmetic guard. Every engine reads an unset population as
  // "adult", so a deep link straight to /results would quietly fit a
  // child against the adult service line rather than failing. Send them
  // back to the one screen that can say otherwise.
  await seedInviteToken(page);
  await seedConsentedEmail(page);
  await seedMeasurements(page);
  await page.goto("/results");
  await page.waitForURL(/\/questionnaire/, { timeout: 5_000 });
  await expect(page.getByTestId("button-population-adult")).toBeVisible();
});

// ────────────────────────────────────────────────────────────────────
// 4. Camera failures.
// ────────────────────────────────────────────────────────────────────

test("camera permission denied shows browser-specific recovery plus escape hatches", async ({
  page,
}) => {
  await seedInviteToken(page);
  await seedConsentedEmail(page);
  await page.addInitScript(() => {
    // @ts-expect-error — installing a partial stub
    navigator.mediaDevices = navigator.mediaDevices ?? {};
    navigator.mediaDevices.getUserMedia = () => {
      const err = new DOMException("Permission denied", "NotAllowedError");
      return Promise.reject(err);
    };
  });
  await page.goto("/capture");

  await expect(page.getByTestId("capture-camera-error")).toBeVisible({
    timeout: 5_000,
  });
  // Permission-specific how-to renders (UA-mapped re-enable steps).
  await expect(page.getByTestId("capture-camera-howto")).toBeVisible();
  // Recovery + both escape hatches.
  await expect(page.getByTestId("capture-camera-retry")).toBeVisible();
  await expect(page.getByTestId("capture-camera-fallback-shop")).toBeVisible();
  await expect(
    page.getByTestId("capture-camera-fallback-insurance"),
  ).toBeVisible();
});

test("no camera device shows a dead-end without a useless retry, with escape hatches", async ({
  page,
}) => {
  await seedInviteToken(page);
  await seedConsentedEmail(page);
  await page.addInitScript(() => {
    // @ts-expect-error — installing a partial stub
    navigator.mediaDevices = navigator.mediaDevices ?? {};
    navigator.mediaDevices.getUserMedia = () => {
      const err = new DOMException("No camera found", "NotFoundError");
      return Promise.reject(err);
    };
  });
  await page.goto("/capture");

  await expect(page.getByTestId("capture-camera-error")).toBeVisible({
    timeout: 5_000,
  });
  // Retrying can't conjure a camera — the button must not render.
  await expect(page.getByTestId("capture-camera-retry")).toBeHidden();
  await expect(page.getByTestId("capture-camera-fallback-shop")).toBeVisible();
  await expect(
    page.getByTestId("capture-camera-fallback-insurance"),
  ).toBeVisible();
});

// ────────────────────────────────────────────────────────────────────
// 5. Vision runtime unreachable.
// ────────────────────────────────────────────────────────────────────

test("vision runtime unreachable degrades with escape hatches and a disabled shutter", async ({
  page,
}) => {
  await seedInviteToken(page);
  await seedConsentedEmail(page);
  const intercept: InterceptState = { moduleIntercepted: false };
  await mockCameraAndMediaPipe(page, intercept);
  // The advisory HEAD probe of the model asset fails → "degraded".
  await page.route("**/mediapipe/models/**", (route) =>
    route.fulfill({ status: 404, body: "" }),
  );
  await page.goto("/capture");

  await expect(page.getByTestId("capture-degraded-fallback-shop")).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    page.getByTestId("capture-degraded-fallback-insurance"),
  ).toBeVisible();
  await expect(page.getByTestId("button-capture")).toBeDisabled();
});

// ────────────────────────────────────────────────────────────────────
// 6. /results engine failures (legacy + clinical), seeded past capture.
// ────────────────────────────────────────────────────────────────────

/** Seed a full pre-/results state and force the clinical probe down a
 * chosen path. Returns after navigation to /results. */
async function gotoResultsWithState(page: Page): Promise<void> {
  await seedInviteToken(page);
  await seedConsentedEmail(page);
  await seedMeasurements(page);
  await seedPopulation(page);
  await page.goto("/results");
}

test("transient legacy failure shows a retry that recovers into recommendations", async ({
  page,
}) => {
  // Clinical probe → 404 = "tenant on the legacy path".
  await page.route("**/api/fit/assess", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "not_found" }),
    }),
  );
  let recommendCalls = 0;
  await page.route("**/api/recommend", (route) => {
    recommendCalls += 1;
    if (recommendCalls === 1) {
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "engine unavailable" }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(LEGACY_RECOMMENDATION),
    });
  });
  await gotoResultsWithState(page);

  // Transient (5xx) failure → in-page error with a retry.
  await expect(
    page.getByRole("heading", { name: /error generating recommendations/i }),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("results-retry").click();

  // The retry recovers into rendered recommendation cards.
  await expect(
    page.locator('[data-testid^="button-choose-"]').first(),
  ).toBeVisible({ timeout: 10_000 });
});

test("permanent legacy failure (4xx) explains itself without a retry", async ({
  page,
}) => {
  await page.route("**/api/fit/assess", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "not_found" }),
    }),
  );
  await page.route("**/api/recommend", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: "The virtual mask fitter is available by invitation only.",
      }),
    }),
  );
  await gotoResultsWithState(page);

  await expect(
    page.getByRole("heading", { name: /error generating recommendations/i }),
  ).toBeVisible({ timeout: 10_000 });
  // A 4xx is permanent — retrying the same request can't fix it.
  await expect(page.getByTestId("results-retry")).toBeHidden();
  await expect(page.getByRole("button", { name: /start over/i })).toBeVisible();
});

test("malformed clinical 200 (no primary) holds the fitting instead of falling back to the unscreened legacy engine", async ({
  page,
}) => {
  // A non-withheld outcome with no primary violates the /api/fit/assess
  // contract, so the client treats it as malformed → `unavailable`.
  //
  // This test used to assert the opposite — that a malformed clinical
  // response fell through to /api/recommend — because the only failure
  // mode it was written to lock out was an endless skeleton with no
  // retry. #1289 changed that on purpose: the legacy engine has NO
  // implant/magnet filter, and after migration 0500 every tenant screens
  // for magnets, so silently falling back would hand an implant patient a
  // magnetic-clip mask whenever /api/fit/assess hiccuped. Only
  // `not_enabled` (the tenant genuinely doesn't run clinical assessment)
  // still routes to the legacy engine — see the 404 cases above, which
  // still expect it.
  //
  // The original intent is preserved and still asserted: the patient is
  // never stranded. They get an explicit explanation and a retry.
  await page.route("**/api/fit/assess", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ outcome: "high_confidence" }),
    }),
  );
  // Staged so that a regression which reinstates the fallback FAILS here
  // rather than quietly passing: if the page ever calls /api/recommend on
  // this path again, it would render choose-buttons and trip the
  // assertion below.
  let legacyEngineCalled = false;
  await page.route("**/api/recommend", (route) => {
    legacyEngineCalled = true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(LEGACY_RECOMMENDATION),
    });
  });
  await gotoResultsWithState(page);

  // Not stranded: an explicit, actionable state.
  await expect(page.getByTestId("results-clinical-unavailable")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("button", { name: /try again/i })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /retake photo/i }),
  ).toBeVisible();

  // The safety property: no unscreened recommendation reaches the patient.
  await expect(page.locator('[data-testid^="button-choose-"]')).toHaveCount(0);
  expect(
    legacyEngineCalled,
    "the magnet-unscreened legacy engine must not be consulted when the clinical assessment fails",
  ).toBe(false);
});

// ────────────────────────────────────────────────────────────────────
// 7. sessionStorage fully blocked (strict private browsing).
// ────────────────────────────────────────────────────────────────────

test("blocked sessionStorage warns the patient and the flow still advances in memory", async ({
  page,
}) => {
  await enableDemoMode(page); // demo bypasses the invite gate (no sessionStorage available to seed one)
  await page.addInitScript(() => {
    // Simulate storage-hostile private browsing: every sessionStorage
    // access throws, as it does when site data is fully blocked.
    Object.defineProperty(window, "sessionStorage", {
      get() {
        throw new DOMException("Blocked", "SecurityError");
      },
    });
  });
  await page.goto("/consent");

  // The heads-up banner tells the patient a refresh will restart.
  await expect(page.getByTestId("fitter-storage-notice")).toBeVisible({
    timeout: 5_000,
  });

  // The gate itself still works — state lives in React memory.
  await page.getByLabel(/email/i).first().fill("memory-only@example.com");
  await page
    .getByRole("checkbox", { name: /confirm|consent/i })
    .first()
    .check();
  await page.getByRole("checkbox", { name: /email/i }).first().check();
  await page.getByRole("button", { name: /continue/i }).click();
  await page.waitForURL(/\/capture/, { timeout: 5_000 });
});
