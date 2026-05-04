import { Router, type IRouter } from "express";
import abandonedCartsRouter from "./admin/abandoned-carts.js";
import shopCustomersAdminRouter from "./admin/customers.js";
import shopCustomerNotesRouter from "./admin/customer-notes.js";
import shopCustomerFollowupsRouter from "./admin/customer-followups.js";
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
