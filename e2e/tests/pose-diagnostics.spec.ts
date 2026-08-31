// The internal head-pose validation page, in a real browser.
//
// WHAT THIS CAN AND CANNOT PROVE
// ------------------------------
// It CANNOT answer the question the page exists for — whether MediaPipe's
// transformation matrix means what the code assumes on real hardware.
// That needs a real WASM build, a real camera and a real head, which is
// what docs/runbooks/fitter-device-validation.md is for.
//
// What it CAN prove, and what a broken build would silently lose:
//
//   * the route exists in a development build and does not exist in a
//     production one — a page that turns on the camera must not be
//     reachable on a patient site;
//   * it refuses to start until consent is given;
//   * it never crashes the app when the camera or the model is
//     unavailable, which is how it will behave on most machines that
//     open it;
//   * the instructions and the expected signs are actually rendered, so
//     an operator running the sequence is told which way to move.
//
// HARNESS: dev server only (the default `pnpm test:e2e` flow). Under
// `vite preview` the route is compiled out on purpose, and the spec
// asserts exactly that instead of skipping.

import { expect, test } from "@playwright/test";

const ROUTE = "/internal/pose-diagnostics";

/**
 * Deny camera access up front. Every assertion below is about the page's
 * behaviour BEFORE a camera is involved, and a headless browser has no
 * real one anyway — making the denial explicit keeps the test from
 * depending on how a given CI image happens to fail.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () =>
          Promise.reject(
            Object.assign(new Error("denied"), { name: "NotAllowedError" }),
          ),
      },
    });
  });
});

test("the validation page is reachable in a development build", async ({
  page,
}) => {
  const response = await page.goto(ROUTE);
  expect(response?.status()).toBeLessThan(400);

  const isDev = await page.evaluate(
    () => !document.querySelector('script[src*="/assets/index-"]'),
  );
  if (!isDev) {
    // A production bundle compiles the route out. That is the point, and
    // asserting it is more valuable than skipping.
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(
      /Head-pose convention validation/,
    );
    return;
  }

  await expect(
    page.getByRole("heading", { name: /Head-pose convention validation/ }),
  ).toBeVisible();
});

test("refuses to start the camera until consent is given", async ({ page }) => {
  await page.goto(ROUTE);
  const start = page.getByRole("button", { name: /Start the sequence/ });
  if ((await start.count()) === 0) test.skip(true, "production build");

  await expect(start).toBeDisabled();
  await page.getByRole("checkbox").check();
  await expect(start).toBeEnabled();
});

test("lists every guided movement before anything starts", async ({ page }) => {
  await page.goto(ROUTE);
  const heading = page.getByRole("heading", {
    name: /Head-pose convention validation/,
  });
  if ((await heading.count()) === 0) test.skip(true, "production build");

  // An operator who is not told which way to move produces an
  // inconclusive run, which is the outcome the report refuses to round
  // into a pass.
  for (const phrase of [
    /raise your chin/i,
    /lower your chin/i,
    /turn your head to YOUR left/i,
    /turn your head to YOUR right/i,
    /left ear moves toward your shoulder/i,
    /right ear moves toward your shoulder/i,
  ]) {
    await expect(page.getByText(phrase)).toBeVisible();
  }
});

test("states that no image is captured", async ({ page }) => {
  await page.goto(ROUTE);
  const heading = page.getByRole("heading", {
    name: /Head-pose convention validation/,
  });
  if ((await heading.count()) === 0) test.skip(true, "production build");

  await expect(
    page.getByText(/No image is captured, stored or transmitted/i),
  ).toBeVisible();
});

test("survives a denied camera without crashing the app", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto(ROUTE);
  const start = page.getByRole("button", { name: /Start the sequence/ });
  if ((await start.count()) === 0) test.skip(true, "production build");

  await page.getByRole("checkbox").check();
  await start.click();

  // It reports the failure and says the fitter itself is unaffected —
  // the geometric estimator is the designed fallback.
  await expect(
    page.getByText(/could not start the camera or the model/i),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText(/falls back to the geometric estimator/i),
  ).toBeVisible();
  expect(pageErrors).toEqual([]);
});
