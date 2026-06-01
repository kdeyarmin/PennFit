// /admin/clinical/mask-fit — RT triage of mask-fit micro-survey outcomes
// (RT #22a, slice 2).
//
//   GET  /admin/clinical/mask-fit/worklist   (clinical.read)
//     Open (non-actioned) outcomes, worst-fit first, with the patient id
//     resolved from the order so an RT can follow up (→ an intervention,
//     #21). Outcome + comment + ids only — counts, no other PHI.
//
//   POST /admin/clinical/mask-fit/:id/triage (clinical.intervention.write)
//     Advance the triage state: { status: "reviewed" | "actioned" }.
//
// 'good' outcomes are captured for the rec-engine signal (#22b) but don't
// clutter the worklist — only leaking/uncomfortable surface here.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";
import {
  computeFitAdjustments,
  tallyOutcomesByMask,
} from "../../lib/storefront/mask-fit-tuning";

const router: IRouter = Router();

export type FitOutcome = "good" | "leaking" | "uncomfortable";

export interface MaskFitRow {
  id: string;
  order_id: string;
  fit_outcome: FitOutcome;
  comment: string | null;
  status: "new" | "reviewed" | "actioned";
  created_at: string;
}

export interface MaskFitWorkItem extends MaskFitRow {
  patientId: string | null;
}

const SEVERITY: Record<FitOutcome, number> = {
  uncomfortable: 2,
  leaking: 1,
  good: 0,
};

/**
 * Pure: worst-fit first (uncomfortable > leaking > good), then newest.
 * No I/O — unit-tested directly.
 */
export function rankMaskFitWorklist<
  T extends { fit_outcome: FitOutcome; created_at: string },
>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      SEVERITY[b.fit_outcome] - SEVERITY[a.fit_outcome] ||
      Date.parse(b.created_at) - Date.parse(a.created_at),
  );
}

router.get(
  "/admin/clinical/mask-fit/worklist",
  adminReadRateLimiter,
  requirePermission("clinical.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("mask_fit_outcomes")
      .select("id, order_id, fit_outcome, comment, status, created_at")
      .in("status", ["new", "reviewed"])
      .neq("fit_outcome", "good")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    const rows = (data ?? []) as MaskFitRow[];

    // Resolve patient ids from the orders (single batched lookup).
    const orderIds = [...new Set(rows.map((r) => r.order_id))];
    const patientByOrder = new Map<string, string>();
    if (orderIds.length > 0) {
      const { data: orders } = await supabase
        .schema("resupply")
        .from("shop_orders")
        .select("id, patient_id")
        .in("id", orderIds);
      for (const o of (orders ?? []) as Array<{
        id: string;
        patient_id: string | null;
      }>) {
        if (o.patient_id) patientByOrder.set(o.id, o.patient_id);
      }
    }

    const items: MaskFitWorkItem[] = rankMaskFitWorklist(rows).map((r) => ({
      ...r,
      patientId: patientByOrder.get(r.order_id) ?? null,
    }));

    res.json({
      items,
      count: items.length,
      counts: {
        uncomfortable: items.filter((i) => i.fit_outcome === "uncomfortable")
          .length,
        leaking: items.filter((i) => i.fit_outcome === "leaking").length,
      },
    });
  },
);

// GET /admin/clinical/mask-fit/rec-signal — the #22b tuning signal: per-
// mask seal/comfort counts from attributed outcomes + the ranking
// multiplier each would feed the recommendation engine. Neutral (empty)
// until outcomes have accumulated with a mask attribution. clinical.read.
router.get(
  "/admin/clinical/mask-fit/rec-signal",
  adminReadRateLimiter,
  requirePermission("clinical.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("mask_fit_outcomes")
      .select("mask_id, fit_outcome")
      .not("mask_id", "is", null)
      .limit(20000);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    const rows = (data ?? []) as Array<{
      mask_id: string | null;
      fit_outcome: "good" | "leaking" | "uncomfortable";
    }>;
    const byMask = tallyOutcomesByMask(
      rows.map((r) => ({ maskId: r.mask_id, fitOutcome: r.fit_outcome })),
    );
    const adjustments = computeFitAdjustments(byMask);
    const masks = Object.entries(byMask)
      .map(([maskId, counts]) => ({
        maskId,
        counts,
        total: counts.good + counts.leaking + counts.uncomfortable,
        adjustment: adjustments[maskId] ?? 1, // 1.0 = neutral (below threshold)
      }))
      .sort((a, b) => b.total - a.total);
    res.json({ masks, adjustments, attributedOutcomes: rows.length });
  },
);

const triageSchema = z
  .object({ status: z.enum(["reviewed", "actioned"]) })
  .strip();

router.post(
  "/admin/clinical/mask-fit/:id/triage",
  requirePermission("clinical.intervention.write"),
  async (req, res) => {
    const idOk = z.string().uuid().safeParse(req.params.id);
    if (!idOk.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const parsed = triageSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("mask_fit_outcomes")
      .update({
        status: parsed.data.status,
        reviewed_by_email: req.adminEmail ?? "unknown",
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", idOk.data)
      .select("id")
      .maybeSingle();
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ ok: true, status: parsed.data.status });
  },
);

export default router;
