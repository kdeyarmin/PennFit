// /admin/carrier-labels — admin-triggered label generation.
//
//   POST /admin/shop/returns/:returnId/label
//        Mint a return label for an approved RMA. Today this returns
//        503 with `error: "vendor_not_configured"` until a vendor is
//        wired up; the UI surfaces that as "Configure CARRIER_LABEL_
//        VENDOR to enable label generation."

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { selectAdapter } from "../../lib/carrier-labels";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.post(
  "/admin/shop/returns/:returnId/label",
  // Mints a return label for an approved RMA. `returns.manage`
  // scope — operational tier (admin / supervisor / csr / fulfillment
  // / agent), excludes fitter and compliance_officer (no workflow
  // here).
  requirePermission("returns.manage"),
  adminRateLimit({ name: "carrier_labels.mint", preset: "mutation" }),
  async (req, res) => {
    const idParse = z.string().uuid().safeParse(req.params.returnId);
    if (!idParse.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("shop_returns")
      .select("id, status")
      .eq("id", idParse.data)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (data.status !== "approved" && data.status !== "shipped_back") {
      res.status(409).json({
        error: "wrong_state",
        message: `Return must be 'approved' to mint a label (current: ${data.status}).`,
      });
      return;
    }
    const adapter = selectAdapter();
    const result = await adapter.createLabel({
      kind: "return",
      to: {
        name: "PennPaps Returns",
        line1: "—",
        city: "—",
        state: "—",
        postalCode: "—",
        country: "US",
      },
      from: {
        name: "Customer",
        line1: "—",
        city: "—",
        state: "—",
        postalCode: "—",
        country: "US",
      },
      weightOz: 16,
    });
    if (!result.ok) {
      const status =
        result.error === "vendor_not_configured" ? 503 : 502;
      res
        .status(status)
        .json({ error: result.error, message: result.message });
      return;
    }
    res.json({
      vendor: adapter.vendorName,
      carrier: result.carrier,
      trackingNumber: result.trackingNumber,
      labelMime: result.labelMime,
      labelBase64: result.labelBase64,
      shippingCostCents: result.shippingCostCents,
    });
  },
);

export default router;
