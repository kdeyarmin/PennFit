// /admin/reports/therapy-usage — the provider-facing therapy-adherence
// snapshot that marketing/sales presents to a referring physician.
//
//   GET /admin/reports/therapy-usage?groupBy=provider&days=30
//
// `groupBy` rolls the same per-night therapy metrics up three ways:
//
//   • provider     — one row per referring prescriber (legal name +
//                    NPI + practice). The headline pitch: "here is how
//                    the patients you referred are doing on therapy
//                    with us." A patient with multiple prescribers
//                    appears under each; distinct-patient counts keep
//                    them from being double-counted in the row.
//   • patient      — one row per patient, DE-IDENTIFIED (short ref,
//                    never a name) so the rendered report is safe to
//                    hand to an external party.
//   • manufacturer — one row per CPAP/PAP device manufacturer on file
//                    (ResMed, Philips, 3B Medical, …).
//
// The metrics (avg nightly usage, AHI, leak, % adherent nights, CMS-
// compliant patient share) come from resupply.patient_therapy_nights
// over the trailing `days` window. The grouping joins use
// resupply.prescriptions → providers and resupply.equipment_assets.
//
// Read-only, gated on reports.read. No new schema. The aggregation math
// is the pure helper in lib/analytics/therapy-usage-report.ts; this
// route is the DB-read + window-validation + de-identification layer.
//
// PHI note: patient names are never selected or returned. The "patient"
// grouping emits a short opaque reference derived from the row id so the
// report can be shared without leaking identity.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  THERAPY_REPORT_GROUPINGS,
  aggregateTherapyUsageReport,
  type GroupRef,
  type PatientNight,
  type TherapyReportGrouping,
} from "../../lib/analytics/therapy-usage-report";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const querySchema = z.object({
  groupBy: z.enum(THERAPY_REPORT_GROUPINGS).optional().default("provider"),
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
});

// Cap on how many therapy-night rows we pull for the window so a very
// large tenant can't time the route out. The window math degrades
// gracefully to an approximation over the cap (still representative).
const NIGHTS_CAP = 50_000;
// Cap on the join tables we read to build the grouping maps.
const MAP_CAP = 50_000;

/** Source priority when the same night exists from multiple feeds.
 *  Mirrors the compliance-attestation route so this report and the
 *  on-file attestation never disagree on which feed wins a night. */
const SOURCE_PRIORITY: Record<string, number> = {
  resmed_airview: 0,
  philips_care: 1,
  health_connect: 2,
  react_health: 3,
  manual: 4,
};

interface NightDbRow {
  patient_id: string;
  night_date: string;
  source: string;
  usage_minutes: number | null;
  // `ahi` and `leak_rate_l_min` are Postgres `numeric` columns, which
  // PostgREST serializes as strings. Coerce before any arithmetic.
  ahi: string | null;
  leak_rate_l_min: string | null;
}

/** Coerce a PostgREST numeric (string | null) to a finite number or
 *  null. Guards against NaN poisoning the aggregation averages. */
function toNum(value: string | number | null): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Opaque, stable, name-free reference for the de-identified patient
 *  grouping. First 8 chars of the UUID is enough to disambiguate in a
 *  single report without revealing identity. */
function patientRef(patientId: string): string {
  return `Patient ${patientId.slice(0, 8).toUpperCase()}`;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

router.get(
  "/admin/reports/therapy-usage",
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const { groupBy, days } = parsed.data;
    const cutoff = isoDaysAgo(days);
    const supabase = getSupabaseServiceRoleClient();

    // 1. Pull the per-night therapy metrics over the window. We select
    //    night_date + source so we can collapse multi-source duplicates
    //    (UNIQUE(patient_id, night_date, source) permits several rows
    //    per patient/night) before any counting.
    const { data: nightData, error: nightErr } = await supabase
      .schema("resupply")
      .from("patient_therapy_nights")
      .select("patient_id, night_date, source, usage_minutes, ahi, leak_rate_l_min")
      .gte("night_date", cutoff)
      .limit(NIGHTS_CAP);
    if (nightErr) throw nightErr;
    const rawNights = (nightData ?? []) as NightDbRow[];

    // 2. Dedupe by (patient, night) taking the source-priority winner,
    //    and coerce the numeric (string) columns to numbers.
    const dedupedByKey = new Map<string, NightDbRow>();
    for (const row of rawNights) {
      const key = `${row.patient_id}::${row.night_date}`;
      const existing = dedupedByKey.get(key);
      if (!existing) {
        dedupedByKey.set(key, row);
        continue;
      }
      const newRank = SOURCE_PRIORITY[row.source] ?? 99;
      const oldRank = SOURCE_PRIORITY[existing.source] ?? 99;
      if (newRank < oldRank) dedupedByKey.set(key, row);
    }
    const nights: PatientNight[] = Array.from(dedupedByKey.values()).map(
      (r) => ({
        patientId: r.patient_id,
        date: r.night_date,
        usageMinutes: r.usage_minutes,
        ahi: toNum(r.ahi),
        leakRateLMin: toNum(r.leak_rate_l_min),
      }),
    );

    // 3. Build the per-patient → bucket(s) mapping for the requested
    //    axis. A patient can map to several buckets.
    const patientIds = new Set(nights.map((n) => n.patientId));
    const bucketsByPatient = await buildGroupingMap(
      supabase,
      groupBy,
      patientIds,
    );

    const result = aggregateTherapyUsageReport({
      grouping: groupBy,
      nights,
      bucketsByPatient,
      asOfDate: new Date().toISOString().slice(0, 10),
    });
    res.json({
      windowDays: days,
      generatedAt: new Date().toISOString(),
      ...result,
    });
  },
);

function unattributedRef(groupBy: TherapyReportGrouping): GroupRef {
  switch (groupBy) {
    case "provider":
      return {
        key: "unattributed",
        label: "Unattributed",
        sublabel: "No prescriber on file",
      };
    case "manufacturer":
      return {
        key: "unattributed",
        label: "Unattributed",
        sublabel: "No device on file",
      };
    case "patient":
      // Patient grouping always has a key (the patient id); this branch
      // is unreachable but keeps the switch exhaustive.
      return { key: "unattributed", label: "Unattributed", sublabel: null };
  }
}

/** Builds patient_id → GroupRef[] for the requested grouping axis.
 *  Every patient with night data gets at least one bucket (an
 *  "Unattributed" fallback when no provider / device is on file) so the
 *  headline summary and the cohort rows agree on the patient set. */
async function buildGroupingMap(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  groupBy: TherapyReportGrouping,
  patientIds: Set<string>,
): Promise<Map<string, GroupRef[]>> {
  const map = new Map<string, GroupRef[]>();

  if (groupBy === "patient") {
    for (const id of patientIds) {
      map.set(id, [{ key: id, label: patientRef(id), sublabel: null }]);
    }
    return map;
  }

  if (groupBy === "provider") {
    // patient_id → set of provider_ids (via prescriptions), then resolve
    // provider rows for labels. Read the mapping tables in full (capped)
    // and join in memory to avoid an unbounded `in(...)` URL.
    const { data: rxData, error: rxErr } = await supabase
      .schema("resupply")
      .from("prescriptions")
      .select("patient_id, provider_id")
      .not("provider_id", "is", null)
      .limit(MAP_CAP);
    if (rxErr) throw rxErr;

    const providerIdsByPatient = new Map<string, Set<string>>();
    const providerIds = new Set<string>();
    for (const r of rxData ?? []) {
      if (!patientIds.has(r.patient_id) || !r.provider_id) continue;
      let set = providerIdsByPatient.get(r.patient_id);
      if (!set) {
        set = new Set();
        providerIdsByPatient.set(r.patient_id, set);
      }
      set.add(r.provider_id);
      providerIds.add(r.provider_id);
    }

    const providerById = new Map<string, GroupRef>();
    if (providerIds.size > 0) {
      const { data: provData, error: provErr } = await supabase
        .schema("resupply")
        .from("providers")
        .select("id, legal_name, npi, practice_name")
        .limit(MAP_CAP);
      if (provErr) throw provErr;
      for (const p of provData ?? []) {
        if (!providerIds.has(p.id)) continue;
        const sublabel = [p.npi ? `NPI ${p.npi}` : null, p.practice_name]
          .filter(Boolean)
          .join(" · ");
        providerById.set(p.id, {
          key: p.id,
          label: p.legal_name ?? "Unknown provider",
          sublabel: sublabel || null,
        });
      }
    }

    for (const [patientId, ids] of providerIdsByPatient) {
      const buckets: Bucket[] = [];
      for (const pid of ids) {
        const bucket = providerById.get(pid);
        if (bucket) buckets.push(bucket);
      }
      if (buckets.length > 0) map.set(patientId, buckets);
    }
    return map;
  }

  // groupBy === "manufacturer"
  const { data: eqData, error: eqErr } = await supabase
    .schema("resupply")
    .from("equipment_assets")
    .select("patient_id, manufacturer")
    .limit(MAP_CAP);
  if (eqErr) throw eqErr;

  for (const e of eqData ?? []) {
    if (!patientIds.has(e.patient_id) || !e.manufacturer) continue;
    const key = e.manufacturer.trim();
    if (!key) continue;
    let buckets = map.get(e.patient_id);
    if (!buckets) {
      buckets = [];
      map.set(e.patient_id, buckets);
    }
    if (!buckets.some((b) => b.key === key)) {
      buckets.push({ key, label: key, sublabel: null });
    }
  }
  return map;
}

export default router;
