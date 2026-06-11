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
    const customerId = req.userCustomerId;
    if (!customerId) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    // Verify the order belongs to this customer by customer_id — the
    // session-derived key every sibling `/shop/me/*` route filters on
    // (see resend-receipt.ts). The previous customer_email match let
    // any account SHARING an email with the order's (e.g. a household
    // member's separate account, or a guest order later claimed under
    // the same address) open loss claims on it.
    const { data: order, error: orderErr } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .select("id, customer_id, shipped_at")
      .eq("id", idParse.data)
      .eq("customer_id", customerId)
      .limit(1)
      .maybeSingle();
    if (orderErr) throw orderErr;
    if (!order) {
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
    // Duplicate guard: one OPEN claim per order. Re-submitting while a
    // claim is being worked just resurfaces the same CSR task.
    const { data: existingClaim, error: existingErr } = await supabase
      .schema("resupply")
      .from("shop_order_loss_claims")
      .select("id")
      .eq("order_id", idParse.data)
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (existingErr) throw existingErr;
    if (existingClaim) {
      res.status(409).json({
        error: "claim_already_open",
        id: existingClaim.id,
        message:
          "A loss claim for this order is already being reviewed by our team.",
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
