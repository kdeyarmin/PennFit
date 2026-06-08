// /admin/patients/:id/therapy-snapshot — compact recent-adherence
// snapshot for the CSR/RT patient context panel (CSR C3).
//
//   GET /admin/patients/:id/therapy-snapshot?days=30
//
// The full therapy fleet/RT dashboards already exist, but a CSR working a
// conversation had to leave the thread to answer "is this patient even
// using their machine?". This is the one small read that puts recent
// adherence (avg usage, compliance rate, AHI/leak, data freshness) inline
// next to the patient. patients.read-gated (CSRs hold it; the data is the
// patient's own resupply-relevant adherence — not clinical free text).
//
// PHI posture: returns numeric therapy aggregates to the patients.read
// holder; the app logger sees the patient id + counts only.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

/** Medicare compliant-night threshold (≥ 4 h). */
const COMPLIANT_MINUTES = 240;

export interface SnapshotNight {
  nightDate: string; // YYYY-MM-DD
  usageMinutes: number | null;
  ahi: number | null;
  leakLMin: number | null;
}

export interface TherapySnapshot {
  hasData: boolean;
  windowDays: number;
  nightsWithData: number;
  windowStartDate: string | null;
  windowEndDate: string | null;
  lastNightDate: string | null;
  /** Whole days between the most recent night and `todayIso`. */
  staleDays: number | null;
  avgUsageHours: number | null;
  avgAhi: number | null;
  avgLeakLMin: number | null;
  compliantNights: number;
  /** compliantNights / nightsWithUsage, as a 0–100 percentage. */
  complianceRatePct: number | null;
}

function mean(vals: number[]): number | null {
  if (vals.length === 0) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function round1(v: number | null): number | null {
  return v == null ? null : Math.round(v * 10) / 10;
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00.000Z`);
  const to = Date.parse(`${toIso}T00:00:00.000Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

/**
 * Pure: aggregate a patient's recent therapy nights into a compact
 * snapshot. Dedups duplicate night dates (multi-cloud sync) keeping the
 * first occurrence, computes null-safe averages, and derives data
 * freshness from `todayIso`. No I/O — unit-tested directly.
 */
export function buildTherapySnapshot(
  nights: readonly SnapshotNight[],
  windowDays: number,
  todayIso: string,
): TherapySnapshot {
  const seen = new Set<string>();
  const deduped: SnapshotNight[] = [];
  for (const n of nights) {
    if (!n?.nightDate || seen.has(n.nightDate)) continue;
    seen.add(n.nightDate);
    deduped.push(n);
  }

  if (deduped.length === 0) {
    return {
      hasData: false,
      windowDays,
      nightsWithData: 0,
      windowStartDate: null,
      windowEndDate: null,
      lastNightDate: null,
      staleDays: null,
      avgUsageHours: null,
      avgAhi: null,
      avgLeakLMin: null,
      compliantNights: 0,
      complianceRatePct: null,
    };
  }

  const dates = deduped.map((n) => n.nightDate).sort();
  const lastNightDate = dates[dates.length - 1] ?? null;
  const usage = deduped
    .map((n) => n.usageMinutes)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const compliantNights = usage.filter((u) => u >= COMPLIANT_MINUTES).length;
  const ahi = deduped
    .map((n) => n.ahi)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const leak = deduped
    .map((n) => n.leakLMin)
    .filter((v): v is number => v != null && Number.isFinite(v));

  const avgUsageMinutes = mean(usage);

  return {
    hasData: true,
    windowDays,
    nightsWithData: deduped.length,
    windowStartDate: dates[0] ?? null,
    windowEndDate: lastNightDate,
    lastNightDate,
    staleDays: lastNightDate ? daysBetween(lastNightDate, todayIso) : null,
    avgUsageHours:
      avgUsageMinutes == null ? null : round1(avgUsageMinutes / 60),
    avgAhi: round1(mean(ahi)),
    avgLeakLMin: round1(mean(leak)),
    compliantNights,
    complianceRatePct:
      usage.length > 0 ? round1((compliantNights / usage.length) * 100) : null,
  };
}

const idParam = z.string().trim().min(1).max(128);
const querySchema = z.object({
  days: z.coerce.number().int().min(7).max(90).default(30),
});

router.get(
  "/admin/patients/:id/therapy-snapshot",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params.id);
    if (!idParsed.success) {
      res.status(400).json({ error: "invalid_patient_id" });
      return;
    }
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const windowDays = parsed.data.days;
    const todayIso = new Date().toISOString().slice(0, 10);
    const startIso = new Date(Date.now() - windowDays * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const supabase = getSupabaseServiceRoleClient();
    const { data: nights, error } = await supabase
      .schema("resupply")
      .from("patient_therapy_nights")
      .select("night_date, usage_minutes, ahi, leak_rate_l_min")
      .eq("patient_id", idParsed.data)
      .gte("night_date", startIso)
      .order("night_date", { ascending: false })
      .limit(windowDays * 4);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }

    const snapshot = buildTherapySnapshot(
      ((nights ?? []) as Record<string, unknown>[]).map((n) => ({
        nightDate: String(n.night_date),
        usageMinutes: n.usage_minutes == null ? null : Number(n.usage_minutes),
        ahi: n.ahi == null ? null : Number(n.ahi),
        leakLMin: n.leak_rate_l_min == null ? null : Number(n.leak_rate_l_min),
      })),
      windowDays,
      todayIso,
    );

    req.log?.info(
      {
        event: "admin.patient.therapy_snapshot",
        patient_id: idParsed.data,
        nights_with_data: snapshot.nightsWithData,
        adminEmail: req.adminEmail,
      },
      "admin.patient.therapy_snapshot",
    );

    res.json({ patientId: idParsed.data, ...snapshot });
  },
);

export default router;
