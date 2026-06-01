// /admin/billing/payer-profitability — net-yield by payer (Owner #2,
// Phase 2). Answers "are we actually making money with Payer X?": for
// each payer, billed → allowed → collected, the current denial rate,
// and net of the F1 COGS captured on the claim lines.
//
//   GET /admin/billing/payer-profitability?days=180
//
// Pure rollup (buildPayerProfitability) is unit-tested. COGS is
// OPTIONAL per the F1 honesty rule: a claim with no costed line counts
// toward revenue but is disclosed in the costed/uncosted claim split,
// never treated as zero-cost. cost.read-gated (finance data). Aggregates
// only — payer + dollar rollups, no per-patient PHI.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

export interface PayerClaimInput {
  payerKey: string;
  payerName: string | null;
  status: string;
  billedCents: number;
  allowedCents: number;
  paidCents: number;
  /** Summed known COGS for this claim's lines, or null when none costed. */
  costCents: number | null;
}

export interface PayerProfitability {
  payerKey: string;
  payerName: string | null;
  claimCount: number;
  deniedCount: number;
  /** Current-status denials ÷ claims. null when no claims. */
  denialRate: number | null;
  billedCents: number;
  allowedCents: number;
  paidCents: number;
  /** paid ÷ billed. null when nothing billed. */
  collectionRate: number | null;
  /** allowed ÷ billed. null when nothing billed. */
  allowedRate: number | null;
  /** Sum of KNOWN line COGS across the payer's claims. */
  costKnownCents: number;
  claimsWithCost: number;
  claimsWithoutCost: number;
  /** paid − known COGS (net of the cost we can see). */
  netCents: number;
  /** net ÷ billed. null when nothing billed. */
  netYieldRatio: number | null;
}

export interface PayerProfitabilityReport {
  payers: PayerProfitability[];
  totals: {
    claimCount: number;
    billedCents: number;
    allowedCents: number;
    paidCents: number;
    costKnownCents: number;
    netCents: number;
    claimsWithCost: number;
    claimsWithoutCost: number;
  };
}

/**
 * Pure: group claims by payer and roll up billed/allowed/paid, denial
 * rate, and net-of-known-COGS. Sorted by collected dollars desc (the
 * payers that matter most to cash first). Keeps the costed/uncosted
 * claim split explicit so a payer with no captured cost can't look
 * artificially profitable.
 */
export function buildPayerProfitability(
  claims: readonly PayerClaimInput[],
): PayerProfitabilityReport {
  const byPayer = new Map<string, PayerProfitability>();

  for (const c of claims) {
    let p = byPayer.get(c.payerKey);
    if (!p) {
      p = {
        payerKey: c.payerKey,
        payerName: c.payerName,
        claimCount: 0,
        deniedCount: 0,
        denialRate: null,
        billedCents: 0,
        allowedCents: 0,
        paidCents: 0,
        collectionRate: null,
        allowedRate: null,
        costKnownCents: 0,
        claimsWithCost: 0,
        claimsWithoutCost: 0,
        netCents: 0,
        netYieldRatio: null,
      };
      byPayer.set(c.payerKey, p);
    }
    p.claimCount += 1;
    if (c.status === "denied") p.deniedCount += 1;
    p.billedCents += c.billedCents;
    p.allowedCents += c.allowedCents;
    p.paidCents += c.paidCents;
    if (c.costCents != null) {
      p.costKnownCents += c.costCents;
      p.claimsWithCost += 1;
    } else {
      p.claimsWithoutCost += 1;
    }
  }

  const payers = [...byPayer.values()].map((p) => {
    p.denialRate = p.claimCount > 0 ? p.deniedCount / p.claimCount : null;
    p.collectionRate = p.billedCents > 0 ? p.paidCents / p.billedCents : null;
    p.allowedRate = p.billedCents > 0 ? p.allowedCents / p.billedCents : null;
    p.netCents = p.paidCents - p.costKnownCents;
    p.netYieldRatio = p.billedCents > 0 ? p.netCents / p.billedCents : null;
    return p;
  });
  payers.sort((a, b) => b.paidCents - a.paidCents);

  const totals = payers.reduce(
    (acc, p) => {
      acc.claimCount += p.claimCount;
      acc.billedCents += p.billedCents;
      acc.allowedCents += p.allowedCents;
      acc.paidCents += p.paidCents;
      acc.costKnownCents += p.costKnownCents;
      acc.netCents += p.netCents;
      acc.claimsWithCost += p.claimsWithCost;
      acc.claimsWithoutCost += p.claimsWithoutCost;
      return acc;
    },
    {
      claimCount: 0,
      billedCents: 0,
      allowedCents: 0,
      paidCents: 0,
      costKnownCents: 0,
      netCents: 0,
      claimsWithCost: 0,
      claimsWithoutCost: 0,
    },
  );

  return { payers, totals };
}

const querySchema = z
  .object({ days: z.coerce.number().int().min(1).max(730).optional() })
  .strip();

router.get(
  "/admin/billing/payer-profitability",
  // Rate-limit before the auth gate (CodeQL "missing rate limiting").
  adminReadRateLimiter,
  requirePermission("cost.read"),
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    const days = parsed.success ? (parsed.data.days ?? 180) : 180;
    const cutoff = new Date(Date.now() - days * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const supabase = getSupabaseServiceRoleClient();
    const { data: claims, error } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select(
        "id, payer_name, payer_profile_id, status, total_billed_cents, total_allowed_cents, total_paid_cents",
      )
      .gte("date_of_service", cutoff)
      .limit(5000);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    const claimRows = (claims ?? []) as Array<Record<string, unknown>>;

    // Batch the line-item COGS for those claims; sum the KNOWN per-line
    // costs per claim_id.
    const claimIds = claimRows
      .map((c) => (typeof c.id === "string" ? c.id : null))
      .filter((v): v is string => v != null);
    const costByClaim = new Map<string, number>();
    const claimHasCost = new Set<string>();
    if (claimIds.length > 0) {
      const { data: lines, error: linesErr } = await supabase
        .schema("resupply")
        .from("insurance_claim_line_items")
        .select("claim_id, quantity, unit_cost_cents")
        .in("claim_id", claimIds)
        .limit(20000);
      if (linesErr) {
        res
          .status(500)
          .json({ error: "query_failed", message: linesErr.message });
        return;
      }
      for (const l of (lines ?? []) as Array<Record<string, unknown>>) {
        const cid = typeof l.claim_id === "string" ? l.claim_id : "";
        if (cid === "" || typeof l.unit_cost_cents !== "number") continue;
        const qty =
          typeof l.quantity === "number" && l.quantity > 0 ? l.quantity : 1;
        costByClaim.set(
          cid,
          (costByClaim.get(cid) ?? 0) + l.unit_cost_cents * qty,
        );
        claimHasCost.add(cid);
      }
    }

    const numeric = (v: unknown): number => (typeof v === "number" ? v : 0);
    const report = buildPayerProfitability(
      claimRows.map((c) => {
        const id = typeof c.id === "string" ? c.id : "";
        const payerProfileId =
          typeof c.payer_profile_id === "string" ? c.payer_profile_id : null;
        const payerName =
          typeof c.payer_name === "string" ? c.payer_name : null;
        return {
          payerKey: payerProfileId ?? payerName ?? "unknown",
          payerName,
          status: String(c.status ?? ""),
          billedCents: numeric(c.total_billed_cents),
          allowedCents: numeric(c.total_allowed_cents),
          paidCents: numeric(c.total_paid_cents),
          costCents: claimHasCost.has(id) ? (costByClaim.get(id) ?? 0) : null,
        };
      }),
    );

    res.json({
      windowDays: days,
      ...report,
      generatedAt: new Date().toISOString(),
    });
  },
);

export default router;
