# Virtual fitter review — capture, measurement, and both engines (2026-08-21)

An end-to-end correctness review of the virtual mask fitter, run after the
catalog-axis corrections landed (migrations `0510`/`0511`,
[`mask-fit-band-audit-2026-08-21.md`](./mask-fit-band-audit-2026-08-21.md)).
Scope: the browser capture + measurement pipeline, the clinical DB engine
(`/api/fit/assess`), and the legacy engine (`/api/recommend`). One
substantive gap was found and fixed; everything else verified sound. The
prior review of record is
[`virtual-mask-fitter-review-2026-08-20.md`](./virtual-mask-fitter-review-2026-08-20.md);
this pass is narrower and post-dates the band corrections.

## 1. Capture + measurement pipeline — verified sound

Reviewed: `face-measurements.ts`, `measure-flow.ts`, `scan-quality.ts`,
`scan-signals.ts`, the `/measure` wiring for the single-frame, burst, and
guided multi-angle paths.

What holds the accuracy, and the evidence for each piece:

- **Scale** comes from the iris (11.7 mm adult mean), averaged over both
  eyes so a single squint or glare cannot silently rescale every value.
- **Perspective depth-plane correction** rescales each span from its own
  depth to the eye plane; without it the cheekbone span under-reads
  10–17% at arm's length. Verified against pinhole projections of the
  canonical face across 28–55 cm and true FOVs of 55–85°:
  **worst case ±7%, ±2.5% near the assumed FOV**
  (`face-measurements.accuracy.test.ts`). `noseToChin` is deliberately
  uncorrected — its endpoint depths cancel and the single-plane model
  would over-correct it.
- **Pose correction** in the multi-frame aggregate is direction-correct:
  under yaw the iris foreshortens with the head, so horizontal spans
  self-correct and only vertical spans need cos(yaw); under pitch the
  roles flip. Frames past 10° of yaw contribute quality evidence but no
  measurement samples (the gaze/foreshortening ambiguity is unresolvable
  from landmarks alone past that).
- **Quality gates** (lighting balance, distance, pose, occlusion+blur,
  motion, framing) are multiplicative where it matters, the aggregate is
  a median (one bad frame in three cannot drag the answer), agreement is
  cross-frame spread, and hard floors stop a single look or a
  failed-gate frame from ever reading as high confidence.
- **Plausibility windows** reject non-faces (posters, screens, bad
  calibrations) client-side and server-side, calibrated to the canonical
  face with ≥25% margin per bound.

Verdict: no defects found. Within a browser/MediaPipe approach this is
near the practical ceiling — the remaining error budget is dominated by
landmark localisation noise, which multi-frame medians already attack.
The one _systematic_ accuracy risk left is the mask-side data, which is
what 0510/0511 addressed.

## 2. Clinical engine — one gap found and fixed

Reviewed: tiers 1–6 (`tiers.ts`), `confidence.ts`, `formulary.ts`,
`index.ts` (assembly + alternatives), the `fit-assess` route.

Verified sound: the tier order and hard-filter semantics (safety and
therapy incompatibilities are removals, not score penalties — a
contraindicated mask cannot be out-scored back in); the fail-closed
magnet paths (unloadable screen ⇒ all magnetic masks withheld; unasked
questions ⇒ assessment withheld); pediatric/adult service-line
separation; NIV/vent circuit rules; pressure-rating exclusion under
gating; deterministic tie-breaks so the recommended mask and size cannot
flip between reloads; commercial signals (formulary, stock, margin,
brand) bounded and excluded from patient-facing confidence by
construction.

**The gap.** `resolveConfidence`'s own contract says confidence reflects
"how well the winning size sits in its band" — but the winner's band
verdict only reached the score through the facial-fit term (0.45 of the
clinical blend), which strong patient-factor scores can outweigh. The
whole-field `outside_validated_range` gate fires only when **every**
candidate is out of band. Consequence: a patient measurably outside
every size of the top-ranked mask could still be told "clear match — go
ahead and order" (`high_confidence` skips the review queue entirely),
with the size choice quietly flagged `inBand: false` in data nobody is
forced to look at. The same applied to a mask with no sizing geometry at
all, whose fallback size is a guess by construction.

**The fix** (`confidence.ts`): when gating is on and the top pick's
chosen size is not geometry-confirmed, the outcome caps at
`moderate_confidence`. Downstream that is exactly the right posture: the
patient still gets the recommendation and can still order, but the
fitting lands `awaiting_review` / `pending_review` instead of
`recommended` / `not_required` — a clinician confirms the size before it
ships. It only ever downgrades, changes nothing with gating off, and is
pinned by five new cases in `confidence.test.ts`.

Considered and rejected: sorting in-band candidates above out-of-band
ones outright. Band membership is per-interface (a pillow gates on one
dimension, a full face on three), so a hard sort would systematically
push nasal pillows above full-face masks for cross-dimension faces —
including mouth-breathers, for whom that is clinically backwards. The
tier-4 factors are the right authority on interface; the confidence cap
is the right authority on "don't ship an unconfirmed size unreviewed".

## 3. Legacy engine (`/api/recommend`) — sound after the wave-2 rewrite

Reviewed: `recommendationEngine.ts` end to end against the rewritten
`maskCatalog.ts`.

- Scoring: with the envelope fit ranges, every plausible face scores 1.0
  on geometry for every mask, so ranking is driven by the questionnaire
  type weights and contraindications — which was always the honest
  content of this engine (its per-model geometry was invented, on the
  wrong axis, and systematically de-ranked full-face masks; see the
  audit doc §"the legacy storefront engine had the same defect").
- Sizing: the linear partition of the envelope reproduces the DB
  catalog's per-size bands (same anchor, same ±18% envelope; the band
  overlap midpoints are the partition boundaries). Spot-checked
  divergences: only faces at the exact centre of a two-size overlap can
  resolve differently between engines (e.g. Brevida XS-S vs M-L at
  precisely the population mean), which is inherent tie ambiguity, not
  error.
- Contraindicated masks are ×0.15 and excluded from the top-3;
  magnet-hardware detection, the pressure-rating soft gate, and the
  out-of-envelope "professional sizing" wording (now reachable only by
  genuine ±3 SD outliers) all verified.
- `maskCatalog.conventions.test.ts` pins: every entry carries the
  envelope; the canonical adult face is never told it is a marginal fit
  and never clamps to an end size on any 3+ size run; the verified size
  runs; the fabricated model stays gone.

## 4. What "fits perfectly" means here, stated once

The engine recommends the best-ranked mask **among those that survive
the safety and therapy filters**, sizes it from the measurement bands,
and now guarantees: a recommendation whose size the geometry does not
confirm is never presented above moderate confidence and never skips
clinical review. It deliberately does **not** refuse to recommend
whenever the winner is out of band — the bands are ±3 SD population
estimates, not manufacturer geometry, and a hard refusal would turn
band-edge faces away from masks a human fitter would happily seat. The
per-tenant RT sign-off (and the review queue the moderate outcome routes
through) remains the clinical gate, exactly as the provenance columns
(`fit_data_source`, migration 0495) intend.
