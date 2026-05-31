// /admin/therapy-compliance — CMS 90-day setup-adherence tracker.
//
// Medicare requires a new PAP patient to use the device >= 4h/night on
// >= 21 nights within a consecutive 30-day period during their first 90
// days, or the rental claim is denied. This surface tracks every patient
// still inside that window: their BEST rolling 30-day count of >=4h
// nights (the CMS qualifying metric, computed by the
// resupply.therapy_setup_adherence_* RPCs in migration 0182), how many
// qualifying nights they still need, how many days remain, and whether
// they can still qualify.
//
//   GET /admin/therapy-compliance/summary     — KPI tiles
//   GET /admin/therapy-compliance/setups      — per-patient list
//   GET /admin/therapy-compliance/setups.csv  — same list as a report
//
// PHI / log posture: usage/adherence values ARE PHI. This module never
// logs them. `summary` is pure counts (reports.read); the list + CSV
// return patient names (patients.read).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

export const SETUP_ADHERENCE_STATUSES = [
  "qualified",
  "on_track",
  "at_risk",
] as const;
export type SetupAdherenceStatus = (typeof SETUP_ADHERENCE_STATUSES)[number];

const listQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).optional().default(200),
    status: z.enum(SETUP_ADHERENCE_STATUSES).optional(),
  })
  .strict();

function int(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : Math.trunc(n);
}

interface SummaryRow {
  patients_in_window: number | string;
  qualified: number | string;
  on_track: number | string;
  at_risk: number | string;
}

router.get(
  "/admin/therapy-compliance/summary",
  requirePermission("reports.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .rpc("therapy_setup_adherence_summary");
    if (error) throw error;

    const row = (Array.isArray(data) ? data[0] : data) as SummaryRow | null;
    res.json({
      summary: {
        patientsInWindow: int(row?.patients_in_window),
        qualified: int(row?.qualified),
        onTrack: int(row?.on_track),
        atRisk: int(row?.at_risk),
      },
    });
  },
);

interface SetupRpcRow {
  patient_id: string;
  first_night_date: string | null;
  days_elapsed: number | string | null;
  days_remaining: number | string | null;
  nights_in_window: number | string;
  nights_over_4h: number | string;
  best_30day_count: number | string;
  nights_needed: number | string;
  status: string;
}

interface SetupEntry {
  patientId: string;
  patientName: string | null;
  firstNightDate: string | null;
  daysElapsed: number;
  daysRemaining: number;
  nightsInWindow: number;
  nightsOver4h: number;
  best30dayCount: number;
  nightsNeeded: number;
  status: SetupAdherenceStatus;
}

async function buildSetups(
  limit: number,
  status: SetupAdherenceStatus | undefined,
): Promise<SetupEntry[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .rpc("therapy_setup_adherence_list", {
      // Over-fetch when filtering by status so the trimmed result still
      // fills a page.
      p_limit: status ? Math.min(limit * 4, 500) : limit,
    });
  if (error) throw error;

  let rows = ((data ?? []) as SetupRpcRow[]).map(
    (r): SetupEntry => ({
      patientId: r.patient_id,
      patientName: null,
      firstNightDate: r.first_night_date,
      daysElapsed: int(r.days_elapsed),
      daysRemaining: int(r.days_remaining),
      nightsInWindow: int(r.nights_in_window),
      nightsOver4h: int(r.nights_over_4h),
      best30dayCount: int(r.best_30day_count),
      nightsNeeded: int(r.nights_needed),
      status: (SETUP_ADHERENCE_STATUSES as readonly string[]).includes(r.status)
        ? (r.status as SetupAdherenceStatus)
        : "at_risk",
    }),
  );

  if (status) {
    rows = rows.filter((r) => r.status === status).slice(0, limit);
  }
  if (rows.length === 0) return rows;

  const ids = rows.map((r) => r.patientId);
  const { data: patientRows, error: pErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id, legal_first_name, legal_last_name")
    .in("id", ids);
  if (pErr) throw pErr;
  const nameById = new Map<string, string>();
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
  for (const r of rows) {
    r.patientName = nameById.get(r.patientId) || null;
  }
  return rows;
}

router.get(
  "/admin/therapy-compliance/setups",
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const { limit, status } = parsed.data;
    const setups = await buildSetups(limit, status);
    res.json({ count: setups.length, setups });
  },
);

function csvCell(v: string | number | null): string {
  if (v === null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get(
  "/admin/therapy-compliance/setups.csv",
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const { limit, status } = parsed.data;
    const setups = await buildSetups(limit, status);

    const filename = `setup-adherence-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.write(
      "patient_id,patient_name,status,first_night_date,days_elapsed," +
        "days_remaining,nights_in_window,nights_over_4h,best_30day_count," +
        "nights_needed\n",
    );
    for (const s of setups) {
      res.write(
        [
          csvCell(s.patientId),
          csvCell(s.patientName),
          csvCell(s.status),
          csvCell(s.firstNightDate),
          csvCell(s.daysElapsed),
          csvCell(s.daysRemaining),
          csvCell(s.nightsInWindow),
          csvCell(s.nightsOver4h),
          csvCell(s.best30dayCount),
          csvCell(s.nightsNeeded),
        ].join(",") + "\n",
      );
    }
    res.end();
  },
);

export default router;
