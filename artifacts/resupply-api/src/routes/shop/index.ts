// Shop routes — patient-facing cash-pay catalog + checkout.
//
// All routes are PUBLIC (no requireAdmin / no Clerk gate). The Stripe
// Hosted Checkout pattern keeps card data out of our process; Stripe
// handles PCI scope. Order tracking rows live in resupply.shop_orders
// and are linked to Stripe by Session ID.

import { Router, type IRouter } from "express";

import cartSnapshotRouter from "./cart-snapshot";
import checkoutRouter from "./checkout";
import meRouter from "./me";
import myOrdersRouter from "./my-orders";
import mySubscriptionsRouter from "./my-subscriptions";
import orderRouter from "./order";
import productsRouter from "./products";
import quickCheckoutRouter from "./quick-checkout";
import reviewsRouter from "./reviews";

const router: IRouter = Router();
router.use(productsRouter);
router.use(checkoutRouter);
router.use(orderRouter);
// /shop/me/* — auth-aware patient account endpoints. Mounted
// alongside the public catalog so the frontend can reach both with
// the same base path. The handlers themselves apply Clerk gating
// (requireSignedIn / attachSignedIn) per-endpoint.
router.use(meRouter);
router.use(myOrdersRouter);
router.use(mySubscriptionsRouter);
router.use(quickCheckoutRouter);
router.use(cartSnapshotRouter);
// Customer-submitted product reviews. Public reads + author writes
// here; admin moderation queue lives at routes/admin/shop-reviews.ts
// and is mounted from routes/index.ts alongside the other admin
// surfaces.
router.use(reviewsRouter);

export default router;
