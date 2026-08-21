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

## Known residual limitations (documented, not hidden)

- **Pitch** remains the weakest axis for vertical spans: at ±8° (the
  front-pose gate's edge) tip-referenced heights can still err ~±10%,
  because the tip/chin depth geometry moves beyond what a cos model can
  express. The pose gate bounds it; the measurement readout on /measure
  lets the patient sanity-check; a transformation-matrix pitch estimate
  (rather than the anatomy-confounded geometric fallback) is future work.
- The depth correction inherits MediaPipe's z quality ("roughly the
  same scale as x"); the clamp and the per-key gating bound the damage
  of a bad z, and a missing z falls back cleanly.
- The assumed 68° FOV is a population assumption, not per-device truth;
  the tests bound the residual across 55–85°. Reading the actual FOV
  from `MediaStreamTrack.getCapabilities()` where browsers expose it is
  a possible refinement.
