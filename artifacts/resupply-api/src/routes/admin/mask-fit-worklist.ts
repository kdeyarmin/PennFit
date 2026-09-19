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

import { getOrgScopedClient } from "@workspace/resupply-db";

import { respondInvalidBody } from "../../lib/http-validation";
import { logger } from "../../lib/logger";
import {
  adminRateLimit,
  adminReadRateLimiter,
} from "../../middlewares/admin-rate-limit";
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
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data, error } = await supabase
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

    // Resolve patient ids from the orders (single batched lookup) through
    // `fit_sessions`. `shop_orders` has no patient_id and no FK to patients,
    // so reading one there returned nothing and every row rendered with a
    // null patientId — a clinician saw a leaking-mask report with no chart
    // to open. fit_sessions.shop_order_id is a real FK to the surveyed order
    // and sits beside patient_id.
    const orderIds = [...new Set(rows.map((r) => r.order_id))];
    const patientByOrder = new Map<string, string>();
    if (orderIds.length > 0) {
      const { data: sessions, error: sessionErr } = await supabase
        .from("fit_sessions")
        .select("shop_order_id, patient_id")
        .in("shop_order_id", orderIds)
        .not("patient_id", "is", null);
      // The worklist itself is still actionable without the chart link, so a
      // failure here degrades the rows rather than failing the request.
      if (sessionErr) {
        logger.warn(
          { event: "mask_fit_worklist.patient_lookup_failed", err: sessionErr },
          "mask-fit worklist: could not resolve orders to patients",
        );
      }
      for (const s of (sessions ?? []) as Array<{
        shop_order_id: string | null;
        patient_id: string | null;
      }>) {
        if (s.shop_order_id && s.patient_id)
          patientByOrder.set(s.shop_order_id, s.patient_id);
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
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    // Page past PostgREST's max_rows cap (1000). A bare `.limit(20000)`
    // silently truncates to an UNORDERED first 1000 rows and reports the
    // partial tally as if it were complete — the exact trap the
    // fitter-outcomes analytics route documents and pages around.
    // Newest-first, so when the table outgrows the bounded window the
    // tuning signal reflects the MOST RECENT outcomes (the ones that
    // describe today's mask lineup), not a frozen oldest-20k snapshot.
    type SignalRow = {
      mask_id: string | null;
      fit_outcome: "good" | "leaking" | "uncomfortable";
    };
    const rows: SignalRow[] = [];
    const PAGE = 1000;
    const MAX_ROWS = 20000;
    for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
      const { data, error } = await supabase
        .from("mask_fit_outcomes")
        .select("mask_id, fit_outcome")
        .not("mask_id", "is", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, offset + PAGE - 1);
      if (error) {
        res.status(500).json({ error: "query_failed", message: error.message });
        return;
      }
      const page = (data ?? []) as SignalRow[];
      rows.push(...page);
      if (page.length < PAGE) break;
    }
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
    res.json({
      masks,
      adjustments,
      attributedOutcomes: rows.length,
      // True when the window filled — older outcomes beyond the most
      // recent 20k exist and are not in this tally.
      windowTruncated: rows.length >= MAX_ROWS,
    });
  },
);

const triageSchema = z
  .object({ status: z.enum(["reviewed", "actioned"]) })
  .strip();

router.post(
  "/admin/clinical/mask-fit/:id/triage",
  requirePermission("clinical.intervention.write"),
  adminRateLimit({ name: "mask_fit.triage", preset: "mutation" }),
  async (req, res) => {
    const idOk = z.string().uuid().safeParse(req.params.id);
    if (!idOk.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const parsed = triageSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      respondInvalidBody(res, parsed.error);
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data, error } = await supabase
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
