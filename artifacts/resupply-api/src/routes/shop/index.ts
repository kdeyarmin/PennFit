// Shop routes — patient-facing cash-pay catalog + checkout.
//
// All routes are PUBLIC (no requireAdmin / no Clerk gate). The Stripe
// Hosted Checkout pattern keeps card data out of our process; Stripe
// handles PCI scope. Order tracking rows live in resupply.shop_orders
// and are linked to Stripe by Session ID.

import { Router, type IRouter } from "express";

import checkoutRouter from "./checkout";
import orderRouter from "./order";
import productsRouter from "./products";

const router: IRouter = Router();
router.use(productsRouter);
router.use(checkoutRouter);
router.use(orderRouter);

export default router;
