// Shop routes — patient-facing cash-pay catalog + checkout.
//
// All routes are PUBLIC (no requireAdmin / no the auth provider gate). The Stripe
// Hosted Checkout pattern keeps card data out of our process; Stripe
// handles PCI scope. Order tracking rows live in resupply.shop_orders
// and are linked to Stripe by Session ID.

import { Router, type IRouter } from "express";

import cartSnapshotRouter from "./cart-snapshot";
import checkoutRouter from "./checkout";
import insuranceLeadRouter from "./insurance-lead";
import backInStockRouter from "./back-in-stock";
import meRouter from "./me";
import meClinicalInfoRouter from "./me-clinical-info";
import meCommPrefsRouter from "./me-comm-prefs";
import meDashboardRouter from "./me-dashboard";
import meMessagesRouter from "./me-messages";
import meExportRouter from "./me-export";
import meReorderSuggestionsRouter from "./me-reorder-suggestions";
import myOrdersRouter from "./my-orders";
import myReturnsRouter from "./my-returns";
import mySubscriptionsRouter from "./my-subscriptions";
import orderRouter from "./order";
import productsRouter from "./products";
import quickCheckoutRouter from "./quick-checkout";
import resendReceiptRouter from "./resend-receipt";
import reviewsRouter from "./reviews";
import productQuestionsRouter from "./product-questions";
import productCompatibilityRouter from "./product-compatibility";
import mePushSubscriptionsRouter from "./me-push-subscriptions";

const router: IRouter = Router();
router.use(productsRouter);
router.use(checkoutRouter);
router.use(orderRouter);
// /shop/me/* — auth-aware patient account endpoints. Mounted
// alongside the public catalog so the frontend can reach both with
// the same base path. The handlers themselves apply the auth provider gating
// (requireSignedIn / attachSignedIn) per-endpoint.
router.use(meRouter);
router.use(meClinicalInfoRouter);
router.use(meCommPrefsRouter);
router.use(meDashboardRouter);
router.use(meMessagesRouter);
// /shop/me/push-subscriptions/* — W3C Web Push registration
// (Phase C.1). Subscribe / unsubscribe / list endpoints; the
// VAPID public-key getter sits behind the same auth gate.
router.use(mePushSubscriptionsRouter);
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
router.use(backInStockRouter);

export default router;
