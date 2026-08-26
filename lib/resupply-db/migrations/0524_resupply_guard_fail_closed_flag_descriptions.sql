-- 0524_resupply_guard_fail_closed_flag_descriptions — refresh Control
-- Center copy for order-confirm guards that now fail closed on lookup
-- errors.
--
-- Why
-- ---
-- Migration 0523 + order-flow changed enforcement-flagged guards so a
-- DB/network lookup error HOLDS the confirm (guard_lookup_error) instead
-- of shipping. The seeded feature_flags.description rows still said
-- "any lookup error allows the order / fails open", which is what the
-- admin Control Center shows operators deciding whether to flip the
-- flag. Update the live per-tenant rows to match the new semantics.
--
-- Fail-open BY OMISSION is unchanged (unmapped SKU, no coverage on
-- file, sparse therapy data, no/stale 271) and stays in the copy.
--
-- Idempotent: UPDATE … WHERE key = … sets the same text every time.
-- Per ADR 003 — versioned hand-authored migration. Does NOT touch the
-- 0523 CHECK constraint.

UPDATE "resupply"."feature_flags"
SET "description" =
  'Block a resupply confirmation when the item is not yet payable under the Medicare/payer replacement schedule (too soon since last dispense, or over the per-period quantity cap). When ON, a blocked reorder is routed to a CSR via a resupply_too_soon alert instead of shipping. When OFF, confirmations ship as before. Fail-open by omission: an unmapped SKU allows the confirmation. Fail-closed on lookup errors when ON (holds for CSR via resupply_guard_lookup_error).',
  "updated_at" = NOW()
WHERE "key" = 'resupply.entitlement_enforcement';
--> statement-breakpoint

UPDATE "resupply"."feature_flags"
SET "description" =
  'Consult the cached 270/271 eligibility result at order-confirm time. When ON and the patient confirms a resupply, an explicitly inactive plan or a prior-auth-required flag raises a resupply_coverage_blocked CSR alert and routes the order to the work queue instead of auto-shipping. Fail-open by omission: no coverage on file or no/stale parsed result allows the order. Fail-closed on lookup errors when ON (holds for CSR via resupply_guard_lookup_error). When OFF, the coverage check is skipped (cadence/quantity entitlement is gated separately by resupply.entitlement_enforcement).',
  "updated_at" = NOW()
WHERE "key" = 'resupply.eligibility_enforcement';
--> statement-breakpoint

UPDATE "resupply"."feature_flags"
SET "description" =
  'Continued-use check at resupply order-confirm time. When ON and the patient confirms a resupply, recent therapy data (patient_therapy_nights, last 30 days) showing the device is effectively unused raises a resupply_usage_review CSR alert and routes the order to the work queue instead of auto-shipping — protecting against continued-use claim denials. Fail-open by omission: no data or sparse data allows the order. Fail-closed on lookup errors when ON (holds for CSR via resupply_guard_lookup_error). When OFF, the check is skipped.',
  "updated_at" = NOW()
WHERE "key" = 'resupply.usage_compliance_check';
--> statement-breakpoint

UPDATE "resupply"."feature_flags"
SET "description" =
  'Enforce the CMS DMEPOS refill SHIP window at order-confirm time: block a resupply that would ship earlier than 10 days before the current supply''s expected depletion (last dispense + the HCPCS supply duration), routing it to a CSR via a resupply_refill_too_early alert instead of shipping. When OFF, the confirm-time interval/quantity entitlement guard is the only timing gate. Fail-open by omission: a first fill or an unmapped SKU allows the confirmation. Fail-closed on lookup errors when ON (holds for CSR via resupply_guard_lookup_error).',
  "updated_at" = NOW()
WHERE "key" = 'resupply.refill_window_enforcement';
--> statement-breakpoint
