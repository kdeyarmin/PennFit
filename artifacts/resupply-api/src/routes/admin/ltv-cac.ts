// /admin/analytics/ltv-cac — LTV & CAC cohort economics by acquisition
// channel (Owner #3, Phase 2).
//
//   GET /admin/analytics/ltv-cac
//        → per-channel avg lifetime value, avg CAC (over costed
//          customers), and the LTV:CAC ratio.
//   PUT /admin/customers/:customerId/acquisition
//        → record/replace a customer's channel + (optional) acquisition
//          cost + optional patientId (migration 0196 + 0532; UPSERT).
//
// LTV per customer = paid shop_orders + linked insurance remittance
// (`customer_acquisition.patient_id` → `insurance_claims.total_paid_cents`
// where paid_at IS NOT NULL, migration 0532). CAC is averaged over
// customers whose acquisition cost is KNOWN (an unknown-cost customer is
// never counted as $0, which would inflate the ratio) — the same honesty
// posture as the F1 cost layer. The cohort math is the pure, tested
// buildLtvCacReport in @workspace/resupply-domain.
//
// cost.read to view (acquisition-cost is finance data, off the CSR
// bucket); cost.write to record attribution (optional patientId). Aggregates
// only on the GET — channel + dollar rollups, no per-customer PHI.

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

    // Per-customer LTV/CAC — migration 0436 shop rollup, extended by 0532
    // to add linked insurance remittance when patient_id is set. Channel
    // rollup + LTV:CAC stays in pure buildLtvCacReport.
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

    type EconRow = {
      customer_id: string;
      lifetime_revenue_cents: number | string;
      shop_revenue_cents?: number | string | null;
      insurance_revenue_cents?: number | string | null;
      patient_id?: string | null;
      channel: string | null;
      acquisition_cost_cents: number | string | null;
    };
    const econRows = (economics ?? []) as EconRow[];

    const inputs: CustomerEconomicsInput[] = econRows.map((row) => ({
      customerId: row.customer_id,
      channel: row.channel == null ? null : (row.channel as AcquisitionChannel),
      lifetimeRevenueCents: Number(row.lifetime_revenue_cents),
      acquisitionCostCents:
        row.acquisition_cost_cents == null
          ? null
          : Number(row.acquisition_cost_cents),
    }));

    let linkedInsuranceRevenueCents = 0;
    let linkedPatientCustomerCount = 0;
    for (const row of econRows) {
      const ins = Number(row.insurance_revenue_cents ?? 0);
      if (Number.isFinite(ins) && ins > 0) {
        linkedInsuranceRevenueCents += Math.trunc(ins);
      }
      if (row.patient_id) linkedPatientCustomerCount += 1;
    }

    const report = buildLtvCacReport(inputs);

    // Org-wide ERA remittance companion for coverage context. Linked claim
    // dollars are already inside lifetimeRevenueCents / LTV:CAC via the RPC.
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
        linkedToCustomersCents: linkedInsuranceRevenueCents,
        linkedCustomerCount: linkedPatientCustomerCount,
        includedInLtvRatio: linkedInsuranceRevenueCents > 0,
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
    // Optional link to patients so ERA remittance folds into channel LTV.
    // Omit to leave existing patient_id unchanged; null clears the link.
    patientId: z.string().uuid().nullable().optional(),
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

    if (d.patientId) {
      const { data: patient, error: patientErr } = await supabase
        .from("patients")
        .select("id")
        .eq("id", d.patientId)
        .maybeSingle();
      if (patientErr) {
        res.status(500).json({
          error: "patient_lookup_failed",
          message: patientErr.message,
        });
        return;
      }
      if (!patient) {
        res.status(404).json({ error: "patient_not_found" });
        return;
      }
    }

    const nowIso = new Date().toISOString();
    const upsertPayload: {
      customer_id: string;
      channel: (typeof CHANNELS)[number];
      acquisition_cost_cents: number | null;
      source_detail: string | null;
      recorded_by_email: string | null;
      updated_at: string;
      patient_id?: string | null;
    } = {
      customer_id: customerId,
      channel: d.channel,
      acquisition_cost_cents: d.acquisitionCostCents ?? null,
      source_detail: d.sourceDetail ?? null,
      recorded_by_email: req.adminEmail ?? null,
      updated_at: nowIso,
    };
    if (d.patientId !== undefined) {
      upsertPayload.patient_id = d.patientId;
    }

    const { data: row, error } = await supabase
      .from("customer_acquisition")
      .upsert(upsertPayload, { onConflict: "customer_id" })
      .select("customer_id, channel, patient_id")
      .single();
    if (error) {
      const code = (error as { code?: string }).code;
      if (code === "23505") {
        res.status(409).json({ error: "patient_already_linked" });
        return;
      }
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
        patient_linked: Boolean(
          (row as { patient_id?: string | null } | null)?.patient_id,
        ),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err: redactDbErr(err) },
        "customer_acquisition.upsert audit write failed",
      );
    });

    const r = row as {
      customer_id: string;
      channel: string;
      patient_id: string | null;
    };
    res.json({
      customerId: r.customer_id,
      channel: r.channel,
      patientId: r.patient_id ?? null,
    });
  },
);

export default router;
