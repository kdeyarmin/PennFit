// /admin/billing/eligibility-verification-worklist — coverages due for
// (re-)verification (Biller #31, Phase 5 — the read-only half).
//
//   GET /admin/billing/eligibility-verification-worklist?staleDays=30
//
// The 270/271 round-trip already exists per-coverage; the missing piece
// is "which coverages should I re-check this week, before a claim denies
// for inactive coverage?" This ranks active coverages by verification
// urgency:
//   * never_verified  — no verified_at on file
//   * terminating_soon — termination_date within the lookahead window
//   * stale           — verified_at older than staleDays
//   * ok              — verified recently, not terminating
// The actual re-verify is still the operator-driven (or future batch)
// POST .../verify-eligibility — this surface only tells them WHO to do.
//
// reports.read-gated (billing-read). Coverage metadata only — payer /
// rank / member-id tail / dates; never the full member id or any
// clinical data. The ranking core is pure + unit-tested.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

export type VerificationStatus =
  | "never_verified"
  | "terminating_soon"
  | "stale"
  | "ok";

export interface CoverageInput {
  id: string;
  patientId: string;
  rank: string;
  payerName: string | null;
  /** Last 4 of the member id only — never the full value. */
  memberIdTail: string | null;
  verifiedAt: string | null;
  terminationDate: string | null;
}

export interface VerificationWorkItem extends CoverageInput {
  status: VerificationStatus;
  /** Whole days since verifiedAt, or null when never verified. */
  daysSinceVerified: number | null;
  /** Whole days until termination, or null when no termination date. */
  daysUntilTermination: number | null;
  /** Sort key — higher = more urgent. */
  priority: number;
}

export interface VerificationWorklist {
  items: VerificationWorkItem[];
  counts: {
    neverVerified: number;
    terminatingSoon: number;
    stale: number;
    ok: number;
    total: number;
  };
}

const DAY_MS = 86_400_000;

// Urgency ordering. terminating_soon outranks never_verified because a
// coverage about to lapse is time-boxed; both beat stale; ok sinks.
const PRIORITY: Record<VerificationStatus, number> = {
  terminating_soon: 3,
  never_verified: 2,
  stale: 1,
  ok: 0,
};

function wholeDaysBetween(fromIso: string, toMs: number): number | null {
  const fromMs = Date.parse(fromIso.slice(0, 10));
  if (Number.isNaN(fromMs)) return null;
  const toDayMs = Date.parse(new Date(toMs).toISOString().slice(0, 10));
  return Math.round((toDayMs - fromMs) / DAY_MS);
}

/**
 * Pure: classify each active coverage by verification urgency and sort
 * most-urgent first (then by the sharper of "soonest termination" /
 * "longest stale"). No I/O — unit-tested directly.
 */
export function buildVerificationWorklist(
  coverages: readonly CoverageInput[],
  opts?: {
    staleDays?: number;
    terminationLookaheadDays?: number;
    asOf?: string;
  },
): VerificationWorklist {
  const staleDays = opts?.staleDays ?? 30;
  const lookahead = opts?.terminationLookaheadDays ?? 30;
  const asOfMs = opts?.asOf ? Date.parse(opts.asOf) : Date.now();
  const nowMs = Number.isNaN(asOfMs) ? Date.now() : asOfMs;

  const items: VerificationWorkItem[] = coverages.map((c) => {
    const daysSinceVerified =
      c.verifiedAt != null ? wholeDaysBetween(c.verifiedAt, nowMs) : null;
    const daysUntilTermination =
      c.terminationDate != null
        ? (() => {
            const d = wholeDaysBetween(c.terminationDate, nowMs);
            return d == null ? null : -d; // wholeDaysBetween gives elapsed; flip to remaining
          })()
        : null;

    let status: VerificationStatus;
    if (c.verifiedAt == null) {
      status = "never_verified";
    } else if (
      daysUntilTermination != null &&
      daysUntilTermination >= 0 &&
      daysUntilTermination <= lookahead
    ) {
      status = "terminating_soon";
    } else if (daysSinceVerified != null && daysSinceVerified > staleDays) {
      status = "stale";
    } else {
      status = "ok";
    }

    return {
      ...c,
      status,
      daysSinceVerified,
      daysUntilTermination,
      priority: PRIORITY[status],
    };
  });

  items.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    // Tie-break: soonest termination first, else longest stale first.
    if (a.status === "terminating_soon" && b.status === "terminating_soon") {
      return (
        (a.daysUntilTermination ?? Infinity) -
        (b.daysUntilTermination ?? Infinity)
      );
    }
    return (b.daysSinceVerified ?? 0) - (a.daysSinceVerified ?? 0);
  });

  const counts = {
    neverVerified: 0,
    terminatingSoon: 0,
    stale: 0,
    ok: 0,
    total: items.length,
  };
  for (const i of items) {
    if (i.status === "never_verified") counts.neverVerified += 1;
    else if (i.status === "terminating_soon") counts.terminatingSoon += 1;
    else if (i.status === "stale") counts.stale += 1;
    else counts.ok += 1;
  }

  return { items, counts };
}

const querySchema = z
  .object({
    staleDays: z.coerce.number().int().min(1).max(365).optional(),
    includeOk: z.coerce.boolean().optional(),
  })
  .strip();

function memberIdTail(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  return raw.slice(-4);
}

router.get(
  "/admin/billing/eligibility-verification-worklist",
  // Rate-limit before the auth gate (CodeQL "missing rate limiting").
  adminRateLimit({ name: "eligibility_verification.list", preset: "query" }),
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    const staleDays = parsed.success ? (parsed.data.staleDays ?? 30) : 30;
    const includeOk = parsed.success ? (parsed.data.includeOk ?? false) : false;

    const supabase = getSupabaseServiceRoleClient();
    // Active coverages only: no termination date, or termination in the
    // future. (A coverage that already terminated is dead, not a
    // re-verify candidate.)
    const todayIso = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase
      .schema("resupply")
      .from("insurance_coverages")
      .select(
        "id, patient_id, rank, payer_name, member_id, verified_at, termination_date",
      )
      .or(`termination_date.is.null,termination_date.gte.${todayIso}`)
      .limit(2000);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    const rows = (data ?? []) as Array<Record<string, unknown>>;

    const worklist = buildVerificationWorklist(
      rows.map((r) => ({
        id: String(r.id),
        patientId: String(r.patient_id),
        rank: String(r.rank ?? ""),
        payerName: typeof r.payer_name === "string" ? r.payer_name : null,
        memberIdTail: memberIdTail(r.member_id),
        verifiedAt: typeof r.verified_at === "string" ? r.verified_at : null,
        terminationDate:
          typeof r.termination_date === "string" ? r.termination_date : null,
      })),
      { staleDays },
    );

    const items = includeOk
      ? worklist.items
      : worklist.items.filter((i) => i.status !== "ok");

    res.json({
      staleDays,
      items,
      counts: worklist.counts,
      generatedAt: new Date().toISOString(),
    });
  },
);

export default router;
