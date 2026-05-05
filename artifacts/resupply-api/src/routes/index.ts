import { Router, type IRouter } from "express";
import abandonedCartsRouter from "./admin/abandoned-carts.js";
import shopCustomersAdminRouter from "./admin/customers.js";
import shopCustomerNotesRouter from "./admin/customer-notes.js";
import shopCustomerFollowupsRouter from "./admin/customer-followups.js";
import followupsListRouter from "./admin/followups-list.js";
import shopOrderNotesRouter from "./admin/order-notes.js";
import shopOrdersAdminRouter from "./admin/shop-orders.js";
import shopProductsAdminRouter from "./admin/shop-products.js";
import csrMacrosRouter from "./admin/csr-macros.js";
import shopReturnsAdminRouter from "./admin/shop-returns.js";
import shopReturnNotesRouter from "./admin/return-notes.js";
import shopReviewRequestsRouter from "./admin/shop-review-requests.js";
import teamRouter from "./admin/team.js";
import opsStatusRouter from "./admin/ops-status.js";
import inboxCountsRouter from "./admin/inbox-counts.js";
import reportsRouter from "./admin/reports.js";
import deliveryFailuresRouter from "./admin/delivery-failures.js";
import lookupRouter from "./admin/lookup.js";
import systemInfoRouter from "./admin/system-info.js";
import shopReviewsAdminRouter from "./admin/shop-reviews.js";
import shopProductQuestionsAdminRouter from "./admin/product-questions.js";
import patientOnboardingRouter from "./admin/patient-onboarding.js";
import patientPortalInviteRouter from "./admin/patient-portal-invite.js";
import prescriptionRenewalsRouter from "./admin/prescription-renewals.js";
import shopProductCompatibilityAdminRouter from "./admin/product-compatibility.js";
import patientTherapySyncRouter from "./admin/patient-therapy-sync.js";
import smartTriggersRouter from "./admin/smart-triggers.js";
import physicianFaxOutreachRouter from "./admin/physician-fax-outreach.js";
import shopBackInStockAdminRouter from "./admin/shop-back-in-stock.js";
import shopSubsMetricsRouter from "./admin/shop-subscriptions-metrics.js";
import insuranceLeadsAdminRouter from "./admin/insurance-leads.js";
import auditRouter from "./audit/index.js";
import conversationsRouter from "./conversations/index.js";
import dashboardRouter from "./dashboard/index.js";
import emailRouter from "./email/index.js";
import episodesRouter from "./episodes/index.js";
import healthRouter from "./health.js";
import meRouter from "./me.js";
import patientsRouter from "./patients/index.js";
import rulesRouter from "./rules/index.js";
import smsRouter from "./sms/index.js";
import shopRouter from "./shop/index.js";
import voiceRouter from "./voice/index.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(meRouter);
// Public shop routes (no auth) — patient-facing cash-pay catalog,
// Stripe Hosted Checkout, and order summary lookup. Mounted before
// the admin-gated routes so the literal /shop/* paths can never be
// shadowed by a future param route.
router.use(shopRouter);
// Voice + SMS + Email routes are mounted unconditionally; each handler
// does its own feature-flag check so a missing env var becomes a clean
// 503 (or TwiML 503 for vendor-only paths) rather than a generic 404.
router.use(voiceRouter);
router.use(smsRouter);
router.use(emailRouter);
// Admin-console READ endpoints. Each handler is gated by
// requireAdmin and surfaces only PHI the dashboard needs to
// render — decrypted name on lists, decrypted message bodies only on
// the conversation detail endpoint, never phone or email values.
router.use(dashboardRouter);
router.use(patientsRouter);
router.use(rulesRouter);
router.use(conversationsRouter);
router.use(episodesRouter);
router.use(auditRouter);
// /admin/shop/abandoned-carts/* — operator tooling for the cart-
// abandonment SendGrid nudge (list + manual dispatcher trigger).
// requireAdmin gate is on the router itself.
router.use(abandonedCartsRouter);
// /admin/shop/reviews/* — moderation queue for customer-submitted
// product reviews. Reviews are pending by default and only become
// publicly visible after an admin approves them. requireAdmin gate
// is on the router itself.
router.use(shopReviewsAdminRouter);
// /admin/shop/product-questions — moderation queue + answer flow
// for customer-submitted product Q&A (Phase A.5). Pending questions
// only become publicly visible after a CSR posts an answer.
router.use(shopProductQuestionsAdminRouter);
// /admin/patients/:id/onboarding + /admin/onboarding/send-due —
// first-90-day adherence-coaching enrollment + dispatcher (Phase
// B.1 / feature #17). The CMS adherence threshold is missed by
// 40-70% of patients in the first 90 days; this surface fires the
// scheduled day-1/7/30/90 nudges that reverse that.
router.use(patientOnboardingRouter);
// /admin/patients/:id/portal-invite — CSR-driven patient portal
// invitation. Lets agents send a "set up your portal" email to a
// patient, optionally filling in required onboarding fields at the
// same time. Resend + revoke follow the same pattern as team invites.
router.use(patientPortalInviteRouter);
// /admin/prescriptions/send-renewal-due — prescription concierge
// dispatcher (Phase B.2 / feature #7). Scans active prescriptions
// expiring within 30 days and emails the patient to coordinate
// renewal. Aeroflow built its brand on this.
router.use(prescriptionRenewalsRouter);
// /admin/shop/products/:productId/compatibility — admin CRUD for
// the product-to-machine compatibility map (Phase B.3 / feature
// #11). Public reads live alongside the catalog router.
router.use(shopProductCompatibilityAdminRouter);
// /admin/patients/:id/therapy-nights/* — therapy-cloud sync
// (Phase E.1 / feature #18). Adapter stubs for ResMed AirView +
// Philips Care; the actual partner integration lands once a BAA
// + API access is in place. Sync endpoint 503s until the chosen
// adapter's env var is set.
router.use(patientTherapySyncRouter);
// /admin/smart-triggers/* — data-driven reorder-trigger evaluator +
// dispatcher (Phase E.2 / feature #19). Reads patient_therapy_nights,
// runs the rule library, queues + sends nudges that convert at 3-5x
// the rate of calendar-only reminders.
router.use(smartTriggersRouter);
// /admin/physician-fax-outreach — record + query physician-fax
// Rx-renewal requests (Phase G.6). Provider-agnostic data path;
// no fax vendor ships in the same PR — the row is created with
// status='pending' until a vendor adapter is wired and the
// FAX_VENDOR / FAX_API_KEY / FAX_FROM_NUMBER triple is set.
router.use(physicianFaxOutreachRouter);
// /admin/shop/back-in-stock-queue — visibility into who's waiting
// for which OOS SKU + manual fanout trigger. requireAdmin gate is
// on the router itself.
router.use(shopBackInStockAdminRouter);
// /admin/shop/insurance-leads/* — durable queue + status mutations
// for submissions to the public POST /shop/insurance-leads form.
// requireAdmin gate is on the router itself.
router.use(insuranceLeadsAdminRouter);
// /admin/shop/products/* — operator tooling for the cash-pay catalog
// itself. Today: PATCH stock_count metadata on a Stripe Product.
// requireAdmin gate is on the router itself.
router.use(shopProductsAdminRouter);
// /admin/shop/orders/* — fulfillment tooling on shop_orders rows
// (tracking entry, mark-delivered, address override, refund issuance).
// requireAdmin gate is on the router itself.
router.use(shopOrdersAdminRouter);
// /admin/shop/orders/:orderId/notes — internal CSR notes per shop
// order (Phase 14). Mounted after the orders router so the more-
// specific /notes path doesn't shadow any future detail GET.
router.use(shopOrderNotesRouter);
// /admin/shop/returns/* — comfort-guarantee swap / refund / RMA
// queue. Linear lifecycle (requested → approved → shipped_back →
// received → refunded|replaced|closed) with strict from-state
// assertions on every transition.
router.use(shopReturnsAdminRouter);
// /admin/shop/returns/:returnId/notes — internal CSR notes per
// return (Phase 15). Mounted after the returns router so the more-
// specific /notes path doesn't shadow the lifecycle endpoints.
router.use(shopReturnNotesRouter);
// /admin/csr-macros/* — admin CRUD for the canned-reply library used
// by the in-thread reply composer. See migration 0017 + the
// macroMerge helper in the dashboard for the {{namespace.key}}
// substitution syntax.
router.use(csrMacrosRouter);
// /admin/shop/subscriptions/metrics — KPI rollup for the
// subscription health dashboard. Pure SQL aggregation — no Stripe
// round-trip on this path.
router.use(shopSubsMetricsRouter);
// /admin/shop/review-requests/send-due — manual dispatcher for the
// post-purchase review-request email. Same atomic-claim pattern as
// the abandoned-cart dispatcher; comm-prefs + DND aware.
router.use(shopReviewRequestsRouter);
// /admin/team/* — DB-backed admin/CSR team management. Supplements
// (does not replace) the RESUPPLY_ADMIN_EMAILS env var allowlist;
// see middlewares/requireAdmin.ts for the resolution order.
router.use(teamRouter);
// /admin/ops-status — operations center status feed: vendor flags,
// dispatcher-eligible row counts, team counts. Read-only.
router.use(opsStatusRouter);
// /admin/inbox-counts — actionable-work counters for nav badges
// (awaiting-reply convs, pending returns, pending reviews). Read-
// only, called on every nav render with a 30s SPA cache.
router.use(inboxCountsRouter);
// /admin/reports/*.csv — date-bounded CSV exports for ops + finance.
router.use(reportsRouter);
// /admin/delivery-failures — webhook delivery error triage queue
// (per-message + audit-log failure events). Read-only.
router.use(deliveryFailuresRouter);
// /admin/lookup — global cross-entity lookup bar. Phone (HMAC),
// email, UUID, and Stripe-session-id-aware. Read-only.
router.use(lookupRouter);
// /admin/system-info — read-only env + deployment metadata for ops
// triage. Never returns env-var values, only "is this set?" booleans.
router.use(systemInfoRouter);
// /admin/shop/customers/* — Customer 360 surface (search/list +
// detail + reorder-on-behalf). Read-mostly; the only write is the
// reorder action which creates a Stripe Checkout Session. Same
// requireAdmin gate as the other shop-admin modules.
router.use(shopCustomersAdminRouter);
// /admin/shop/customers/:userId/notes — internal CSR notes per
// shop customer (Phase 10). Mounted after the customers router so
// the more-specific /notes path doesn't shadow the detail GET.
router.use(shopCustomerNotesRouter);
// /admin/shop/customers/:userId/followups — CSR-scheduled callback
// reminders per shop customer (Phase 17). Same mount-after-detail
// rationale as the notes router.
router.use(shopCustomerFollowupsRouter);
// /admin/followups — cross-customer daily queue of open follow-ups
// (Phase 18). Mounted alongside the per-customer router so both
// surfaces stay co-located.
router.use(followupsListRouter);
// /admin/shop/returns/* — comfort-guarantee swap / refund / RMA
// queue. Linear lifecycle (requested → approved → shipped_back →
// received → refunded|replaced|closed) with strict from-state
// assertions on every transition.
router.use(shopReturnsAdminRouter);
// /admin/csr-macros/* — admin CRUD for the canned-reply library used
// by the in-thread reply composer. See migration 0017 + the
// macroMerge helper in the dashboard for the {{namespace.key}}
// substitution syntax.
router.use(csrMacrosRouter);
// /admin/shop/subscriptions/metrics — KPI rollup for the
// subscription health dashboard. Pure SQL aggregation — no Stripe
// round-trip on this path.
router.use(shopSubsMetricsRouter);
// /admin/shop/review-requests/send-due — manual dispatcher for the
// post-purchase review-request email. Same atomic-claim pattern as
// the abandoned-cart dispatcher; comm-prefs + DND aware.
router.use(shopReviewRequestsRouter);
// /admin/team/* — DB-backed admin/CSR team management. Supplements
// (does not replace) the RESUPPLY_ADMIN_EMAILS env var allowlist;
// see middlewares/requireAdmin.ts for the resolution order.
router.use(teamRouter);
// /admin/ops-status — operations center status feed: vendor flags,
// dispatcher-eligible row counts, team counts. Read-only.
router.use(opsStatusRouter);
// /admin/reports/*.csv — date-bounded CSV exports for ops + finance.
router.use(reportsRouter);
// /admin/delivery-failures — webhook delivery error triage queue
// (per-message + audit-log failure events). Read-only.
router.use(deliveryFailuresRouter);
// /admin/lookup — global cross-entity lookup bar. Phone (HMAC),
// email, UUID, and Stripe-session-id-aware. Read-only.
router.use(lookupRouter);
// /admin/system-info — read-only env + deployment metadata for ops
// triage. Never returns env-var values, only "is this set?" booleans.
router.use(systemInfoRouter);

export default router;
