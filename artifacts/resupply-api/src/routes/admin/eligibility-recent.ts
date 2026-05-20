// GET /admin/billing/eligibility-recent
//
// System-wide recent eligibility checks — the workbench the
// verification team opens to spot stale coverage and follow up on
// rejected 270s. Per-patient drill-in stays at the existing
// /admin/patients/:id surface; this endpoint only returns the
// aggregate list a coordinator scans.
//
// Default window: 30 days, status in (queued, submitted, parsed,
// rejected, transport_failed). Always newest-first. Includes the
// active / in_network / requires_prior_auth flags so the UI can
// triage at a glance.
//
// PHI hygiene: we return patient_id (UUID) and the denormalised
// payer name only — no member id, no demographics. Patient names
// are NEVER exposed by this aggregate; the UI links to the
// per-patient detail page where the existing requireAdmin gate
// continues to apply.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const STATUS_VALUES = [
  "queued",
  "submitted",
  "parsed",
  "rejected",
  "transport_failed",
] as const;

const querySchema = z
  .object({
    status: z.enum(STATUS_VALUES).optional(),
    days: z.coerce.number().int().positive().max(180).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

router.get(
  "/admin/billing/eligibility-recent",
  requireAdmin,
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
    const { status, days = 30, limit = 100 } = parsed.data;
    const cutoff = new Date(
      Date.now() - days * 24 * 3600 * 1000,
    ).toISOString();
    const supabase = getSupabaseServiceRoleClient();

    let query = supabase
      .schema("resupply")
      .from("eligibility_checks")
      .select(
        "id, patient_id, insurance_coverage_id, payer_profile_id, service_hcpcs, status, is_active, in_network, deductible_cents, deductible_met_cents, oop_max_cents, oop_met_cents, copay_cents, coinsurance_pct, requires_prior_auth, error_message, requested_at, responded_at, requested_by_email",
      )
      .gte("requested_at", cutoff)
      .order("requested_at", { ascending: false })
      .limit(limit);
    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) throw error;

    // Resolve payer profile names for the rows we got back. One
    // round-trip with `in`; saves the per-row join.
    const profileIds = Array.from(
      new Set(
        (data ?? [])
          .map((r) => r.payer_profile_id)
          .filter((v): v is string => Boolean(v)),
      ),
    );
    const payerMap = new Map<string, string>();
    if (profileIds.length > 0) {
      const { data: profiles, error: profilesError } = await supabase
        .schema("resupply")
        .from("payer_profiles")
        .select("id, display_name")
        .in("id", profileIds);
      // Surface the failure rather than silently dropping payer
      // names — a 500 here is preferable to rows rendered as "—"
      // with no clue why.
      if (profilesError) throw profilesError;
      for (const p of profiles ?? []) payerMap.set(p.id, p.display_name);
    }

    // Roll up counts by status for the summary tiles.
    const byStatus: Record<(typeof STATUS_VALUES)[number], number> = {
      queued: 0,
      submitted: 0,
      parsed: 0,
      rejected: 0,
      transport_failed: 0,
    };
    let activeCount = 0;
    let inactiveCount = 0;
    let priorAuthFlagged = 0;
    for (const r of data ?? []) {
      const s = r.status as (typeof STATUS_VALUES)[number];
      if (s in byStatus) byStatus[s]++;
      if (r.is_active === true) activeCount++;
      else if (r.is_active === false) inactiveCount++;
      if (r.requires_prior_auth === true) priorAuthFlagged++;
    }

    res.json({
      checks: (data ?? []).map((r) => ({
        id: r.id,
        patientId: r.patient_id,
        insuranceCoverageId: r.insurance_coverage_id,
        payerProfileId: r.payer_profile_id,
        payerName: r.payer_profile_id
          ? (payerMap.get(r.payer_profile_id) ?? null)
          : null,
        serviceHcpcs: r.service_hcpcs,
        status: r.status,
        isActive: r.is_active,
        inNetwork: r.in_network,
        deductibleCents: r.deductible_cents,
        deductibleMetCents: r.deductible_met_cents,
        oopMaxCents: r.oop_max_cents,
        oopMetCents: r.oop_met_cents,
        copayCents: r.copay_cents,
        coinsurancePct: r.coinsurance_pct,
        requiresPriorAuth: r.requires_prior_auth,
        errorMessage: r.error_message,
        requestedAt: r.requested_at,
        respondedAt: r.responded_at,
        requestedByEmail: r.requested_by_email,
      })),
      counts: {
        total: data?.length ?? 0,
        byStatus,
        activeCoverage: activeCount,
        inactiveCoverage: inactiveCount,
        priorAuthFlagged,
      },
      windowDays: days,
      generatedAt: new Date().toISOString(),
    });
  },
);

export default router;
