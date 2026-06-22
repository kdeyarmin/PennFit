// Accessibility sweep of the core fitter funnel — the capture → measure
// → questionnaire → results flow where patients spend most of their time
// and which the public a11y.spec.ts can't reach (every step is guarded
// behind the camera/measurement flow). We drive the flow with the shared
// camera + MediaPipe mock (fitter-funnel.helper.ts) and run axe at each
// page the patient actually sees, failing on serious/critical only.
//
// Dev-server only: the MediaPipe module stub can't intercept a bundled
// `vite preview` build, so /measure never advances. The test skips with
// a clear note in that case (same contract as
// results-page-resilience.spec.ts) rather than failing.

import { test } from "@playwright/test";

import { expectNoSeriousAxeViolations } from "./axe.helper";
import {
  captureToQuestionnaire,
  consentToCapture,
  mockCameraAndMediaPipe,
  questionnaireToResults,
  type InterceptState,
} from "./fitter-funnel.helper";

test("fitter funnel (capture → questionnaire → results) has no serious/critical axe violations", async ({
  page,
}) => {
  const state: InterceptState = { moduleIntercepted: false };
  await mockCameraAndMediaPipe(page, state);

  // /capture — the live camera step.
  await consentToCapture(page);
  await expectNoSeriousAxeViolations(page, "capture");

  const advanced = await captureToQuestionnaire(page, state);
  test.skip(
    !advanced,
    "Requires the Vite dev server: @mediapipe/tasks-vision is bundled in " +
      "this build, so the route stub can't replace it and /measure never " +
      "advances. Run `pnpm --filter @workspace/cpap-fitter dev` then " +
      "`pnpm test:e2e`.",
  );

  // /questionnaire — the intake questions.
  await expectNoSeriousAxeViolations(page, "questionnaire");

  // /results — the mask recommendation, where patients dwell.
  await questionnaireToResults(page);
  await expectNoSeriousAxeViolations(page, "results");
});
