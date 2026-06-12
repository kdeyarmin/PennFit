// POST /shop/validate-address — public address-validation probe used
// by the checkout form before Stripe Hosted Checkout. Returns a
// "looks fine" / "looks suspicious" verdict from the local heuristic
// in lib/address-validation/. The frontend SHOULD surface the
// reasons[] to the customer and let them edit; it MUST NOT auto-
// correct.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { validateAddress } from "../../lib/address-validation";
import { RATE_LIMITS } from "../../lib/rate-limits-config";
import { rateLimit } from "../../middlewares/rate-limit";

const router: IRouter = Router();

const validateAddressLimiter = rateLimit({
  windowMs: RATE_LIMITS.shop_validate_address.windowMs,
  max: RATE_LIMITS.shop_validate_address.limit,
  name: "shop_validate_address",
});

const body = z
  .object({
    line1: z.string().trim().max(120).optional(),
    line2: z.string().trim().max(120).optional(),
    city: z.string().trim().max(80).optional(),
    state: z.string().trim().max(40).optional(),
    postalCode: z.string().trim().max(20).optional(),
    country: z.string().trim().max(8).optional(),
  })
  .strict();

router.post(
  "/shop/validate-address",
  validateAddressLimiter,
  async (req, res) => {
    const parsed = body.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const result = validateAddress(parsed.data);
    res.json(result);
  },
);

export default router;
