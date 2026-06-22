// Advanced-billing admin handlers — the deeper revenue-cycle surfaces
// beyond the core claims workflow seeded in billing-claims.ts. These
// answer the GETs that drive the Advanced Billing pages (claim-status,
// disputes, secondary/COB, payment plans, timely-filing, fee schedules,
// modifier rules, AI queue, action queue, denial codes, eligibility
// re-verification, GFEs, PECOS, DWO renewals, appeals, collections
// forecast) so they render real data instead of the router's empty-object
// fallback, plus a handful of benign POST/PUT/PATCH mutations the seeded
// pages let a visitor click.
//
// Paths intentionally do NOT overlap billing-claims.ts (eligibility-recent,
// era-files, denials-worklist, auto-submit/*, statements/*).

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import {
  demoAiBillingQueue,
  demoBillingActionQueue,
  demoBillingDisputes,
  demoClaimAppealLetters,
  demoClaimDenialSketch,
  demoClaimStatusCheckSubmit,
  demoClaimStatusChecks,
  demoCollectionsForecast,
  demoDenialCodes,
  demoDwoExpiring,
  demoEligibilityVerificationWorklist,
  demoForwardOrderBook,
  demoGenerateSecondary,
  demoGoodFaithEstimates,
  demoPayerFeeSchedules,
  demoPayerModifierRules,
  demoPaymentPlanDetail,
  demoPaymentPlansList,
  demoPecosStatus,
  demoSecondaryEligible,
  demoTimelyFiling,
} from "../fixtures/advanced-billing";

export const advancedBillingHandlers: DemoHandler[] = [
  // ── claim-status (276/277) ──────────────────────────────────────────
  route(
    "GET",
    "/resupply-api/admin/patients/:id/insurance-claims/:claimId/status-checks",
    () => json(demoClaimStatusChecks()),
  ),
  route(
    "POST",
    "/resupply-api/admin/patients/:id/insurance-claims/:claimId/status-check",
    () => json(demoClaimStatusCheckSubmit(), 201),
  ),

  // ── chargeback disputes ─────────────────────────────────────────────
  route("GET", "/resupply-api/admin/billing/disputes", (req) =>
    json(demoBillingDisputes(req.query.get("status"))),
  ),

  // ── secondary / COB ─────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/billing/secondary-eligible", () =>
    json(demoSecondaryEligible()),
  ),
  route("POST", "/resupply-api/admin/claims/:id/generate-secondary", () =>
    json(demoGenerateSecondary(), 201),
  ),

  // ── payment plans ───────────────────────────────────────────────────
  route("POST", "/resupply-api/admin/patients/payment-plans/list", () =>
    json(demoPaymentPlansList()),
  ),
  route("GET", "/resupply-api/admin/payment-plans/:id", (_req, params) =>
    json(demoPaymentPlanDetail(params.id)),
  ),
  route("POST", "/resupply-api/admin/patients/:patientId/payment-plans", () =>
    // 201 { id, installments } — installments aren't dereferenced
    // beyond .length on the success toast, so an empty list is safe.
    json({ id: "demo-plan-new", installments: [] }, 201),
  ),
  route("PATCH", "/resupply-api/admin/payment-plans/:id", () =>
    json({ ok: true, status: "cancelled" }),
  ),
  route("PATCH", "/resupply-api/admin/payment-plan-installments/:id", () =>
    json({ ok: true, planStatus: "active" }),
  ),

  // ── timely-filing worklist ──────────────────────────────────────────
  route("GET", "/resupply-api/admin/billing/timely-filing", (req) =>
    json(demoTimelyFiling(req.query.get("status"))),
  ),

  // ── payer fee schedules ─────────────────────────────────────────────
  route("GET", "/resupply-api/admin/payer-fee-schedules", () =>
    json(demoPayerFeeSchedules()),
  ),
  route("POST", "/resupply-api/admin/payer-fee-schedules", () =>
    json({ id: "demo-fee-new" }, 201),
  ),
  route("PATCH", "/resupply-api/admin/payer-fee-schedules/:id", () =>
    json({ ok: true }),
  ),

  // ── payer modifier rules ────────────────────────────────────────────
  route("GET", "/resupply-api/admin/payer-modifier-rules", () =>
    json(demoPayerModifierRules()),
  ),
  route("POST", "/resupply-api/admin/payer-modifier-rules", () =>
    json({ id: "demo-mod-new" }, 201),
  ),
  route("PATCH", "/resupply-api/admin/payer-modifier-rules/:id", () =>
    json({ ok: true }),
  ),

  // ── AI billing queue ────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/billing/ai-queue", () =>
    json(demoAiBillingQueue()),
  ),

  // ── cross-worklist action queue ─────────────────────────────────────
  route("GET", "/resupply-api/admin/billing/action-queue", () =>
    json(demoBillingActionQueue()),
  ),

  // ── denial-code (CARC/RARC) catalog ─────────────────────────────────
  route("GET", "/resupply-api/admin/denial-codes", () =>
    json(demoDenialCodes()),
  ),
  route("POST", "/resupply-api/admin/denial-codes", () =>
    json({ id: "demo-dc-new" }, 201),
  ),
  route("PATCH", "/resupply-api/admin/denial-codes/:id", () =>
    json({ ok: true }),
  ),

  // ── eligibility re-verification worklist ────────────────────────────
  route(
    "GET",
    "/resupply-api/admin/billing/eligibility-verification-worklist",
    () => json(demoEligibilityVerificationWorklist()),
  ),

  // ── Good Faith Estimates ────────────────────────────────────────────
  route("GET", "/resupply-api/admin/good-faith-estimates", () =>
    json(demoGoodFaithEstimates()),
  ),

  // ── PECOS enrollment ────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/providers-pecos", () =>
    json(demoPecosStatus()),
  ),

  // ── DWO / CMN renewals ──────────────────────────────────────────────
  route("GET", "/resupply-api/admin/dwo-documents/expiring", () =>
    json(demoDwoExpiring()),
  ),

  // ── claim appeals ───────────────────────────────────────────────────
  route(
    "GET",
    "/resupply-api/admin/patients/:id/insurance-claims/:claimId/appeal-letter",
    () => json(demoClaimAppealLetters()),
  ),
  route(
    "GET",
    "/resupply-api/admin/patients/:id/insurance-claims/:claimId/denial-sketch",
    () => json(demoClaimDenialSketch()),
  ),

  // ── collections forecast (+ companion forward order book) ───────────
  route("GET", "/resupply-api/admin/billing/collections-forecast", () =>
    json(demoCollectionsForecast()),
  ),
  route("GET", "/resupply-api/admin/billing/forward-order-book", () =>
    json(demoForwardOrderBook()),
  ),
];
