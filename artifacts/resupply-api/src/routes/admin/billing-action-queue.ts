// /admin/billing/action-queue — the biller's morning triage roll-up.
//
//   GET /admin/billing/action-queue
//
// The denials worklist (per-claim, ranked) and the secondary-eligible
// list already exist; what was missing is the ONE screen that tells a
// biller "here's how much actionable money is sitting in each bucket
// right now" so they can decide where to spend the next hour. This is a
// read-only cross-worklist summary — it does NOT auto-generate appeals or
// secondary claims (that stays a deliberate human click on the existing
// worklists). It groups the actionable denials by the AI's recommended
// action and adds the count + balance of primary-paid claims eligible to
// bill a secondary.
//
// reports.read-gated. Reuses loadDenialInputs + rankDenialWorklist so the
// denial numbers match the worklist exactly. Grouping core is pure +
// unit-tested.

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";
import {
  loadDenialInputs,
  rankDenialWorklist,
  type DenialRecommendation,
  type DenialWorkItem,
} from "./denials-worklist";

const router: IRouter = Router();

export const DENIAL_ACTIONS: readonly (
  | DenialRecommendation
  | "unclassified"
)[] = [
  "auto_resubmit",
  "manual_resubmit",
  "appeal",
  "bill_patient",
  "write_off",
  "manual_review",
  "unclassified",
];

export interface DenialActionBucket {
  count: number;
  recoverableCents: number;
  /** Σ(recoverable × win-prob) — expected recoverable dollars. */
  expectedRecoverableCents: number;
}

export type DenialActionSummary = Record<
  DenialRecommendation | "unclassified",
  DenialActionBucket
>;

function emptyBucket(): DenialActionBucket {
  return { count: 0, recoverableCents: 0, expectedRecoverableCents: 0 };
}

/**
 * Pure: bucket ranked denial work-items by their recommended action.
 * Claims with no AI recommendation land in `unclassified`. No I/O —
 * unit-tested directly.
 */
export function summarizeDenialActions(
  items: readonly DenialWorkItem[],
): DenialActionSummary {
  const summary = Object.fromEntries(
    DENIAL_ACTIONS.map((a) => [a, emptyBucket()]),
  ) as DenialActionSummary;
  for (const i of items) {
    const key: DenialRecommendation | "unclassified" =
      i.recommendation ?? "unclassified";
    const bucket = summary[key];
    bucket.count += 1;
    bucket.recoverableCents += i.recoverableCents;
    bucket.expectedRecoverableCents += i.scoreCents;
  }
  return summary;
}

router.get(
  "/admin/billing/action-queue",
  adminReadRateLimiter,
  requirePermission("reports.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();

    const loaded = await loadDenialInputs(supabase);
    if (!loaded.ok) {
      res.status(500).json({ error: "query_failed", message: loaded.message });
      return;
    }
    const worklist = rankDenialWorklist(loaded.inputs);
    const byAction = summarizeDenialActions(worklist.items);

    // Secondary-eligible: primary-paid claims with a secondary coverage
    // on file and a remaining patient balance to bill onward.
    const { data: secondaries, error: secErr } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select("patient_responsibility_cents")
      .eq("payer_sequence", "primary")
      .eq("status", "paid")
      .not("secondary_coverage_id", "is", null)
      .gt("patient_responsibility_cents", 0)
      .limit(500);
    if (secErr) {
      res.status(500).json({ error: "query_failed", message: secErr.message });
      return;
    }
    const secRows = (secondaries ?? []) as Array<{
      patient_responsibility_cents: number | null;
    }>;
    const secondaryBillableCents = secRows.reduce(
      (s, r) => s + (r.patient_responsibility_cents ?? 0),
      0,
    );

    res.json({
      denials: {
        byAction,
        totals: worklist.totals,
      },
      secondaryEligible: {
        count: secRows.length,
        billableCents: secondaryBillableCents,
      },
      generatedAt: new Date().toISOString(),
    });
  },
);

export default router;
