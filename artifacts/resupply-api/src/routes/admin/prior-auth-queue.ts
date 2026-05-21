// GET /admin/billing/prior-auth-queue
//
// System-wide prior-authorization queue. The pa-sla-tracker job
// stamps `mco_sla_status` every 6 hours; this endpoint surfaces
// the rows that need a human now:
//
//   * atRisk    — mco_sla_status = 'at_risk'   (≤ 2 days remaining)
//   * missed    — mco_sla_status = 'missed'    (SLA target passed
//                                                without a decision)
//   * awaiting  — status = 'submitted' and no SLA status yet (PA in
//                 flight, payer hasn't responded)
//   * expiring  — status = 'approved' and approved_through ≤ today + 30
//                 (current auth that will lapse soon — re-auth before
//                  the next dispense)
//   * draft     — status = 'draft' (auth captured but not yet
//                 submitted to payer)
//
// All buckets are returned with daysToTarget (signed; negative =
// past due) and daysToExpiry where applicable. Per-row payload
// excludes member-id and demographics — only the IDs needed to
// deep-link into the existing per-patient PA workbench.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const querySchema = z
  .object({
    expiringWithinDays: z.coerce.number().int().positive().max(180).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

interface BucketRow {
  id: string;
  patientId: string;
  payerName: string;
  hcpcsCode: string;
  status: string;
  authNumber: string | null;
  submittedAt: string | null;
  decisionAt: string | null;
  approvedThrough: string | null;
  mcoSlaStatus: string | null;
  mcoSlaTargetDate: string | null;
  daysToTarget: number | null;
  daysToExpiry: number | null;
  createdAt: string;
  updatedAt: string;
}

function daysBetween(future: string | null, now: number): number | null {
  if (!future) return null;
  const t = new Date(future).getTime();
  if (Number.isNaN(t)) return null;
  // Avoid Math.round near a midday boundary — it can flip an
  // identical clock-time between adjacent day counts depending on
  // whether the comparison runs in the AM or PM. Use floor for
  // future targets ("3 days remaining" stays 3 from now+3.0d down
  // to now+3.99d) and ceil for past targets ("2 days past" stays 2
  // from now-2.01d down to now-2.99d).
  const deltaDays = (t - now) / (24 * 3600 * 1000);
  return deltaDays >= 0 ? Math.floor(deltaDays) : Math.ceil(deltaDays);
}

router.get(
  "/admin/billing/prior-auth-queue",
  requirePermission("patients.update"),
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_query",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const { expiringWithinDays = 30, limit = 100 } = parsed.data;
    const now = Date.now();
    const expiryCutoff = new Date(
      now + expiringWithinDays * 24 * 3600 * 1000,
    )
      .toISOString()
      .slice(0, 10); // approved_through is a DATE
    const todayIso = new Date(now).toISOString().slice(0, 10);

    const supabase = getSupabaseServiceRoleClient();
    const selectCols =
      "id, patient_id, payer_name, hcpcs_code, status, auth_number, submitted_at, decision_at, approved_through, mco_sla_status, mco_sla_target_date, created_at, updated_at";

    const [
      { data: atRisk, error: atRiskErr },
      { data: missed, error: missedErr },
      { data: awaiting, error: awaitingErr },
      { data: expiring, error: expiringErr },
      { data: drafts, error: draftsErr },
    ] = await Promise.all([
      supabase
        .schema("resupply")
        .from("prior_authorizations")
        .select(selectCols)
        .eq("mco_sla_status", "at_risk")
        .in("status", ["submitted", "appealed"])
        .order("mco_sla_target_date", { ascending: true })
        .limit(limit),
      supabase
        .schema("resupply")
        .from("prior_authorizations")
        .select(selectCols)
        .eq("mco_sla_status", "missed")
        .in("status", ["submitted", "appealed"])
        .order("mco_sla_target_date", { ascending: true })
        .limit(limit),
      supabase
        .schema("resupply")
        .from("prior_authorizations")
        .select(selectCols)
        .in("status", ["submitted", "appealed"])
        .is("mco_sla_status", null)
        .is("decision_at", null)
        .order("submitted_at", { ascending: true })
        .limit(limit),
      supabase
        .schema("resupply")
        .from("prior_authorizations")
        .select(selectCols)
        .eq("status", "approved")
        .not("approved_through", "is", null)
        .gte("approved_through", todayIso)
        .lte("approved_through", expiryCutoff)
        .order("approved_through", { ascending: true })
        .limit(limit),
      supabase
        .schema("resupply")
        .from("prior_authorizations")
        .select(selectCols)
        .eq("status", "draft")
        .order("created_at", { ascending: true })
        .limit(limit),
    ]);
    if (atRiskErr) throw atRiskErr;
    if (missedErr) throw missedErr;
    if (awaitingErr) throw awaitingErr;
    if (expiringErr) throw expiringErr;
    if (draftsErr) throw draftsErr;

    function shape(rows: typeof atRisk): BucketRow[] {
      return (rows ?? []).map((r) => ({
        id: r.id,
        patientId: r.patient_id,
        payerName: r.payer_name,
        hcpcsCode: r.hcpcs_code,
        status: r.status,
        authNumber: r.auth_number,
        submittedAt: r.submitted_at,
        decisionAt: r.decision_at,
        approvedThrough: r.approved_through,
        mcoSlaStatus: r.mco_sla_status,
        mcoSlaTargetDate: r.mco_sla_target_date,
        daysToTarget: daysBetween(r.mco_sla_target_date, now),
        daysToExpiry: daysBetween(r.approved_through, now),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
    }

    const atRiskRows = shape(atRisk);
    const missedRows = shape(missed);
    const awaitingRows = shape(awaiting);
    const expiringRows = shape(expiring);
    const draftRows = shape(drafts);

    res.json({
      atRisk: atRiskRows,
      missed: missedRows,
      awaiting: awaitingRows,
      expiringSoon: expiringRows,
      drafts: draftRows,
      counts: {
        atRisk: atRiskRows.length,
        missed: missedRows.length,
        awaiting: awaitingRows.length,
        expiringSoon: expiringRows.length,
        drafts: draftRows.length,
      },
      expiringWithinDays,
      generatedAt: new Date().toISOString(),
    });
  },
);

export default router;
