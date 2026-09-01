# Runbook — physical-device validation of the mask fitter

**Owner:** whoever is releasing a change to the capture or measurement
path.
**Status: NOT PERFORMED.** No row in the matrix below has been completed.
Nothing in the product may say "Physical Validation Passed".

---

## The question this answers

`poseFromFacialTransformationMatrix` reads MediaPipe's facial
transformation matrix **column-major** and extracts Tait-Bryan angles in
an **assumed sign convention**. Neither assumption is stated in the
tasks-vision documentation, and a WASM build can change it.

If **pitch is reversed** on some device, the consequence is not noise.
`noseToChinPitchFactor` is deliberately **asymmetric** in the sign of
pitch — the nose-to-chin span runs ~33 mm through the face's depth as
well as ~89 mm down its front, so pitching the head swings the chin
toward or away from the camera, and chin-down _shortens_ the projected
span while chin-up _lengthens_ it. A plain `cos(pitch)` cannot express
that at all (cosine is even). A reversed sign therefore drives the
correction in exactly the wrong direction and roughly **doubles** the
error it exists to remove.

### What already protects a patient

`resolveFramePose` refuses a matrix that disagrees with the geometric
estimate — on yaw SIGN at a meaningful turn, and on pitch beyond
`MATRIX_GEO_PITCH_AGREEMENT_DEG` (12°). A reversed convention therefore
**degrades to the geometric estimator**, which is noisier but never
wrong-signed, and the depth-aware correction refuses to run on an
estimate it does not trust.

So the risk is contained. What is missing is **knowing**: a rejected
matrix is indistinguishable from a runtime that never emitted one, so
today nobody can tell a device where the matrix is helping from one where
it is silently being thrown away.

---

## The instrument

```
/internal/pose-diagnostics
```

Registered **only in non-production builds** (`!import.meta.env.PROD`),
unlinked from every patient surface. Roughly ninety seconds.

**It captures no image.** The preview is live and is never written to a
canvas that is read back — deliberately, because the moment a frame lands
in an `ImageData` buffer, "no image is captured" stops being structurally
true and becomes a promise about what nobody does with the buffer. Frame
usability is judged from landmark geometry instead. The module that
computes the verdict (`lib/pose-diagnostics.ts`) is never handed an image
at all.

Retention requires an explicit tick before the camera starts, and the
export is a client-side CSV download of **angles only**. Nothing is
transmitted anywhere.

### The sequence

| #   | Step                            | Axis  | Expected matrix sign | Minimum movement |
| --- | ------------------------------- | ----- | -------------------- | ---------------- |
| 1   | Look straight ahead, hold still | —     | baseline             | —                |
| 2   | Raise your chin                 | pitch | **positive**         | 8°               |
| 3   | Lower your chin                 | pitch | **negative**         | 8°               |
| 4   | Turn to YOUR left               | yaw   | **positive**         | 8°               |
| 5   | Turn to YOUR right              | yaw   | **negative**         | 8°               |
| 6   | Left ear toward left shoulder   | roll  | **positive**         | 6°               |
| 7   | Right ear toward right shoulder | roll  | **negative**         | 6°               |

Both directions of each axis are required. One direction agreeing proves
very little: a matrix stuck at zero, or one reporting magnitude without
sign, passes a single-direction check.

Step 1 establishes the **resting offset**. Someone holding a phone rests
their head several degrees off level, and each estimate is corrected
against its **own** baseline — the geometric pitch estimator reads about
+5° on a level head by construction (the anatomy confound
`PITCH_GRACE_DEG` exists for), and subtracting the matrix's offset from it
would import that error.

### Verdicts

| Verdict        | Meaning                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `agreed`       | Both directions matched the assumed convention.                                                                                       |
| `reversed`     | Both directions were the opposite sign. **The convention is wrong on this device.**                                                   |
| `inconsistent` | One direction right, the other wrong. The matrix is probably not tracking that axis at all — **do not "fix" this with a minus sign.** |
| `inconclusive` | The head did not move far enough. **Not a pass.** Re-run with a fuller movement.                                                      |
| `no_matrix`    | The runtime emitted no matrix. The designed fallback; the fitter still works, less precisely.                                         |

Also reported: **matrix acceptance rate** — the share of usable frames
where `resolveFramePose` actually took the matrix. Zero acceptance with a
`reversed` verdict is the gate doing its job.

---

## The device matrix

Every row needs its own run. **A pass on one device is not evidence about
any other**; the report says so in as many words, because that is the
specific false generalisation this table exists to prevent.

| #   | Device                 | OS          | Browser | Priority                                  | Status    | Date | Session id | Pitch | Yaw | Roll | Accept % | By  |
| --- | ---------------------- | ----------- | ------- | ----------------------------------------- | --------- | ---- | ---------- | ----- | --- | ---- | -------- | --- |
| 1   | iPhone (current gen)   | iOS 18+     | Safari  | **P0** — the majority of patient captures | ☐ not run |      |            |       |     |      |          |     |
| 2   | iPhone (2–3 gen older) | iOS 17      | Safari  | **P0** — the oldest supported build       | ☐ not run |      |            |       |     |      |          |     |
| 3   | Android flagship       | Android 14+ | Chrome  | **P0**                                    | ☐ not run |      |            |       |     |      |          |     |
| 4   | Android mid-range      | Android 13+ | Chrome  | P1 — CPU delegate is likelier here        | ☐ not run |      |            |       |     |      |          |     |
| 5   | Desktop / laptop       | macOS       | Chrome  | P1 — the clinic-side path                 | ☐ not run |      |            |       |     |      |          |     |
| 6   | Desktop / laptop       | macOS       | Safari  | P1                                        | ☐ not run |      |            |       |     |      |          |     |
| 7   | Desktop / laptop       | Windows     | Edge    | P2                                        | ☐ not run |      |            |       |     |      |          |     |
| 8   | iPad                   | iPadOS 18   | Safari  | P2                                        | ☐ not run |      |            |       |     |      |          |     |

**Pass/fail thresholds for a row:**

- Every axis `agreed`. Any `reversed` or `inconsistent` **fails** the row.
- `inconclusive` on any axis means the run did not happen — re-run, do
  not record it.
- Matrix acceptance ≥ 50%. Below that, `resolveFramePose`'s gates are
  firing often enough that the convention may be partially wrong even
  where the sign check passed.
- Attach the CSV to the validation ticket.

---

## The release gate

**This gate is not satisfied.** No row above is complete.

A change is allowed to ship _without_ physical validation as long as the
matrix stays **advisory** — which it is today, and which is the whole
reason a reversed convention is not currently a patient-safety issue:

- `resolveFramePose` must keep both agreement gates.
- The depth-aware `noseToChinPitchFactor` must stay **matrix-only**.
- The geometric estimator must remain the fallback for every frame the
  gates reject.

A change is **blocked** until rows 1–3 (the P0 set) pass if it would:

- remove or widen either agreement gate;
- let the depth-aware correction run on a geometric pitch;
- make the matrix authoritative for any measurement;
- change `MATRIX_GEO_PITCH_AGREEMENT_DEG`, `PITCH_GRACE_DEG`, or the
  sign convention in `poseFromFacialTransformationMatrix`.

**Do not modify a clinical sizing threshold to make a validation run
pass.** If the numbers disagree, the numbers are the finding.

---

## What is covered without a device

Automated, and running in CI today:

- `lib/pose-diagnostics.test.ts` — the whole verdict machine against
  mocked frames: correct convention, reversed pitch/yaw/roll, a wholly
  inverted matrix, a matrix not tracking an axis, a matrix stuck at zero,
  a missing matrix, insufficient movement, saturated angles, resting-offset
  correction, per-estimate baselines, and low-quality frames.
- `lib/scan-quality.test.ts` — `poseFromFacialTransformationMatrix` and
  `resolveFramePose` directly: a known rotation read back per axis, zero
  / positive / negative pitch, a reversed convention, a conflicting
  geometric estimate, saturated angles, four malformed shapes, and that
  it never throws on junk.

None of that is evidence about a real MediaPipe WASM build on a real
device, and this document does not present it as such.

---

## If a run comes back `reversed`

1. **Do not flip a sign and ship it.** The convention could differ by
   device, and a global flip would break every device where it is
   currently right.
2. Record the row. Run the other P0 devices — the answer to "is this
   universal or device-specific" changes the fix entirely.
3. Confirm the matrix is being rejected: acceptance rate should be near
   zero. If it is not, the agreement gates are letting a reversed matrix
   through, and **that** is the urgent bug.
4. The fitter is not broken meanwhile. It is running on the geometric
   estimator, which is what it did before the matrix was introduced.

---

## Related

- [`../scan-accuracy-verification-2026-08-20.md`](../scan-accuracy-verification-2026-08-20.md)
- [`../virtual-fitter-review-2026-08-21.md`](../virtual-fitter-review-2026-08-21.md)
- [`../reviews/external-validation-checklist.md`](../reviews/external-validation-checklist.md)
