-- 0504_multiframe_capture_flag_active — the guided multi-angle capture
-- shipped, so `fitter.multiframe_capture` is no longer a no-op toggle.
--
-- 0503 stamped this flag's description "NOT YET ACTIVE in this build —
-- capture is single-frame today, so this toggle currently has no effect",
-- which was true then and is a lie now: the flag rides the invite-resolve
-- response to the SPA (routes/shop/fitter-invite.ts), and /capture renders
-- the guided three-angle scan with live quality coaching when it is ON
-- (pages/capture-guided.tsx; aggregation in pages/measure.tsx via
-- aggregateFrames). Update the operator-facing description to match.
--
-- The flag stays OFF by default — it is patient-visible and lengthens the
-- capture step, so turning it on remains a deliberate per-tenant opt-in
-- (see docs/runbooks/activate-clinical-fitter.md §B5).
--
-- Idempotent: a keyed UPDATE, safe to re-run. Per ADR 003 — versioned
-- hand-authored migration.

UPDATE "resupply"."feature_flags"
SET "description" =
  'Guided multi-angle scan capture: a live coach walks the patient '
  || 'through three angles (front, then a slight turn each way) with '
  || 'real-time quality checks (lighting, distance, head position, '
  || 'obstruction, movement), and the measurements are cross-checked '
  || 'across frames for agreement — producing a measurement confidence '
  || 'score instead of a single unverified snapshot. Falls back to '
  || 'single-frame capture automatically on devices that cannot run the '
  || 'live face tracker. OFF keeps the one-photo capture.'
WHERE "key" = 'fitter.multiframe_capture';
