// POST /shop/me/orders/:orderId/loss-claim — patient self-reports
// that a paid order never arrived. Opens a shop_order_loss_claims
// row in `open` state for the CSR queue to work; we do not auto-
// trust the claim or issue a refund.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

router.post(
  "/shop/me/orders/:orderId/loss-claim",
  requireSignedIn,
  async (req, res) => {
    const idParse = z.string().uuid().safeParse(req.params.orderId);
    if (!idParse.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = z
      .object({
        note: z.string().trim().max(2000).optional(),
      })
      .strict()
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const email = req.shopCustomerEmail;
    if (!email) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    // Verify the order belongs to this customer (via customer_email
    // which is the durable identifier on shop_orders for both signed-in
    // and guest checkouts).
    const { data: order, error: orderErr } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .select("id, customer_email, shipped_at")
      .eq("id", idParse.data)
      .limit(1)
      .maybeSingle();
    if (orderErr) throw orderErr;
    if (
      !order ||
      (order.customer_email ?? "").toLowerCase() !== email.toLowerCase()
    ) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!order.shipped_at) {
      res.status(409).json({
        error: "not_yet_shipped",
        message: "This order has not been marked shipped yet.",
      });
      return;
    }
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("shop_order_loss_claims")
      .insert({
        order_id: idParse.data,
        status: "open",
        resolution_note: parsed.data.note ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;
    res.status(201).json({ id: row.id });
  },
);

export default router;
