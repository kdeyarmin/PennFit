// /admin/billing/timely-filing — open-claim filing-deadline worklist
// (Biller #36).
//
//   GET /admin/billing/timely-filing?status=overdue|due_soon|ok|unknown|all
//
// Every payer auto-denies a claim filed past its timely-filing window
// (payer_profiles.timely_filing_days, counted from date_of_service) with
// no appeal. This ranks every still-open claim by how close it is to
// that deadline so the biller files the at-risk ones before they age
// out. The countdown math is the shared, unit-tested timelyFilingStatus
// helper in @workspace/resupply-domain; the pure row-builder here is
// also unit-tested. The route only fetches claims + the per-payer window
// (a soft FK → batch lookup, not a PostgREST embed) and delegates.
//
// reports.read-gated (the billing-read permission). The response carries
// claim metadata only (id, payer, dollars, dates, status) — no PHI
// beyond what the biller already sees on the claim list; no notes,
// no free text.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  timelyFilingStatus,
  type TimelyFilingStatus,
} from "@workspace/resupply-domain";

import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// Claim statuses that still carry filing pressure. `paid` and `closed`
// are terminal — no deadline left to chase.
const OPEN_STATUSES = [
  "draft",
  "submitted",
  "accepted",
  "denied",
  "appealed",
] as const;

export interface TimelyFilingClaimInput {
  id: string;
  patientId: string;
  payerName: string | null;
  status: string;
  dateOfService: string;
  totalBilledCents: number | null;
  /** payer_profiles.timely_filing_days for this claim's payer, or null. */
  filingWindowDays: number | null;
}

export interface TimelyFilingClaimRow {
  id: string;
  patientId: string;
  payerName: string | null;
  status: string;
  dateOfService: string;
  totalBilledCents: number | null;
  filingStatus: TimelyFilingStatus;
  daysRemaining: number | null;
  deadline: string | null;
}

export interface TimelyFilingWorklist {
  rows: TimelyFilingClaimRow[];
  counts: {
    overdue: number;
    dueSoon: number;
    ok: number;
    unknown: number;
    total: number;
  };
}

/**
 * Pure: map each open claim to its filing countdown, sort most-urgent
 * first (fewest days remaining; unknown-window claims sort last), and
 * roll up the status buckets. No I/O — unit-tested directly.
 */
export function buildTimelyFilingWorklist(
  claims: TimelyFilingClaimInput[],
  opts?: { asOf?: string; dueSoonThresholdDays?: number },
): TimelyFilingWorklist {
  const rows: TimelyFilingClaimRow[] = claims.map((c) => {
    const r = timelyFilingStatus({
      dateOfService: c.dateOfService,
      filingWindowDays: c.filingWindowDays,
      asOf: opts?.asOf,
      dueSoonThresholdDays: opts?.dueSoonThresholdDays,
    });
    return {
      id: c.id,
      patientId: c.patientId,
      payerName: c.payerName,
      status: c.status,
      dateOfService: c.dateOfService,
      totalBilledCents: c.totalBilledCents,
      filingStatus: r.status,
      daysRemaining: r.daysRemaining,
      deadline: r.deadline,
    };
  });

  // Most-urgent first. Unknown window (null daysRemaining) can't be
  // ranked, so it sinks to the bottom rather than masquerading as "0".
  rows.sort((a, b) => {
    if (a.daysRemaining == null && b.daysRemaining == null) return 0;
    if (a.daysRemaining == null) return 1;
    if (b.daysRemaining == null) return -1;
    return a.daysRemaining - b.daysRemaining;
  });

  const counts = {
    overdue: 0,
    dueSoon: 0,
    ok: 0,
    unknown: 0,
    total: rows.length,
  };
  for (const r of rows) {
    if (r.filingStatus === "overdue") counts.overdue += 1;
    else if (r.filingStatus === "due_soon") counts.dueSoon += 1;
    else if (r.filingStatus === "ok") counts.ok += 1;
    else counts.unknown += 1;
  }

  return { rows, counts };
}

const querySchema = z
  .object({
    status: z.enum(["all", "overdue", "due_soon", "ok", "unknown"]).optional(),
  })
  .strip();

router.get(
  "/admin/billing/timely-filing",
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    const statusFilter = parsed.success ? parsed.data.status : undefined;

    const supabase = getSupabaseServiceRoleClient();
    const { data: claims, error } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select(
        "id, patient_id, payer_name, status, date_of_service, total_billed_cents, payer_profile_id",
      )
      .in("status", OPEN_STATUSES as unknown as string[])
      .order("date_of_service", { ascending: true })
      .limit(500);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    const claimRows = (claims ?? []) as Array<Record<string, unknown>>;

    // Batch-resolve the per-payer filing window. payer_profile_id is a
    // soft FK (no DB constraint), so PostgREST can't embed it — collect
    // the distinct ids and do one IN lookup.
    const payerIds = [
      ...new Set(
        claimRows
          .map((c) => c.payer_profile_id)
          .filter((v): v is string => typeof v === "string"),
      ),
    ];
    const windowByPayer = new Map<string, number | null>();
    if (payerIds.length > 0) {
      const { data: payers, error: payerErr } = await supabase
        .schema("resupply")
        .from("payer_profiles")
        .select("id, timely_filing_days")
        .in("id", payerIds);
      if (payerErr) {
        res
          .status(500)
          .json({ error: "query_failed", message: payerErr.message });
        return;
      }
      for (const p of (payers ?? []) as Array<Record<string, unknown>>) {
        windowByPayer.set(
          String(p.id),
          typeof p.timely_filing_days === "number"
            ? p.timely_filing_days
            : null,
        );
      }
    }

    const worklist = buildTimelyFilingWorklist(
      claimRows.map((c) => ({
        id: String(c.id),
        patientId: String(c.patient_id),
        payerName: typeof c.payer_name === "string" ? c.payer_name : null,
        status: String(c.status),
        dateOfService: String(c.date_of_service),
        totalBilledCents:
          typeof c.total_billed_cents === "number"
            ? c.total_billed_cents
            : null,
        filingWindowDays:
          typeof c.payer_profile_id === "string"
            ? (windowByPayer.get(c.payer_profile_id) ?? null)
            : null,
      })),
    );

    const rows =
      statusFilter && statusFilter !== "all"
        ? worklist.rows.filter((r) => r.filingStatus === statusFilter)
        : worklist.rows;

    res.json({
      claims: rows,
      counts: worklist.counts,
      generatedAt: new Date().toISOString(),
    });
  },
);

export default router;
