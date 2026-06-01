// /admin/billing/collections-forecast — AR collections projection
// (Owner #4, slice 1).
//
//   GET /admin/billing/collections-forecast
//       ?expectedDaysToPay=45&defaultAllowedRatio=0.5&collectionProbability=0.95
//
// Loads outstanding (submitted/accepted) claims and projects expected
// cash by horizon. The projection model + its assumptions live in
// lib/billing/collections-forecast.ts; assumptions are query-tunable and
// echoed back so the owner sees exactly what drove the number. Money +
// counts only — no PHI. reports.read.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  OUTSTANDING_AR_STATUSES,
  projectClaimCollections,
  type OutstandingClaim,
} from "../../lib/billing/collections-forecast";
import {
  projectForwardOrderBook,
  type DuePrescription,
} from "../../lib/billing/forward-order-book";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const querySchema = z
  .object({
    expectedDaysToPay: z.coerce.number().int().min(1).max(365).optional(),
    defaultAllowedRatio: z.coerce.number().min(0).max(1).optional(),
    collectionProbability: z.coerce.number().min(0).max(1).optional(),
  })
  .strip();

router.get(
  "/admin/billing/collections-forecast",
  adminReadRateLimiter,
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select("status, total_billed_cents, total_allowed_cents, submitted_at")
      .in("status", [...OUTSTANDING_AR_STATUSES])
      .limit(5000);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }

    const forecast = projectClaimCollections(
      (data ?? []) as unknown as OutstandingClaim[],
      {
        expectedDaysToPay: parsed.data.expectedDaysToPay,
        defaultAllowedRatio: parsed.data.defaultAllowedRatio,
        collectionProbability: parsed.data.collectionProbability,
      },
    );

    res.json(forecast);
  },
);

const orderBookQuery = z
  .object({
    expectedOrderValueCents: z.coerce
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .optional(),
    confirmRate: z.coerce.number().min(0).max(1).optional(),
    horizonDays: z.coerce.number().int().min(1).max(365).optional(),
  })
  .strip();

// Forward resupply order book (Owner #4 slice 2): expected NEW resupply
// revenue from prescriptions becoming eligible within the horizon, from
// real cadence + last-fill, with tunable value/confirm-rate assumptions.
router.get(
  "/admin/billing/forward-order-book",
  adminReadRateLimiter,
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = orderBookQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();

    const { data: rx, error: rxErr } = await supabase
      .schema("resupply")
      .from("prescriptions")
      .select("patient_id, item_sku, cadence_days")
      .eq("status", "active")
      .limit(5000);
    if (rxErr) {
      res.status(500).json({ error: "query_failed", message: rxErr.message });
      return;
    }
    const prescriptions = (rx ?? []) as Array<{
      patient_id: string;
      item_sku: string;
      cadence_days: number;
    }>;

    // Most-recent fulfillment per (patient, sku) — the resupply anchor.
    const lastFill = new Map<string, string>();
    if (prescriptions.length > 0) {
      const { data: fills, error: fErr } = await supabase
        .schema("resupply")
        .from("fulfillments")
        .select("patient_id, item_sku, created_at")
        .order("created_at", { ascending: false })
        .limit(20000);
      if (fErr) {
        res.status(500).json({ error: "query_failed", message: fErr.message });
        return;
      }
      for (const f of (fills ?? []) as Array<{
        patient_id: string;
        item_sku: string;
        created_at: string;
      }>) {
        const k = `${f.patient_id}|${f.item_sku}`;
        if (!lastFill.has(k)) lastFill.set(k, f.created_at); // first = newest
      }
    }

    const due: DuePrescription[] = prescriptions.map((p) => ({
      lastFillIso: lastFill.get(`${p.patient_id}|${p.item_sku}`) ?? null,
      cadenceDays: p.cadence_days,
    }));

    const book = projectForwardOrderBook(due, {
      expectedOrderValueCents: parsed.data.expectedOrderValueCents,
      confirmRate: parsed.data.confirmRate,
      horizonDays: parsed.data.horizonDays,
    });
    res.json(book);
  },
);

export default router;
