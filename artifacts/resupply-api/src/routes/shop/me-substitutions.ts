// /shop/me/substitutions — patient-facing view of recent resupply
// substitutions. When the backorder substitution path (see
// lib/backorder/resolve-fulfillment-sku.ts) ships an alternative SKU
// for a primary that was out of stock, this endpoint surfaces the
// swap on the patient's /account page so they aren't surprised by
// "this looks different from last time".
//
// Posture:
//   * Email-matched against patients (same strategy as
//     /shop/me/therapy-summary). Refuses to merge when multiple
//     patient rows match — see that file's preamble for the
//     HIPAA rationale.
//   * Only returns fulfillments from the last 180 days. Older
//     substitutions are ancient history; surfacing them on /account
//     forever is more noise than signal.
//   * Returns the SKU strings raw — the SPA looks up product
//     metadata separately if it needs labels.

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

const WINDOW_DAYS = 180;

async function resolveSinglePatientByEmail(
  customerEmail: string,
): Promise<string | null> {
  const supabase = getSupabaseServiceRoleClient();
  const escaped = customerEmail.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id")
    .ilike("email", escaped)
    .limit(2);
  if (error) throw error;
  if (!rows || rows.length !== 1) return null;
  return rows[0]!.id;
}

router.get("/shop/me/substitutions", requireSignedIn, async (req, res) => {
  const customerEmail = req.shopCustomerEmail;
  if (!customerEmail) {
    res.json({ patientLinked: false, substitutions: [] });
    return;
  }
  const patientId = await resolveSinglePatientByEmail(customerEmail);
  if (!patientId) {
    res.json({ patientLinked: false, substitutions: [] });
    return;
  }

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - WINDOW_DAYS);

  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("fulfillments")
    .select(
      "id, item_sku, substituted_from_sku, status, shipped_at, delivered_at, created_at",
    )
    .eq("patient_id", patientId)
    .not("substituted_from_sku", "is", null)
    .gte("created_at", cutoff.toISOString())
    .order("created_at", { ascending: false })
    .limit(25);
  if (error) throw error;

  logger.info(
    {
      event: "shop.me.substitutions.served",
      count: (data ?? []).length,
    },
    "shop.me.substitutions: served",
  );

  res.json({
    patientLinked: true,
    substitutions: (data ?? []).map((r) => ({
      id: r.id,
      shippedSku: r.item_sku,
      requestedSku: r.substituted_from_sku,
      status: r.status,
      shippedAt: r.shipped_at,
      deliveredAt: r.delivered_at,
      createdAt: r.created_at,
    })),
  });
});

export default router;
