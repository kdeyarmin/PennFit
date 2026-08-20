# Virtual Mask Fitter — End-to-End Review (2026-08-20)

Full review of the virtual mask fitter: both recommendation engines
(legacy `/api/recommend` + clinical `/api/fit/assess`), the capture →
measure → questionnaire → results → order funnel, the invite layer, and
the demo sandbox — plus a new comprehensive Playwright sweep that
exercises the entire process end to end, happy path and failure paths
alike.

Method: source review of the fitter frontend
(`artifacts/cpap-fitter/src`) and backend
(`artifacts/resupply-api/src/{routes,lib}` fitting surfaces), then
runtime verification under headless Chromium against the Vite dev
server with the camera + MediaPipe mocked (the established harness from
`e2e/tests/fitter-funnel.helper.ts`).

This builds on the four prior fitter review passes (#1262, #1265/#1267,
#1268, #1271, #1273) — most of what those fixed was re-verified still
working; findings below are new.

## 1. What was verified working (e2e)

New spec: [`e2e/tests/fitter-funnel-full.spec.ts`](../e2e/tests/fitter-funnel-full.spec.ts)
— 12 scenarios, all green, alongside the existing 12 (storefront smoke,
a11y sweeps, results-page resilience), 4,266 cpap-fitter unit tests and
7,509 resupply-api unit tests.

| #   | Situation                  | Verified behavior                                                                                                                                                                                          |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Happy path, demo mode      | Complete funnel: consent → camera capture → on-device measurement → 11-question questionnaire → recommendation cards → choose mask → full order form → placed order → confirmation page. Zero page errors. |
| 2   | Refresh mid-flow           | `/questionnaire` reload resumes in place (sessionStorage rehydration); `/measure` revisited after extraction fast-forwards to the questionnaire instead of forcing a photo retake (fixed here).            |
| 3   | Uninvited deep links       | `/consent`, `/capture`, `/results` all bounce to the friendly "Invitation required" explainer.                                                                                                             |
| 4   | Invited, unconsented       | `/capture` bounces to `/consent` (email gate).                                                                                                                                                             |
| 5   | Out-of-order deep links    | `/results` without measurements → home; `/order` without a chosen mask → `/results`.                                                                                                                       |
| 6   | Camera permission denied   | Browser-specific re-enable instructions + Try again + both escape hatches (shop / insurance).                                                                                                              |
| 7   | No camera device           | Dead-end without a useless retry button; escape hatches present.                                                                                                                                           |
| 8   | Vision runtime unreachable | "Degraded" escape hatches render; shutter stays disabled (no dead-end).                                                                                                                                    |
| 9   | Legacy engine 5xx          | In-page error with retry; retry recovers into rendered recommendations.                                                                                                                                    |
| 10  | Legacy engine 4xx          | Permanent-error copy, no useless retry, Start Over offered.                                                                                                                                                |
| 11  | Malformed clinical 200     | A non-withheld outcome with no `primary` now falls back to the legacy engine instead of stranding the patient on skeletons (fixed here).                                                                   |
| 12  | sessionStorage blocked     | Heads-up banner renders; flow still advances entirely in memory.                                                                                                                                           |

Harness note: scenarios that pass through `/measure` stub the
`@mediapipe/tasks-vision` ES module and therefore require the unbundled
Vite dev server; they self-skip on a bundled build (same posture as
`results-page-resilience.spec.ts`).

## 2. Fixes shipped with this review

1. **Invited patients were auto-enrolled in the marketing nurture
   campaign without consent.** `/fitter-invite`'s known-email path
   called `setEmailConsent(email, true)` under the mistaken belief the
   flag gated the flow — it doesn't (the gate reads only the email;
   `App.tsx` documents this). The flag's only consumer is the
   marketing-gated campaign ping on `/results`, and the consent page
   itself calls forcing that opt-in "a consent dark pattern". Invited
   patients skip `/consent` entirely, so they never saw an opt-in. Now
   `false`; the staff-chart transmission (invite-token-gated) is
   unaffected. (`pages/fitter-invite.tsx`)
2. **A degraded-catalog fitting could skip human review.** When the DB
   catalog load fails, the engine falls back to the static catalog —
   which ships **zero mask contraindications**, so Tier-1 factor
   exclusions (mouth-breathing, dentures, skin breakdown…) are not
   applied (magnets still fail closed). Yet a `high_confidence` outcome
   set `review_status: "not_required"`, bypassing the clinician queue
   entirely. Degraded runs now always land `pending_review`.
   (`routes/storefront/fit-assess.ts`)
3. **`/shop/fitter-invite/complete` accepted ~100 KB of arbitrary JSON
   into staff-visible jsonb columns.** The third fitting-ingest path
   had none of its siblings' guards: `.passthrough()` measurements with
   no plausibility bounds, `z.record(z.unknown())` answers, and no
   encoded-media check — the "no images in the backend" rule was
   asserted in a comment only. Now: adult∪pediatric plausibility bounds
   (the same union window the client's `/measure` gate uses), scalar-only
   bounded answers, unknown keys stripped rather than stored, and the
   same belt-and-braces media guard as `/api/recommend` +
   `/api/fit/assess`, run against the raw body so media under a
   to-be-stripped key still rejects loudly. (`routes/shop/fitter-invite.ts`
   - 4 new route tests)
4. **A malformed clinical 200 stranded the patient on skeletons
   forever.** `requestFitAssessment` cast the response into
   `FitAssessment` without checking the contract "non-withheld outcome
   ⇒ primary present". In that state the withheld branch doesn't match,
   the clinical branch has nothing to render, and the legacy fallback
   never fires — endless skeletons, no retry. Unknown outcome strings
   and a missing primary now resolve `unavailable` → legacy fallback.
   (`lib/fit-assess-api.ts`, locked in by e2e #11)
5. **Refreshing `/measure` after extraction forced a redundant photo
   retake.** The captured image is memory-only (privacy), so on a
   refresh the page bounced to `/capture` even when the extracted
   measurements were persisted and the questionnaire was ready. The
   cold-load branch now fast-forwards to `/questionnaire` when
   measurements exist — which is also what the documented
   `canStayOnMeasure` invariant says. (`pages/measure.tsx`, locked in
   by e2e #2)
6. **Demo console handed staff a rescan link that 404s.** The demo
   fixture emitted `/fit/rescan/<token>` — a shape no route serves (the
   real link is `/fitter-invite?t=…`), and the platform-console test
   asserted the wrong shape. Both corrected.
   (`demo/fixtures/fitting.ts`, `demo/platform-console.test.ts`)
7. **Capture screen jargon during normal warm-up.** "Vision runtime is
   not ready yet. Please wait a moment and try again." rendered during
   ordinary camera warm-up — including when the actual blocker was the
   camera, not the runtime — directly under the plain-language status
   line that was written to replace exactly this. Removed; the status
   line and the degraded escape hatches carry the messaging.
   (`pages/capture.tsx`)
8. **Dead cleanup line.** `reset()` re-removed `fitter_measurements`
   via a re-typed string literal after `resetForNewFitting()` had
   already cleared it through the constant. (`hooks/use-fitter-store.tsx`)

## 3. Recommendations (not changed here)

Ranked; none is a live defect after the fixes above, but each is worth
a decision.

1. **Give the degraded path real contraindication data.** Forced review
   (fix 2) is a backstop, not a cure: the static fallback still scores
   masks with no Tier-1 factor exclusions. Options: embed the seed
   catalog's contraindications into `staticCatalogAsMasks()`, or cache
   the last-good DB catalog in-process and prefer it over the static
   list when the load fails. (`lib/fitting/catalog-store.ts`)
2. **Retire or data-drive `MANUFACTURER_BOOST`.** A hardcoded
   `{"React Health": 1.15}` commercial boost — one tenant's stocking
   preference — still multiplies rank for **every** tenant on the
   legacy engine. It's already marked deprecated in place, and the
   clinical engine's formulary tier (±10 %, tenant data) is the
   replacement; removing it changes live ranking, so it needs a product
   sign-off rather than a drive-by edit.
   (`lib/storefront/recommendationEngine.ts:143`)
3. **The legacy static catalog is explicitly not production data.**
   `src/data/maskCatalog.ts` still says "representative examples.
   Replace with actual … inventory and manufacturer-provided fit ranges
   before production use", and it's what every legacy-path tenant is
   scored against (with equal-bucket size partitioning rather than real
   per-size mm bands). The clinical path fixes all of this; the durable
   answer is migrating tenants onto `fitter.clinical_assessment` and
   treating the legacy engine as a fallback only.
4. **Five copies of the plausibility bounds.** Client `measure-flow.ts`,
   `recommend.ts`, `fit-assess.ts`, `confidence.ts`, and (now)
   `fitter-invite.ts` each carry the window with "keep in sync"
   comments. A shared constants module (e.g. in `lib/resupply-domain`,
   which both sides already depend on) would collapse them.
5. **`resolveOrgIdForSignedRecord` falls back to the seed org on a
   missing row.** The fitter routes compensate explicitly, but the
   fallback is shared by ~17 signed-link tables, and any future caller
   that forgets the follow-up check inherits a cross-tenant hole.
   Returning null (and letting callers opt into a fallback) is the
   safer default. (`lib/storefront/signed-link-org.ts:56`)
6. **`org_id` is string-interpolated into PostgREST `.or()` filters**
   (`catalog-store.ts`, `mask-catalog.ts`, `fit-assess.ts`). The values
   are server-resolved UUIDs today, so this is not exploitable — but an
   escaping/builder helper on the tenant-boundary predicate would make
   that permanent.
7. **The legacy engine never scores `noseHeight` or
   `faceWidthAtCheekbones`** — both are collected, validated, and
   stored, then ignored by `scoreFitMatch`. Either wire them in or stop
   implying they inform the legacy match.
8. **Guided multi-angle capture has no vision-health probe.** The
   single-frame page shows "still preparing" plus escape hatches via
   `useVisionRuntimeHealth`; the guided page relies solely on a 20 s
   model timeout, then silently falls back. Reusing the probe there
   would explain slow loads instead of eating them.
9. **`/results` clinical-probe latch is refactor-fragile.** The probe
   effect latches `hasProbedClinical` before the request and aborts on
   cleanup; if any effect dependency ever changes identity mid-flight
   (none does today — StrictMode is off and all deps are stable), the
   abort + latch combination would strand the skeletons. Resetting the
   latch when an aborted run never reached a terminal state would make
   the invariant structural. (`pages/results.tsx:374`)
10. **Step chrome starts at `/capture`.** The `FitFlowStepper` counts 5
    steps from capture, so the invite landing and consent pages sit
    outside the "Step N of 5" narrative a patient sees.
11. **Migration 0486's header claims a confidence cap that was since
    removed** ("the recommendation engine caps an unreviewed variant
    below high confidence") — reversed by `confidence.ts` (estimated
    bands can now reach high confidence; `needs_clinical_review` records
    provenance instead of gating). Applied migrations must not be
    edited; the correction belongs here: the migration header's control
    #1 no longer holds, and the operative posture is documented in
    `lib/fitting/confidence.ts:185`.
12. **`calibrationMethod: "manual"` is accepted end-to-end but nothing
    produces it.** There is no manual-entry fallback in the SPA — a
    camera-blocked patient's only options are the shop or in-person
    fitting. Building the manual path (nose ruler / credit-card
    calibration) would recover exactly the cohort most likely to be
    camera-averse; otherwise the enum value is dead weight.
13. **CI wiring.** `fitter-funnel-full.spec.ts` runs against the dev
    server; the guard/error scenarios also pass on `vite preview`.
    Worth adding to the e2e CI matrix alongside
    `results-page-resilience` so the funnel sweep runs on every PR.

## 4. Verification summary

- `pnpm --filter @workspace/cpap-fitter test` — 4,266 passed.
- `pnpm --filter @workspace/resupply-api test` — 7,509 passed (+ the new
  route tests).
- `pnpm typecheck` — clean.
- `pnpm lint:resupply` / `pnpm format:check` — clean.
- `pnpm test:e2e` — 24/24 (12 existing + 12 new), MediaPipe-dependent
  scenarios running unbundled, self-skipping otherwise.
