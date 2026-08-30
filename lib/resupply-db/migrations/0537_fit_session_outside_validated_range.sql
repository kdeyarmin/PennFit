-- 0537_fit_session_outside_validated_range — record that EVERY candidate
-- missed a size band, not just the winner.
--
-- Why
-- ---
-- `resolveConfidence` used to withhold the whole recommendation when no
-- candidate landed inside any size band, and that turned ordinary
-- patients into dead ends: bands are partitioned per dimension across
-- each size run, so a patient sitting in the MEDIUM bucket on one axis
-- and the SMALL bucket on another matches no single size. Observed in
-- production on a flawless scan whose every measurement was comfortably
-- inside the adult window, and on 32 of the 33 mouth-covering adult
-- masks for that fitting. The engine now recommends the closest size,
-- capped at moderate and routed to clinical review, instead of naming
-- nothing.
--
-- That fix removes the verdict's role as a GATE, which is right, but it
-- must not remove the verdict. One unconfirmed winner and every
-- candidate missing look identical in the stored record once you only
-- keep per-candidate `inBand` flags — and they have different causes and
-- different fixes. The first is a fitting question. A run of the second
-- is a statement about the catalog's geometry, and it is exactly the
-- signal that would surface a band-calibration problem before it is
-- inferred from a pile of moderate-confidence sessions.
--
-- Nullable, no default backfill: rows written before this column existed
-- genuinely do not know the answer, and NULL says that honestly where
-- `false` would assert something the engine never recorded.
--
-- PHI: none. A boolean about catalog coverage.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."fit_sessions"
  ADD COLUMN IF NOT EXISTS "outside_validated_range" boolean;
--> statement-breakpoint

COMMENT ON COLUMN "resupply"."fit_sessions"."outside_validated_range" IS
  'True when every ranked candidate''s best size missed at least one gated dimension. Records catalog coverage, not patient suitability; no longer gates the recommendation. NULL on rows predating migration 0537.';
