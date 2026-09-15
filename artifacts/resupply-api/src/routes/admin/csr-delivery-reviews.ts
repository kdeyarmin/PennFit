import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { getOrgScopedClient } from "@workspace/resupply-db";
import { PricingValidationError } from "@workspace/resupply-domain";
import { requirePermission } from "../../middlewares/requireAdmin";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { PricingError } from "../../lib/pricing/service";
import {
  approveDeliveryReview,
  deliveryApprovalSchema,
  deliveryPreviewSchema,
  previewDeliveryReview,
} from "../../lib/csr-order/delivery-review";

const router: IRouter = Router();
const ids = z.object({
  id: z.string().uuid(),
  reviewId: z.string().uuid().optional(),
});
function endpoint(action: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    try {
      if (!req.orgId || !req.adminUserId)
        throw new PricingError("tenant_context_missing", 500);
      ids.parse(req.params);
      await action(req, res);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "invalid_body" });
        return;
      }
      if (error instanceof PricingValidationError) {
        res
          .status(422)
          .json({ error: "invalid_pricing_input", issues: error.issues });
        return;
      }
      if (error instanceof PricingError) {
        res.status(error.status).json({ error: error.code });
        return;
      }
      res.status(503).json({ error: "pricing_unavailable" });
    }
  };
}
const limit = adminRateLimit({
  name: "csr_delivery_review",
  preset: "mutation",
});
router.post(
  "/admin/csr-order-requests/:id/delivery-review/preview",
  requirePermission("pricing.approve"),
  limit,
  endpoint(async (req, res) => {
    res
      .status(201)
      .json(
        await previewDeliveryReview(
          getOrgScopedClient(req.orgId!),
          req.params.id as string,
          req.adminUserId!,
          deliveryPreviewSchema.parse(req.body),
        ),
      );
  }),
);
router.post(
  "/admin/csr-order-requests/:id/delivery-review/:reviewId/approve",
  requirePermission("pricing.approve"),
  limit,
  endpoint(async (req, res) => {
    res.json(
      await approveDeliveryReview(
        getOrgScopedClient(req.orgId!),
        req.params.id as string,
        req.params.reviewId as string,
        req.adminUserId!,
        deliveryApprovalSchema.parse(req.body),
      ),
    );
  }),
);
export default router;
