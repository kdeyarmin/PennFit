// /admin/therapy-fleet/clinical-insights — population-level report of
// the CLINICAL signals the smart-trigger rules derive from the imported
// CPAP manufacturer data (ResMed AirView / Philips Care Orchestrator /
// 3B React Health).
//
// The per-patient therapy tab shows one patient's open triggers; the
// therapy-fleet worklist/alerts surface the RPC-computed threshold
// cohorts. Neither gives the respiratory-therapy team a single
// cross-panel queue of the *clinical* smart-trigger signals — the ones
// the dispatcher never auto-messages because they need a clinician
// (pressure pegging, AHI elevated/rising, non-adherence, erratic use).
// This report is that queue: every active clinical signal across the
// base, summarised by type and listed with patient names, plus a CSV
// export for working offline / sharing with the prescriber.
//
//   GET /admin/therapy-fleet/clinical-insights      — summary + list
//   GET /admin/therapy-fleet/clinical-insights.csv  — same, as CSV
//
// "Active" = patient_smart_trigger_events row with a clinical kind and
// dismissed_at IS NULL (clinical kinds are never dispatched, so sent_at
// is irrelevant). A CSR dismisses a row from the patient page once it's
// been actioned, which drops it from this report.
//
// PHI / log posture: returns patient names + a clinical signal type
// (which is itself sensitive) → gates on patients.read and never logs
// the rows. The detection *values* (AHI, pressure) are not carried here
// — only the signal type and the window it was detected over.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// The clinical (RT-owned) smart-trigger kinds, in triage-severity order.
// Kept in lockstep with lib/smart-triggers/index.ts PATIENT_DISPATCH_KINDS
// (these are exactly the kinds NOT in that list) and the kind CHECK in
// migration 0325.
export const CLINICAL_TRIGGER_KINDS = [
  "pressure_at_max",
  "ahi_elevated",
  "non_adherent_30d",
  "ahi_rising",
  "usage_erratic",
] as const;
export type ClinicalTriggerKind = (typeof CLINICAL_TRIGGER_KINDS)[number];

const SEVERITY: Record<ClinicalTriggerKind, "high" | "medium"> = {
  // Under-titration and residual events are the sharpest safety/efficacy
  // signals; non-adherence puts Medicare coverage at risk.
  pressure_at_max: "high",
  ahi_elevated: "high",
  non_adherent_30d: "high",
  // Early-warning trends — important, but a step below the level alarms.
  ahi_rising: "medium",
  usage_erratic: "medium",
};

const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
const KIND_RANK: Record<ClinicalTriggerKind, number> = Object.fromEntries(
  CLINICAL_TRIGGER_KINDS.map((k, i) => [k, i]),
) as Record<ClinicalTriggerKind, number>;

const reportQuery = z
  .object({
    kind: z.enum(CLINICAL_TRIGGER_KINDS).optional(),
    limit: z.coerce.number().int().min(1).max(2000).optional().default(1000),
  })
  .strict();

interface TriggerEventRow {
  id: string;
  patient_id: string;
  kind: string;
  detected_at: string;
  window_start_date: string;
  window_end_date: string;
}

interface ClinicalInsightEntry {
  id: string;
  patientId: string;
  patientName: string | null;
  kind: ClinicalTriggerKind;
  severity: "high" | "medium";
  detectedAt: string;
  windowStartDate: string;
  windowEndDate: string;
}

interface ClinicalInsightReport {
  summary: {
    total: number;
    patients: number;
    byKind: Record<ClinicalTriggerKind, number>;
    bySeverity: { high: number; medium: number };
  };
  entries: ClinicalInsightEntry[];
}

// Page the active-clinical-event read. PostgREST silently truncates an
// un-ranged read at the server max (~1000); a busy panel can carry more
// clinical signals than that, so page until short. Hard-capped so a
// pathological panel can't stream unbounded into Node.
const PAGE_SIZE = 1000;
const HARD_CAP = 5000;

async function buildClinicalInsightReport(
  kind: ClinicalTriggerKind | undefined,
  limit: number,
): Promise<ClinicalInsightReport> {
  const supabase = getSupabaseServiceRoleClient();

  const rows: TriggerEventRow[] = [];
  for (let from = 0; from < HARD_CAP; from += PAGE_SIZE) {
    let q = supabase
      .schema("resupply")
      .from("patient_smart_trigger_events")
      .select(
        "id, patient_id, kind, detected_at, window_start_date, window_end_date",
      )
      .is("dismissed_at", null)
      .order("detected_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    q = kind
      ? q.eq("kind", kind)
      : q.in("kind", CLINICAL_TRIGGER_KINDS as readonly string[]);
    const page = await q;
    if (page.error) throw page.error;
    const data = (page.data ?? []) as TriggerEventRow[];
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }

  // Build the summary over the FULL active set before any display limit,
  // so the tiles reflect the true panel count even when the list is
  // truncated for rendering.
  const byKind = Object.fromEntries(
    CLINICAL_TRIGGER_KINDS.map((k) => [k, 0]),
  ) as Record<ClinicalTriggerKind, number>;
  const bySeverity = { high: 0, medium: 0 };
  const patientSet = new Set<string>();
  const valid: TriggerEventRow[] = [];
  for (const r of rows) {
    if (!(CLINICAL_TRIGGER_KINDS as readonly string[]).includes(r.kind)) {
      continue;
    }
    const k = r.kind as ClinicalTriggerKind;
    byKind[k] += 1;
    bySeverity[SEVERITY[k]] += 1;
    patientSet.add(r.patient_id);
    valid.push(r);
  }

  // Order for the worklist: highest severity first, then the kind's
  // triage rank, then most-recently detected.
  valid.sort((a, b) => {
    const ka = a.kind as ClinicalTriggerKind;
    const kb = b.kind as ClinicalTriggerKind;
    const sev = SEVERITY_RANK[SEVERITY[ka]] - SEVERITY_RANK[SEVERITY[kb]];
    if (sev !== 0) return sev;
    const kr = KIND_RANK[ka] - KIND_RANK[kb];
    if (kr !== 0) return kr;
    return b.detected_at.localeCompare(a.detected_at);
  });

  const limited = valid.slice(0, limit);

  // Attach display names in one batched read (mirror therapy-fleet.ts).
  const nameById = new Map<string, string>();
  if (limited.length > 0) {
    const ids = Array.from(new Set(limited.map((r) => r.patient_id)));
    const { data: patientRows, error: pErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id, legal_first_name, legal_last_name")
      .in("id", ids);
    if (pErr) throw pErr;
    for (const p of (patientRows ?? []) as Array<{
      id: string;
      legal_first_name: string | null;
      legal_last_name: string | null;
    }>) {
      const name = [p.legal_first_name, p.legal_last_name]
        .filter(Boolean)
        .join(" ")
        .trim();
      nameById.set(p.id, name || "");
    }
  }

  const entries: ClinicalInsightEntry[] = limited.map((r) => {
    const k = r.kind as ClinicalTriggerKind;
    return {
      id: r.id,
      patientId: r.patient_id,
      patientName: nameById.get(r.patient_id) || null,
      kind: k,
      severity: SEVERITY[k],
      detectedAt: r.detected_at,
      windowStartDate: r.window_start_date,
      windowEndDate: r.window_end_date,
    };
  });

  return {
    summary: {
      total: valid.length,
      patients: patientSet.size,
      byKind,
      bySeverity,
    },
    entries,
  };
}

router.get(
  "/admin/therapy-fleet/clinical-insights",
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = reportQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const { kind, limit } = parsed.data;
    const report = await buildClinicalInsightReport(kind, limit);
    res.json({ count: report.entries.length, ...report });
  },
);

function csvCell(v: string | number | null): string {
  if (v === null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get(
  "/admin/therapy-fleet/clinical-insights.csv",
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = reportQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const { kind, limit } = parsed.data;
    const report = await buildClinicalInsightReport(kind, limit);

    const filename = `therapy-clinical-insights-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.write(
      "patient_id,patient_name,signal,severity,detected_at," +
        "window_start_date,window_end_date\n",
    );
    for (const e of report.entries) {
      res.write(
        [
          csvCell(e.patientId),
          csvCell(e.patientName),
          csvCell(e.kind),
          csvCell(e.severity),
          csvCell(e.detectedAt),
          csvCell(e.windowStartDate),
          csvCell(e.windowEndDate),
        ].join(",") + "\n",
      );
    }
    res.end();
  },
);

export default router;
