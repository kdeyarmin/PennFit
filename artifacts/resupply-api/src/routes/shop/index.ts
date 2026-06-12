// Shop routes — patient-facing cash-pay catalog + checkout.
//
// All routes are PUBLIC (no requireAdmin / no the auth provider gate). The Stripe
// Hosted Checkout pattern keeps card data out of our process; Stripe
// handles PCI scope. Order tracking rows live in resupply.shop_orders
// and are linked to Stripe by Session ID.

import { Router, type IRouter } from "express";

import cartSnapshotRouter from "./cart-snapshot";
import checkoutRouter from "./checkout";
import pickupLocationsRouter from "./pickup-locations";
import insuranceLeadRouter from "./insurance-lead";
import fitterLeadRouter from "./fitter-lead";
import fitterCompleteRouter from "./fitter-complete";
import fitterInviteRouter from "./fitter-invite";
import quizLeadRouter from "./quiz-lead";
import insuranceEstimateRouter from "./insurance-estimate";
import npsResponseRouter from "./nps-response";
import maskFitResponseRouter from "./mask-fit-response";
import educationVideosRouter from "./education-videos";
import backInStockRouter from "./back-in-stock";
import meRouter from "./me";
import meClinicalInfoRouter from "./me-clinical-info";
import meChatRouter from "./me-chat";
import meCommPrefsRouter from "./me-comm-prefs";
import meDashboardRouter from "./me-dashboard";
import meMessagesRouter from "./me-messages";
import meExportRouter from "./me-export";
import meReorderSuggestionsRouter from "./me-reorder-suggestions";
import myOrdersRouter from "./my-orders";
import myReturnsRouter from "./my-returns";
import mySubscriptionsRouter from "./my-subscriptions";
import orderRouter from "./order";
import orderPodRouter from "./order-pod";
import productsRouter from "./products";
import quickCheckoutRouter from "./quick-checkout";
import resendReceiptRouter from "./resend-receipt";
import reviewsRouter from "./reviews";
import productQuestionsRouter from "./product-questions";
import productCompatibilityRouter from "./product-compatibility";
import mePushSubscriptionsRouter from "./me-push-subscriptions";
import meInsightsRouter from "./me-insights";
import meTherapySummaryRouter from "./me-therapy-summary";
import meMaintenanceRouter from "./me-maintenance";
import meSubstitutionsRouter from "./me-substitutions";
import meEducationFeedRouter from "./me-education-feed";
import meQuarterlySummaryRouter from "./me-quarterly-summary";
import meLossClaimRouter from "./me-loss-claim";
import validateAddressRouter from "./validate-address";
import meEquipmentRouter from "./me-equipment";
import meInsuranceRouter from "./me-insurance";
import meSleepStudyRouter from "./me-sleep-study";
import meFormAcknowledgementsRouter from "./me-form-acknowledgements";
import meReferralsRouter from "./me-referrals";
import meDocumentsRouter from "./me-documents";
import meBillingPortalRouter from "./me-billing-portal";
import meCaregiverRouter from "./me-caregiver";

const router: IRouter = Router();
router.use(productsRouter);
router.use(checkoutRouter);
// /shop/pickup-locations — public list of in-store pickup options +
// an `enabled` flag (gated by the storefront.pickup feature flag and
// the presence of at least one active location).
router.use(pickupLocationsRouter);
router.use(orderRouter);
router.use(orderPodRouter);
// /shop/me/* — auth-aware patient account endpoints. Mounted
// alongside the public catalog so the frontend can reach both with
// the same base path. The handlers themselves apply the auth provider gating
// (requireSignedIn / attachSignedIn) per-endpoint.
router.use(meRouter);
router.use(meClinicalInfoRouter);
router.use(meCommPrefsRouter);
router.use(meDashboardRouter);
router.use(meMessagesRouter);
// /shop/me/chat — signed-in customer support chatbot (PennBot
// Account Assistant). Authenticated cousin of /api/chat: includes
// thin per-caller account context in the system prompt and exposes
// DB-backed tools (recent orders, order details, subscriptions,
// saved device) scoped to the caller. SSE-streamed by default.
router.use(meChatRouter);
// /shop/me/push-subscriptions/* — W3C Web Push registration
// (Phase C.1). Subscribe / unsubscribe / list endpoints; the
// VAPID public-key getter sits behind the same auth gate.
router.use(mePushSubscriptionsRouter);
// /shop/me/insights — customer-facing view of detected
// smart-trigger events (Phase G.4). Email-matched lookup against
// patient_smart_trigger_events; empty when no patient row matches.
router.use(meInsightsRouter);
// /shop/me/therapy-summary — patient-facing 30-night CPAP usage rollup
// (avg hours, AHI, leak, Medicare-style adherence rate). Email-matched
// against patients.email like /shop/me/insights; empty response when
// no patient row matches or no nights are imported yet.
router.use(meTherapySummaryRouter);
// /shop/me/maintenance — patient-facing hygiene checklist. Cadence
// catalog lives in code (lib/patient-maintenance/catalog.ts); per-
// patient completion log lives in resupply.patient_maintenance_log.
router.use(meMaintenanceRouter);
// /shop/me/substitutions — patient-facing notice of recent
// resupply substitutions (we shipped X because Y was backordered).
// Reads fulfillments.substituted_from_sku for the last 180 days.
router.use(meSubstitutionsRouter);
// /shop/me/education-feed — onboarding-stage-personalized
// education feed. Stage = days since first therapy night (or
// patient.created_at when no nights yet).
router.use(meEducationFeedRouter);
// /shop/me/quarterly-summary — print-friendly 90-day therapy
// rollup the patient can share with their sleep MD.
router.use(meQuarterlySummaryRouter);
// /shop/me/orders/:orderId/loss-claim — patient self-reports a paid
// shipped order never arrived. Opens a shop_order_loss_claims row
// for the CSR queue (does not auto-issue a refund).
router.use(meLossClaimRouter);
// /shop/validate-address — pre-checkout shipping-address probe.
// Heuristic-only today; pluggable for a future Smarty/USPS adapter.
router.use(validateAddressRouter);
// /shop/me/equipment — patient-facing CPAP/equipment registry.
// Patients can self-register devices for the recall workflow.
router.use(meEquipmentRouter);
// /shop/me/insurance — patient-facing primary-coverage view + update.
// Every patient update clears verified_at so the CSR queue re-verifies.
router.use(meInsuranceRouter);
// /shop/me/sleep-study — patient self-reports the structured findings
// from a sleep study (AHI, date, type). CSR verifies before LCD gating.
router.use(meSleepStudyRouter);
// /shop/me/form-acknowledgements — e-sign of HIPAA NPP / AOB / ABN /
// Financial Responsibility / Supplier Standards intake forms.
router.use(meFormAcknowledgementsRouter);
// /shop/me/referrals — patient-to-patient word-of-mouth referral codes.
router.use(meReferralsRouter);
// /shop/me/documents/* — patient self-service document upload.
// Patients upload insurance cards, prescriptions, etc. for CSR review.
router.use(meDocumentsRouter);
// /shop/me/billing-portal — Stripe Customer Portal session minter.
// Customer can change saved card, billing address, and review
// invoices without going through a checkout flow. Replaces the
// previous "read-only saved card" stub on /account.
router.use(meBillingPortalRouter);
// /shop/me/caregiver — designated authorized contact (single named
// person who receives a copy of shipment + delivery notifications
// on behalf of the patient). Critical for the elderly CPAP cohort
// where adult-child / spouse caregivers manage logistics.
router.use(meCaregiverRouter);
router.use(meExportRouter);
router.use(meReorderSuggestionsRouter);
router.use(myOrdersRouter);
router.use(myReturnsRouter);
// Mounted after myOrdersRouter so the more-specific
// `/shop/me/orders/:sessionId/resend-receipt` POST sits next to
// the GET it complements. Keeps grep / "where do I find the
// receipt re-send route" answerable.
router.use(resendReceiptRouter);
router.use(mySubscriptionsRouter);
router.use(quickCheckoutRouter);
router.use(cartSnapshotRouter);
// Customer-submitted product reviews. Public reads + author writes
// here; admin moderation queue lives at routes/admin/shop-reviews.ts
// and is mounted from routes/index.ts alongside the other admin
// surfaces.
router.use(reviewsRouter);
// Customer-submitted product Q&A (Phase A.5). Public list of
// answered Q&A + auth-gated submit; admin moderation + answer
// flow lives at routes/admin/product-questions.ts.
router.use(productQuestionsRouter);
// Product compatibility lookup (Phase B.3). Public reads — used by
// the catalog filter "show only parts compatible with my machine"
// and the product-detail "compatible with your AirSense 11" badge.
// Admin writes live in routes/admin/product-compatibility.ts.
router.use(productCompatibilityRouter);
// Public lead-capture form on /insurance. Sends two SendGrid
// emails (team notification + patient confirmation); does not
// write to the DB — the verifications team works the inbox.
router.use(insuranceLeadRouter);
// Public email + marketing-opt-in capture from the /consent page in
// cpap-fitter. Persists to resupply.fitter_leads so the abandoned-
// flow re-engagement dispatcher can scan for opt-ins without an
// order row.
router.use(fitterLeadRouter);
// /shop/fitter-complete — fired by the cpap-fitter /results page when
// the patient sees a mask recommendation. Marks the lead "completed"
// and enrolls them in the multi-touch supply-campaign dispatcher.
// /shop/fitter-leads/unsubscribe — one-click unsubscribe footer link
// rendered into every supply-campaign email.
router.use(fitterCompleteRouter);
// /shop/fitter-invite/* — public resolve + completion endpoints for
// staff-initiated AI mask-fitter invitations. Resolve prefills the
// fitter; complete transmits the measurements/answers/recommendation
// back and auto-attaches to a matching patient chart.
router.use(fitterInviteRouter);
// Public email-capture for the sleep-apnea quiz on /learn. Posts a
// fitter_leads row with source='sleep_apnea_quiz' and fires a
// transactional results email so the patient has the score in
// writing to share with their physician.
router.use(quizLeadRouter);
// Public lightweight insurance estimator on /insurance/estimate.
// Lower-friction sibling of /shop/insurance-leads: payer + email
// only, returns a static range, persists a fitter_leads row with
// source='insurance_quote' and emails a written estimate.
router.use(insuranceEstimateRouter);
// /shop/orders/nps — public NPS capture endpoint for the post-
// delivery follow-up email links. Token-bound (HMAC-signed,
// 30-day TTL); rate-limited per IP; persists to
// shop_order_nps_responses.
router.use(npsResponseRouter);
// /shop/orders/mask-fit — public mask-fit micro-survey capture (RT #22a).
router.use(maskFitResponseRouter);
// /shop/education-videos — public education-video library (RT #25).
router.use(educationVideosRouter);
router.use(backInStockRouter);

export default router;
