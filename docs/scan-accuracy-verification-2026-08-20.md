# Face-Scan Accuracy — Verification & Corrections (2026-08-20)

How we verified the virtual mask fitter's measurement accuracy without
access to real faces, what the verification found, and what was changed.
Companion to
[`virtual-mask-fitter-review-2026-08-20.md`](./virtual-mask-fitter-review-2026-08-20.md).

## Method

The scan's arithmetic is deterministic, so it can be verified exactly
against a face of **known millimetre geometry**: MediaPipe's own
canonical face model (`canonical_face_model.obj`, the metric reference
mesh the 468 landmark indices are defined against — google-ai-edge/
mediapipe, Apache-2.0). We pinhole-project it at realistic capture
distances (28–55 cm) and front-camera fields of view (55–85°), synthesize
the four iris landmarks at their true 11.7 mm on the eye plane, run the
projected landmark set through the production
`extractMeasurementValues`, and compare the recovered millimetres to the
canonical face's true spans. The harness is checked in as
[`face-measurements.accuracy.test.ts`](../artifacts/cpap-fitter/src/lib/face-measurements.accuracy.test.ts),
so every future change to the measurement math re-verifies against
ground truth in CI.

## What the verification found

**1. The landmark pairs measure what they claim.** On the canonical
face: alar span (129–358) 35.7 mm, bridge→tip (6–4) 29.4 mm, tip→chin
(4–152) 89.4 mm, mouth corners (61–291) 49.1 mm — all inside
anthropometric windows. `faceWidthAtCheekbones` (234–454, 153.3 mm) is
really **head-silhouette width at ear level**, wider than true
bizygomatic breadth; the catalog's fit bands must use the same
convention. The 11.7 mm iris constant matches the ophthalmology
literature (horizontal visible iris diameter, adult mean ≈ 11.7 ± 0.5 mm).

**2. The iris calibration is a depth-plane calibration, and one span
paid for it.** `pxPerMm` from the iris fixes the scale **at the eye
plane**. Landmarks 234/454 sit ~59 mm _behind_ that plane, so the face
width under-read by **−13% at a 40 cm arm's length** (−17% at 28 cm,
−9% at 55 cm) — roughly 20 mm of headgear sizing, and distance-dependent
so no constant could fix it. Nose height over-read +5…+10% for the
mirror-image reason (the nose sits in front of the plane). Measured
end-to-end (uncorrected, frontal, FOV 68°):

| span                  | D=28 cm    | D=40 cm    | D=55 cm   |
| --------------------- | ---------- | ---------- | --------- |
| noseWidth             | +5.2%      | +3.6%      | +2.6%     |
| noseHeight            | +10.3%     | +7.0%      | +5.0%     |
| noseToChin            | +2.2%      | +1.5%      | +1.1%     |
| mouthWidth            | +3.0%      | +2.1%      | +1.5%     |
| faceWidthAtCheekbones | **−17.4%** | **−12.9%** | **−9.7%** |

**3. The multi-angle pose correction had the physics backwards.** The
iris is a circle: under yaw it foreshortens by the same cos(yaw) as any
horizontal span at its depth, so the two cancel in `px / pxPerMm` —
horizontal widths are _already_ yaw-invariant. Dividing them by cos(yaw)
again (the old `poseCorrect`) over-read every width from a 20° guided
turn frame by ~+6%; meanwhile vertical spans — the ones actually
inflated by the shrunken iris — got no yaw correction at all. Simulating
the guided front/left-20°/right-20° flow end-to-end, the old aggregation
landed **+5…+11% high on every measurement**.

**4. Turned frames can't be trusted for measurement at all.** Two
independent reasons, one per axis. Heights: at 20° of yaw the nose's
own depth swings through the image plane and tip-referenced heights
read +10…+18% — outside the small-angle cos model entirely. Widths
(surfaced by automated review of this PR, and correct): whether the
iris calibration self-corrects a turned width depends on **gaze**. The
iris only foreshortens with the head when the eyes turn with it; a
patient watching the on-screen coach counter-rotates their eyes, the
iris stays camera-facing, and the width then reads ~cos(yaw) ≈ 6% low
at the 20° turn poses — indistinguishable, from landmarks alone, from
the case the rigid-face model verifies. The synthetic harness cannot
represent independent eye rotation, so turned-frame widths carry an
irreducible ±6% gaze ambiguity.

## What changed

1. **Perspective depth-plane correction**
   ([`face-measurements.ts`](../artifacts/cpap-fitter/src/lib/face-measurements.ts),
   now the single home of the measurement math for the single-shot,
   burst, and guided paths). Each span is rescaled from its own depth
   plane back to the eye plane using MediaPipe's per-landmark z
   (relative depth, x-scaled → millimetres via the existing calibration)
   and a camera distance estimated from the iris pixel size under an
   assumed 68° front-camera FOV. The FOV assumption only scales the
   correction, not the measurement. Defensive by construction: clamped
   to [0.85, 1.25], skipped for implausible depth offsets, and any
   landmark set without z (older runtimes, test stubs) degrades to the
   uncorrected arithmetic. `noseToChin` is deliberately left raw — its
   endpoints span ~33 mm of depth, the single-plane model over-corrects
   it, and its uncorrected frontal error was already the smallest (≲2%).

   Corrected accuracy, same conditions as the table above: **every span
   within ±3.5%** at the assumed FOV across 28–55 cm, and within ±7%
   even when the true FOV is 55° or 85°.

2. **Pose-correction physics fixed**
   ([`scan-quality.ts`](../artifacts/cpap-fitter/src/lib/scan-quality.ts)):
   horizontal spans are no longer divided by cos(yaw) (the rigid-face
   double-correction); vertical spans are multiplied by cos(yaw) and
   still divided by cos(pitch). Same 30° clamp. Because of the gaze
   ambiguity (finding 4), yaw correction now matters only in the
   no-near-frontal-frame fallback; the pitch correction is
   gaze-independent (the iris's horizontal diameter — the calibration —
   is unaffected by pitch regardless of where the eyes point).

   _Updated 2026-08-30:_ `noseToChin` no longer uses the cos(pitch)
   factor when the frame's pitch came from MediaPipe's transformation
   matrix — see the pitch entry under **Known residual limitations**.
   Every other vertical span, and every geometric-pitch frame, is
   unchanged.

3. **Measurements sample near-frontal frames only** (`|yaw| ≤ 10°`,
   where the gaze ambiguity is ≤ ~1.5%), on BOTH axes, with a fall-back
   to all frames when none qualifies. Turned frames still contribute
   capture-quality evidence but no measurement samples. Simulated
   guided-flow error drops from +5…+11% to **≈0…+3.5%**.

4. **High confidence requires two samples of every measurement.** The
   aggregate caps its band at "moderate" whenever ANY measurement rests
   on a single sample — previously the frame-count bonus plus the
   widths' agreement could carry a set whose heights were single-
   sampled into the high band (surfaced by automated review). To keep
   the high band reachable, the guided flow now captures the front pose
   **twice** (front → front → turn → turn), giving every measurement
   genuine repeated near-frontal evidence; the one-tap burst gets 5.

5. **One-tap burst capture**
   ([`capture.tsx`](../artifacts/cpap-fitter/src/pages/capture.tsx)):
   the single "Take Photo" tap now captures 5 frames over ~560 ms —
   the customer experience is unchanged, but /measure drops any frame
   that fails its quality gates (a blink, a smear, a lighting flicker no
   longer force a full retake), medians the rest, and gains real
   cross-frame agreement evidence. That last part matters clinically:
   a lone frame is capped at the "moderate" scan band by design ("we
   only looked once"), which capped every default-path fitting below
   high confidence; a burst that genuinely agrees can now clear the
   high-confidence scan floor. Two guards keep the agreement honest: a
   frozen or very-low-frame-rate camera's byte-identical frames are
   deduplicated (one observation must not masquerade as five), and the
   burst motion check compares each frame against its immediate
   predecessor only, so one mid-burst jolt costs at most its
   neighbouring frames rather than poisoning every later one. Frames
   stay in memory only and are discarded after extraction — the same
   privacy promise as before.

6. **The face-width convention is now documented at the source.**
   `faceWidthAtCheekbones` measures the frontal face-silhouette width
   at landmarks 234/454, not caliper bizygomatic breadth. The 0486
   catalog seed ships **no** face-width bands (the field gates nothing
   today — verified); a tenant authoring `face_width_min/max_mm` bands
   later must calibrate them against this pipeline's own readings, and
   the code comment on the landmark table now says exactly that.

## Follow-up: the plausibility windows were never calibrated against this (2026-08-21)

The verification above measured the _arithmetic_ against ground truth
but left the **plausibility windows** — the millimetre gates that decide
whether a measurement is a face at all — on their original values, which
were authored from textbook norms rather than from this pipeline's own
readings. Two of them were wrong in the direction that rejects real
patients, and the failure is invisible from the outside: the patient is
told their measurements are outside the range we cover and handed to a
respiratory therapist, which looks exactly like the feature working.

1. **The adult `noseToChin` ceiling was 90 mm.** The canonical average
   adult measures **89.4 mm** on that span. An ordinary face, measured
   correctly, sat 0.6 mm inside the window — and since the corrected
   pipeline carries ±3.5% at the assumed FOV (≈ ±3 mm here), a
   better-than-average share of average adults read over 90 and landed
   `outside_validated_range`.

2. **The pediatric ceilings were set _below_ the adult ceilings**
   (`noseToChin` 70 mm, `faceWidthAtCheekbones` 150 mm). "Pediatric" is
   derived as age < 18 from the chart's date of birth, and a 17-year-old
   has a fully adult-sized face: the canonical adult falls **outside**
   the pediatric window on both spans. Every adolescent scanned through
   the pediatric path was rejected.

**What changed.** All three windows (adult, pediatric, and the adult ∪
pediatric union the population-blind callers apply) are re-derived from
the canonical face and now clear it by ≥25% on both edges — ~18% of
population spread (facial dimensions run SD ≈ 6% of the mean, so ±3 SD)
plus the 7% worst-case pipeline error bounded above. The pediatric
window is now the adult window **with the floor lowered and nothing
else**, so it is a strict superset by construction, and the union window
is _derived_ from the two rather than transcribed. The five hand-copied
copies of the table are down to two — the server's single definition in
`lib/fitting/confidence.ts`, and the client's `/measure` gate, which
cannot import across the workspace boundary.

**What prevents a recurrence.**
[`plausibility-windows.test.ts`](../artifacts/resupply-api/src/lib/fitting/plausibility-windows.test.ts)
asserts the canonical face sits inside every window with that margin,
and holds the superset invariant directly; the client's copy is pinned
the same way in `face-measurements.accuracy.test.ts`, which additionally
runs the real extractor across 28–55 cm and 55–85° and requires that
nothing it can produce from a well-captured average face is rejected by
the gate in front of it. Both defects fail that assertion.

**Also found, and worth knowing:** several test fixtures across the repo
described a "typical adult face" with a `noseHeight` of 45–50 mm. That
is the textbook **nasion→subnasale** span; this pipeline measures
**bridge (landmark 6) → tip (4)**, ~29 mm on the same face. The fixtures
on the fitting paths are now anchored to the canonical face. The same
confusion is worth checking wherever a tenant authors mask size bands —
`face_width_min/max_mm` and friends must be calibrated against this
pipeline's readings, per finding 6 above.

## Known residual limitations (documented, not hidden)

- **Pitch — half fixed (2026-08-30).** The transformation-matrix pitch
  estimate this section called future work now exists
  (`resolveFramePose`), and `noseToChin` — the span that gates every
  full-face size — is corrected for the depth lever rather than by
  cos alone. Two things made that possible: MediaPipe's rigid-body
  matrix carries no anatomy confound (the geometric estimator reads
  **+5.4° on a perfectly level canonical face**, which is why the
  correction is matrix-only and `resolveFramePose` falls back to
  geometric on any sign or magnitude disagreement), and the harness
  measured the projection ratio directly:
  `cos t − K(D)·sin t`, with `K(D) = 0.372 + 158/D` mm — the constant
  being the span's own 33.23/89.40 depth ratio, recovered from the fit
  without being given it, and the 1/D term the perspective that roughly
  doubles the effect at arm's length. Corrected error at ±6° and ±10° of
  pitch is strictly smaller than uncorrected and stays inside ±3.5%; the
  correction is exactly inert at 0° and clamped past 15°.

  What remains: **`noseHeight` is still cos-only.** Its endpoints carry
  their own, different depth ratio (~0.61), so it needs its own pass
  through the harness rather than a shared constant — deliberately one
  span at a time. Its ±8° residual is unchanged (~±10%), still bounded
  by the pose gate and still visible to the patient in the /measure
  readout.

- The depth correction inherits MediaPipe's z quality ("roughly the
  same scale as x"); the clamp and the per-key gating bound the damage
  of a bad z, and a missing z falls back cleanly.
- The assumed 68° FOV is a population assumption, not per-device truth;
  the tests bound the residual across 55–85°. Reading the actual FOV
  from `MediaStreamTrack.getCapabilities()` where browsers expose it is
  a possible refinement.
