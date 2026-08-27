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

import { getOrgScopedClient } from "@workspace/resupply-db";

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

/** PostgREST page size (matches max_rows default). */
const PAGE = 1000;
const OUTSTANDING_CLAIMS_MAX = 5000;
const ACTIVE_RX_MAX = 5000;
const FULFILLMENTS_MAX = 20000;

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

    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    // Page past PostgREST max_rows — a bare `.limit(5000)` silently
    // truncates to ~1000 unordered rows and understates AR.
    const rows: OutstandingClaim[] = [];
    for (let offset = 0; offset < OUTSTANDING_CLAIMS_MAX; offset += PAGE) {
      const { data, error } = await supabase
        .from("insurance_claims")
        .select(
          "status, total_billed_cents, total_allowed_cents, total_paid_cents, submitted_at",
        )
        .in("status", [...OUTSTANDING_AR_STATUSES])
        .order("submitted_at", { ascending: false, nullsFirst: false })
        .order("id", { ascending: false })
        .range(offset, offset + PAGE - 1);
      if (error) {
        res.status(500).json({ error: "query_failed", message: error.message });
        return;
      }
      const page = (data ?? []) as OutstandingClaim[];
      rows.push(...page);
      if (page.length < PAGE) break;
    }

    const forecast = projectClaimCollections(rows, {
      expectedDaysToPay: parsed.data.expectedDaysToPay,
      defaultAllowedRatio: parsed.data.defaultAllowedRatio,
      collectionProbability: parsed.data.collectionProbability,
    });

    res.json({
      ...forecast,
      windowTruncated: rows.length >= OUTSTANDING_CLAIMS_MAX,
    });
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
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    type RxRow = {
      patient_id: string;
      item_sku: string;
      cadence_days: number;
    };
    const prescriptions: RxRow[] = [];
    for (let offset = 0; offset < ACTIVE_RX_MAX; offset += PAGE) {
      const { data: rx, error: rxErr } = await supabase
        .from("prescriptions")
        .select("patient_id, item_sku, cadence_days")
        .eq("status", "active")
        .order("id", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (rxErr) {
        res.status(500).json({ error: "query_failed", message: rxErr.message });
        return;
      }
      const page = (rx ?? []) as RxRow[];
      prescriptions.push(...page);
      if (page.length < PAGE) break;
    }
    const rxWindowTruncated = prescriptions.length >= ACTIVE_RX_MAX;

    // Most-recent fulfillment per needed (patient, sku). Page newest-first
    // and stop once every active-rx key has an anchor (or the safety
    // window fills). A bare `.limit(20000)` was truncated by PostgREST to
    // ~1000 unordered rows, so many last-fills looked "never filled".
    const needed = new Set(
      prescriptions.map((p) => `${p.patient_id}|${p.item_sku}`),
    );
    const lastFill = new Map<string, string>();
    let fillsScanned = 0;
    if (needed.size > 0) {
      for (let offset = 0; offset < FULFILLMENTS_MAX; offset += PAGE) {
        if (lastFill.size >= needed.size) break;
        const { data: fills, error: fErr } = await supabase
          .from("fulfillments")
          .select("patient_id, item_sku, created_at")
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(offset, offset + PAGE - 1);
        if (fErr) {
          res
            .status(500)
            .json({ error: "query_failed", message: fErr.message });
          return;
        }
        const page = (fills ?? []) as Array<{
          patient_id: string;
          item_sku: string;
          created_at: string;
        }>;
        fillsScanned += page.length;
        for (const f of page) {
          const k = `${f.patient_id}|${f.item_sku}`;
          if (needed.has(k) && !lastFill.has(k)) {
            lastFill.set(k, f.created_at);
          }
        }
        if (page.length < PAGE) break;
      }
    }
    const fillsWindowTruncated =
      fillsScanned >= FULFILLMENTS_MAX && lastFill.size < needed.size;

    const due: DuePrescription[] = prescriptions.map((p) => ({
      lastFillIso: lastFill.get(`${p.patient_id}|${p.item_sku}`) ?? null,
      cadenceDays: p.cadence_days,
    }));

    const book = projectForwardOrderBook(due, {
      expectedOrderValueCents: parsed.data.expectedOrderValueCents,
      confirmRate: parsed.data.confirmRate,
      horizonDays: parsed.data.horizonDays,
    });
    res.json({
      ...book,
      windowTruncated: rxWindowTruncated || fillsWindowTruncated,
    });
  },
);

export default router;
