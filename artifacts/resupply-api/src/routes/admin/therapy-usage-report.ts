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
  type TherapyNightRow,
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

interface NightDbRow {
  patient_id: string;
  usage_minutes: number | null;
  ahi: number | null;
  leak_rate_l_min: number | null;
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

    // 1. Pull the per-night therapy metrics over the window.
    const { data: nightData, error: nightErr } = await supabase
      .schema("resupply")
      .from("patient_therapy_nights")
      .select("patient_id, usage_minutes, ahi, leak_rate_l_min")
      .gte("night_date", cutoff)
      .limit(NIGHTS_CAP);
    if (nightErr) throw nightErr;
    const nights = (nightData ?? []) as NightDbRow[];

    // 2. Build the per-patient → [groupKey,label,sublabel] mapping for
    //    the requested axis. A patient can map to several buckets.
    const groupsForPatient = await buildGroupingMap(
      supabase,
      groupBy,
      nights,
    );

    // 3. Fan each night out across its patient's buckets and aggregate.
    const rows: TherapyNightRow[] = [];
    for (const night of nights) {
      const buckets = groupsForPatient.get(night.patient_id) ?? [
        unattributedBucket(groupBy),
      ];
      for (const bucket of buckets) {
        rows.push({
          groupKey: bucket.key,
          groupLabel: bucket.label,
          groupSublabel: bucket.sublabel,
          patientId: night.patient_id,
          usageMinutes: night.usage_minutes,
          ahi: night.ahi,
          leakRateLMin: night.leak_rate_l_min,
        });
      }
    }

    const result = aggregateTherapyUsageReport(groupBy, rows);
    res.json({
      windowDays: days,
      generatedAt: new Date().toISOString(),
      ...result,
    });
  },
);

interface Bucket {
  key: string;
  label: string;
  sublabel: string | null;
}

function unattributedBucket(groupBy: TherapyReportGrouping): Bucket {
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

/** Builds patient_id → Bucket[] for the requested grouping axis. */
async function buildGroupingMap(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  groupBy: TherapyReportGrouping,
  nights: NightDbRow[],
): Promise<Map<string, Bucket[]>> {
  const map = new Map<string, Bucket[]>();
  const patientIds = new Set(nights.map((n) => n.patient_id));

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

    const providerById = new Map<string, Bucket>();
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
