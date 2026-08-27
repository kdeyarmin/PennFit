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
import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  buildLtvCacReport,
  type AcquisitionChannel,
  type CustomerEconomicsInput,
} from "@workspace/resupply-domain";

import { redactDbErr } from "../../lib/redact-db-err";
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
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    // Per-customer LTV/CAC economics — the (lifetime paid revenue, channel,
    // acquisition cost) tuple per customer — is computed server-side in
    // resupply.ltv_cac_customer_economics (migration 0436). Moving the
    // rollup into Postgres replaces the former pair of `.limit(20000)`
    // reads (paid orders + attribution) that silently truncated above the
    // cap. The RPC mirrors the JS exactly: revenue is paid orders only
    // (`paid_at IS NOT NULL` AND `status <> 'refunded'` — refunded orders
    // keep paid_at set and must be excluded, the same rule the Customer-360
    // rollup documents); the result is the UNION of every customer with
    // revenue OR an attribution row, with revenue defaulting to 0 and a
    // NULL channel → "unattributed". The channel rollup + LTV:CAC ratio
    // math stays in the tested, pure buildLtvCacReport below, so the
    // response is byte-for-byte unchanged.
    const { data: economics, error: economicsErr } = await supabase
      .raw()
      .schema("resupply")
      .rpc("ltv_cac_customer_economics", { p_org_id: orgId });
    if (economicsErr) {
      res
        .status(500)
        .json({ error: "query_failed", message: economicsErr.message });
      return;
    }

    const inputs: CustomerEconomicsInput[] = (
      (economics ?? []) as Array<{
        customer_id: string;
        lifetime_revenue_cents: number | string;
        channel: string | null;
        acquisition_cost_cents: number | null;
      }>
    ).map((row) => ({
      customerId: row.customer_id,
      channel: row.channel == null ? null : (row.channel as AcquisitionChannel),
      lifetimeRevenueCents: Number(row.lifetime_revenue_cents),
      acquisitionCostCents:
        typeof row.acquisition_cost_cents === "number"
          ? row.acquisition_cost_cents
          : null,
    }));

    const report = buildLtvCacReport(inputs);

    // ERA remittance companion — labeled NOT in the LTV:CAC ratio. Channel
    // attribution for claim dollars still needs a patient↔customer join
    // (customer_acquisition has no patient_id). Operators see remittance
    // totals here and the full split on revenue-by-source.
    let eraPayerPaidCents = 0;
    let eraPaidClaimCount = 0;
    {
      const PAGE = 1000;
      const CAP = 50_000;
      for (let from = 0; from < CAP; from += PAGE) {
        const { data, error, count } = await supabase
          .from("insurance_claims")
          .select("total_paid_cents", { count: "exact" })
          .not("paid_at", "is", null)
          .order("id", { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) {
          logger.warn(
            { err: redactDbErr(error), orgId },
            "ltv-cac: ERA remittance companion query failed",
          );
          eraPayerPaidCents = 0;
          eraPaidClaimCount = 0;
          break;
        }
        if (count != null && from === 0) eraPaidClaimCount = count;
        for (const row of data ?? []) {
          const cents = (row as { total_paid_cents: number | null })
            .total_paid_cents;
          eraPayerPaidCents += Math.max(0, cents ?? 0);
        }
        if (!data || data.length < PAGE) break;
        if (count != null && count > CAP) {
          // Cap hit — still report what we summed; flag incomplete below.
          break;
        }
      }
    }

    res.json({
      ...report,
      generatedAt: new Date().toISOString(),
      insuranceRemittance: {
        eraPayerPaidCents,
        paidClaimCount: eraPaidClaimCount,
        includedInLtvRatio: false as const,
        possiblyIncomplete: eraPaidClaimCount > 50_000,
      },
    });
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

    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const nowIso = new Date().toISOString();
    const { data: row, error } = await supabase
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
      logger.warn(
        { err: redactDbErr(err) },
        "customer_acquisition.upsert audit write failed",
      );
    });

    res.json({
      customerId: (row as Record<string, unknown>).customer_id,
      channel: (row as Record<string, unknown>).channel,
    });
  },
);

export default router;
