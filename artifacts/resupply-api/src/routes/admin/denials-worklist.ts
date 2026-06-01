// /admin/billing/denials-worklist — denied claims ranked by recoverable
// dollars × win-probability (Biller #33, Phase 5).
//
//   GET /admin/billing/denials-worklist
//
// The denial-rate page + the AI billing queue already exist; this is the
// missing *worklist UX* — a single ranked list that tells the biller
// which denial to work next for the most recoverable money at the best
// odds. Recoverable = billed − paid; win-probability is the AI analysis
// confidence (or a conservative default when a claim hasn't been
// analyzed yet). One-click resubmit/appeal happens on the existing claim
// workbench, deep-linked per row.
//
// reports.read-gated (billing-read). Ranking core is pure + unit-tested.
// Returns claim metadata + the denial recommendation enum / confidence —
// no patient clinical data; the free-text root cause stays on the claim
// detail, not in this list.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// Win-probability assumed for a denied claim with no AI analysis yet —
// deliberately modest so analyzed, high-confidence denials outrank the
// unknowns of similar dollar value.
const DEFAULT_WIN_PROBABILITY = 0.3;

export type DenialRecommendation =
  | "auto_resubmit"
  | "manual_resubmit"
  | "appeal"
  | "bill_patient"
  | "write_off"
  | "manual_review";

export interface DenialClaimInput {
  claimId: string;
  patientId: string;
  payerName: string | null;
  recoverableCents: number;
  /** AI analysis confidence 0..1, or null when not analyzed. */
  confidence: number | null;
  recommendation: DenialRecommendation | null;
  canAutoResubmit: boolean;
  denialReason: string | null;
  decisionAt: string | null;
}

export interface DenialWorkItem extends DenialClaimInput {
  /** confidence ?? default, clamped to [0,1]. */
  winProbability: number;
  /** recoverableCents × winProbability — the ranking key. */
  scoreCents: number;
  hasAnalysis: boolean;
}

export interface DenialsWorklist {
  items: DenialWorkItem[];
  totals: {
    count: number;
    recoverableCents: number;
    /** Σ(recoverable × win-prob) — expected recoverable dollars. */
    expectedRecoverableCents: number;
    autoResubmittable: number;
    unanalyzed: number;
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Pure: score each denied claim by recoverable dollars × win-probability
 * and sort highest-value-at-best-odds first. Unanalyzed claims get a
 * conservative default probability so a freshly-denied big claim still
 * surfaces, but a high-confidence analyzed one of equal size ranks above
 * it. No I/O — unit-tested directly.
 */
export function rankDenialWorklist(
  claims: readonly DenialClaimInput[],
): DenialsWorklist {
  const items: DenialWorkItem[] = claims.map((c) => {
    const hasAnalysis = c.confidence != null || c.recommendation != null;
    const winProbability =
      c.confidence != null ? clamp01(c.confidence) : DEFAULT_WIN_PROBABILITY;
    const recoverableCents = Math.max(0, Math.trunc(c.recoverableCents));
    return {
      ...c,
      recoverableCents,
      winProbability,
      scoreCents: Math.round(recoverableCents * winProbability),
      hasAnalysis,
    };
  });

  items.sort((a, b) => b.scoreCents - a.scoreCents);

  const totals = items.reduce(
    (acc, i) => {
      acc.count += 1;
      acc.recoverableCents += i.recoverableCents;
      acc.expectedRecoverableCents += i.scoreCents;
      if (i.canAutoResubmit) acc.autoResubmittable += 1;
      if (!i.hasAnalysis) acc.unanalyzed += 1;
      return acc;
    },
    {
      count: 0,
      recoverableCents: 0,
      expectedRecoverableCents: 0,
      autoResubmittable: 0,
      unanalyzed: 0,
    },
  );

  return { items, totals };
}

// Latest-analysis review states that mean the denial is already handled
// — exclude those claims from the actionable worklist.
const RESOLVED_REVIEW_STATES = new Set([
  "accepted_resubmitted",
  "accepted_appealed",
  "accepted_written_off",
]);

const querySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(500).optional() })
  .strip();

router.get(
  "/admin/billing/denials-worklist",
  // Rate-limit before the auth gate (CodeQL "missing rate limiting").
  adminReadRateLimiter,
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    const limit = parsed.success ? (parsed.data.limit ?? 200) : 200;

    const supabase = getSupabaseServiceRoleClient();
    const { data: claims, error } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select(
        "id, patient_id, payer_name, total_billed_cents, total_paid_cents, denial_reason, decision_at",
      )
      .eq("status", "denied")
      .order("decision_at", { ascending: false })
      .limit(500);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    const claimRows = (claims ?? []) as Array<Record<string, unknown>>;
    const claimIds = claimRows
      .map((c) => (typeof c.id === "string" ? c.id : null))
      .filter((v): v is string => v != null);

    // Latest analysis per claim (rows newest-first → first seen wins).
    const analysisByClaim = new Map<string, Record<string, unknown>>();
    if (claimIds.length > 0) {
      const { data: analyses, error: aErr } = await supabase
        .schema("resupply")
        .from("claim_denial_analyses")
        .select(
          "claim_id, confidence, recommendation, can_auto_resubmit, review_status, created_at",
        )
        .in("claim_id", claimIds)
        .order("created_at", { ascending: false })
        .limit(2000);
      if (aErr) {
        res.status(500).json({ error: "query_failed", message: aErr.message });
        return;
      }
      for (const a of (analyses ?? []) as Array<Record<string, unknown>>) {
        const cid = typeof a.claim_id === "string" ? a.claim_id : "";
        if (cid && !analysisByClaim.has(cid)) analysisByClaim.set(cid, a);
      }
    }

    const inputs: DenialClaimInput[] = [];
    for (const c of claimRows) {
      const id = typeof c.id === "string" ? c.id : "";
      if (id === "") continue;
      const analysis = analysisByClaim.get(id);
      const reviewStatus = analysis ? String(analysis.review_status ?? "") : "";
      // Skip denials already resolved (resubmitted / appealed / written off).
      if (RESOLVED_REVIEW_STATES.has(reviewStatus)) continue;

      const billed =
        typeof c.total_billed_cents === "number" ? c.total_billed_cents : 0;
      const paid =
        typeof c.total_paid_cents === "number" ? c.total_paid_cents : 0;
      inputs.push({
        claimId: id,
        patientId: typeof c.patient_id === "string" ? c.patient_id : "",
        payerName: typeof c.payer_name === "string" ? c.payer_name : null,
        recoverableCents: billed - paid,
        confidence:
          analysis && typeof analysis.confidence === "number"
            ? analysis.confidence
            : null,
        recommendation: analysis
          ? ((analysis.recommendation as DenialRecommendation | null) ?? null)
          : null,
        canAutoResubmit: analysis ? analysis.can_auto_resubmit === true : false,
        denialReason:
          typeof c.denial_reason === "string" ? c.denial_reason : null,
        decisionAt: typeof c.decision_at === "string" ? c.decision_at : null,
      });
    }

    const worklist = rankDenialWorklist(inputs);
    res.json({
      items: worklist.items.slice(0, limit),
      totals: worklist.totals,
      generatedAt: new Date().toISOString(),
    });
  },
);

export default router;
