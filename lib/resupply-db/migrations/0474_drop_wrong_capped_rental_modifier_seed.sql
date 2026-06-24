-- Migration 0474: drop the incorrect capped-rental modifier-rotation seed rows.
--
-- Migration 0130 seeded payer_modifier_rules for the Medicare DME MAC with a
-- capped-rental rotation that is WRONG per the CMS / Noridian capped-rental
-- modifier sequence, and that the per-condition rule engine cannot express
-- correctly anyway:
--
--   seeded (0130)                       CMS-correct (Noridian capped rental)
--   ----------------------------------  ------------------------------------
--   months 1-3  -> KH                   month 1     -> KH
--   months 4+   -> KI, KX               months 2-3  -> KI
--                                       months 4-13 -> KJ  (+ KX only when
--                                                           adherence proven)
--
-- Two defects: (a) the single coarse `if_rental_month_le_3` condition cannot
-- split month 1 (KH) from months 2-3 (KI); (b) the 4+ row used KI (continuing)
-- where CMS requires KJ, and bundled KX unconditionally, where KX must be gated
-- on documented 90-day adherence. A one-condition rule cannot express the
-- "month>=4 AND compliant" conjunction KX needs.
--
-- The correct rotation already lives in the shared, tested
-- pickCappedRentalModifiers() (lib/resupply-domain/src/capped-rental.ts), which
-- the capped-rental auto-advance worker uses. As of this change the manual
-- claim builder (artifacts/resupply-api/src/lib/billing/claim-builder.ts) also
-- derives the rotation for these codes from that same function, making it the
-- single source of truth. Removing the bad seed rows prevents them from
-- double-applying a stale KI alongside the correct KJ.
--
-- Guarded to the ORIGINAL seeded values so any operator-customised row is left
-- untouched (migration 0130 called the seed "starter content ... override per
-- row"). Re-running is a no-op (idempotent DELETE).

DELETE FROM "resupply"."payer_modifier_rules" r
USING "resupply"."payer_profiles" p
WHERE r.payer_profile_id = p.id
  AND p.slug = 'medicare_dme_noridian'
  AND r.hcpcs_code IN ('E0601', 'E0470', 'E0471')
  AND (
    (r.condition = 'if_rental_month_le_3' AND r.modifiers_csv = 'KH')
    OR (r.condition = 'if_rental_month_ge_4' AND r.modifiers_csv = 'KI,KX')
  );
