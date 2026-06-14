-- 0325 — widen patient_smart_trigger_events.kind to the clinical rules.
--
-- Two things land here:
--
-- 1. BUG FIX. The original CHECK (migration 0047) only ever permitted
--    the four patient-facing nudge kinds:
--      leak_rising, usage_dropping, cushion_wear, humidifier_drop
--    But the rule library (lib/smart-triggers/index.ts) has since grown
--    two CLINICAL kinds — `ahi_elevated` and `non_adherent_30d` — that
--    the evaluator tries to INSERT. Those inserts violate the CHECK
--    (SQLSTATE 23514) and are swallowed by the evaluator's per-patient
--    error boundary, so every clinical signal the rules detected was
--    silently dropped instead of reaching the RT board. This widens the
--    constraint so they persist.
--
-- 2. NEW clinical signals derived from the imported manufacturer data:
--      * pressure_at_max — APAP pegged at the prescribed max pressure
--        with residual events (under-titrated → Rx/pressure review).
--      * ahi_rising      — AHI worsening *trend*, caught before it
--        crosses the absolute ahi_elevated alarm.
--      * usage_erratic   — binge-and-skip usage volatility (a decent
--        average hiding wild night-to-night swings).
--
-- All clinical kinds are RT-owned: the dispatcher (PATIENT_DISPATCH_KINDS)
-- never auto-messages them to patients; they surface on the RT board and
-- patient-detail therapy tab for a clinician to action.
--
-- Idempotent: drop the old constraint if present, add the widened one.
-- The kind column type is unchanged (text), so this is metadata-only —
-- no table rewrite, no lock beyond the brief ACCESS EXCLUSIVE for the
-- constraint swap.

ALTER TABLE "resupply"."patient_smart_trigger_events"
  DROP CONSTRAINT IF EXISTS "patient_smart_trigger_events_kind_enum";
--> statement-breakpoint

ALTER TABLE "resupply"."patient_smart_trigger_events"
  ADD CONSTRAINT "patient_smart_trigger_events_kind_enum"
  CHECK (
    "kind" IN (
      'leak_rising',
      'usage_dropping',
      'cushion_wear',
      'humidifier_drop',
      'ahi_elevated',
      'non_adherent_30d',
      'pressure_at_max',
      'ahi_rising',
      'usage_erratic'
    )
  );
