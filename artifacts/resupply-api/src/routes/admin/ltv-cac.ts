// /admin/analytics/ltv-cac — LTV & CAC cohort economics by acquisition
// channel (Owner #3, Phase 2).
//
//   GET /admin/analytics/ltv-cac
//        → per-channel avg lifetime value, avg CAC (over costed
//          customers), and the LTV:CAC ratio.
//   PUT /admin/customers/:customerId/acquisition
//        → record/replace a customer's channel + (optional) acquisition
//          cost (migration 0196 customer_acquisition; UPSERT on the PK).
//
// LTV per customer = sum of paid shop_orders. CAC is averaged over the
// customers whose acquisition cost is KNOWN (an unknown-cost customer is
// never counted as $0, which would inflate the ratio) — the same honesty
// posture as the F1 cost layer. The cohort math is the pure, tested
// buildLtvCacReport in @workspace/resupply-domain.
//
// cost.read to view (acquisition-cost is finance data, off the CSR
// bucket); cost.write to record attribution. Aggregates only on the GET
// — channel + dollar rollups, no per-customer PHI.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  buildLtvCacReport,
  type AcquisitionChannel,
  type CustomerEconomicsInput,
} from "@workspace/resupply-domain";

import { logger } from "../../lib/logger";
import {
  adminRateLimit,
  adminReadRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const CHANNELS = [
  "organic",
  "paid_search",
  "paid_social",
  "referral",
  "fitter",
  "insurance_lead",
  "partner",
  "other",
] as const;

router.get(
  "/admin/analytics/ltv-cac",
  adminReadRateLimiter,
  requirePermission("cost.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();

    // Paid-order revenue per customer (the LTV numerator).
    const { data: orders, error: ordersErr } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .select("customer_id, amount_total_cents, paid_at")
      .not("paid_at", "is", null)
      .limit(20000);
    if (ordersErr) {
      res
        .status(500)
        .json({ error: "query_failed", message: ordersErr.message });
      return;
    }

    const revenueByCustomer = new Map<string, number>();
    for (const o of (orders ?? []) as Array<Record<string, unknown>>) {
      const cid = typeof o.customer_id === "string" ? o.customer_id : "";
      if (cid === "") continue;
      const amt =
        typeof o.amount_total_cents === "number" ? o.amount_total_cents : 0;
      revenueByCustomer.set(cid, (revenueByCustomer.get(cid) ?? 0) + amt);
    }

    // Attribution rows (channel + acquisition cost) per customer.
    const { data: attribution, error: attrErr } = await supabase
      .schema("resupply")
      .from("customer_acquisition")
      .select("customer_id, channel, acquisition_cost_cents")
      .limit(20000);
    if (attrErr) {
      res.status(500).json({ error: "query_failed", message: attrErr.message });
      return;
    }
    const attrByCustomer = new Map<
      string,
      { channel: AcquisitionChannel; acquisitionCostCents: number | null }
    >();
    for (const a of (attribution ?? []) as Array<Record<string, unknown>>) {
      const cid = typeof a.customer_id === "string" ? a.customer_id : "";
      if (cid === "") continue;
      attrByCustomer.set(cid, {
        channel: a.channel as AcquisitionChannel,
        acquisitionCostCents:
          typeof a.acquisition_cost_cents === "number"
            ? a.acquisition_cost_cents
            : null,
      });
    }

    // Union of every customer who has revenue OR an attribution row.
    const customerIds = new Set<string>([
      ...revenueByCustomer.keys(),
      ...attrByCustomer.keys(),
    ]);
    const inputs: CustomerEconomicsInput[] = [...customerIds].map((cid) => {
      const attr = attrByCustomer.get(cid);
      return {
        customerId: cid,
        channel: attr ? attr.channel : null,
        lifetimeRevenueCents: revenueByCustomer.get(cid) ?? 0,
        acquisitionCostCents: attr ? attr.acquisitionCostCents : null,
      };
    });

    const report = buildLtvCacReport(inputs);
    res.json({ ...report, generatedAt: new Date().toISOString() });
  },
);

const putSchema = z
  .object({
    channel: z.enum(CHANNELS),
    acquisitionCostCents: z.number().int().min(0).nullable().optional(),
    sourceDetail: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

router.put(
  "/admin/customers/:customerId/acquisition",
  requirePermission("cost.write"),
  adminRateLimit({ name: "customer_acquisition.upsert", preset: "mutation" }),
  async (req, res) => {
    const customerId = String(req.params.customerId ?? "").trim();
    if (customerId === "" || customerId.length > 128) {
      res.status(400).json({ error: "invalid_customer_id" });
      return;
    }
    const parsed = putSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const d = parsed.data;

    const supabase = getSupabaseServiceRoleClient();
    const nowIso = new Date().toISOString();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("customer_acquisition")
      .upsert(
        {
          customer_id: customerId,
          channel: d.channel,
          acquisition_cost_cents: d.acquisitionCostCents ?? null,
          source_detail: d.sourceDetail ?? null,
          recorded_by_email: req.adminEmail ?? null,
          updated_at: nowIso,
        },
        { onConflict: "customer_id" },
      )
      .select("customer_id, channel")
      .single();
    if (error) {
      res.status(500).json({ error: "upsert_failed", message: error.message });
      return;
    }

    await logAudit({
      action: "customer_acquisition.upsert",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "customer_acquisition",
      targetId: customerId,
      metadata: {
        channel: d.channel,
        cost_known: d.acquisitionCostCents != null,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "customer_acquisition.upsert audit write failed");
    });

    res.json({
      customerId: (row as Record<string, unknown>).customer_id,
      channel: (row as Record<string, unknown>).channel,
    });
  },
);

export default router;
