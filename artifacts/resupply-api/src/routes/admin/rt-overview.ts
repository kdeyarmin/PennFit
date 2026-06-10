// /admin/rt-overview — Respiratory therapist at-a-glance dashboard.
//
// Surfaces the data the RT side of the house already has — therapy
// nights from the three manufacturer integrations (ResMed AirView,
// Philips Care Orchestrator, React Health),
// active therapy links, and undismissed smart-trigger events — as
// one consolidated read for the RT/clinical team's daily review.
// No new schema; every column already exists.
//
// Two endpoints:
//
//   GET /admin/rt-overview        — JSON. The frontend table.
//   GET /admin/rt-overview.csv    — CSV. Same columns, downloadable.
//                                   The RT team works in spreadsheets
//                                   for week-over-week trending and
//                                   for monthly accreditation reports.
//
// Window: `?days=` (1..90, default 7). The 90-day cap keeps the
// underlying SELECT bounded; deeper history lives in /admin/analytics.
// The 7-day default matches the typical CMS/Medicare adherence
// inspection cadence ("did this patient sleep ≥4h on ≥70% of recent
// nights"), and is what the RT team already eyeballs every Monday.
//
// Privacy/audit: counts-only audit row per read. We never log the
// patient list or the metric values — only `{ patients: <count>,
// window: <days> }`. Operators reviewing the audit trail can confirm
// "someone pulled the RT board" without seeing PHI.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import { logAudit } from "@workspace/resupply-audit";

import {
  aggregatePatientWindow,
  labelForTriggerKind,
  summarizeOverview,
  type TherapyNightInput,
} from "../../lib/rt-overview/aggregate";
import { logger } from "../../lib/logger";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional().default(7),
});

interface RtOverviewRow {
  patientId: string;
  pacwareId: string | null;
  firstName: string;
  lastName: string;
  nightsInWindow: number;
  lastNightDate: string | null;
  staleDays: number | null;
  ahiAvg: number | null;
  leakAvg: number | null;
  usageMinutesAvg: number | null;
  activeAlerts: {
    /** The patient_smart_trigger_events row id; lets the RT board
     *  call POST /admin/smart-triggers/:id/dismiss inline. */
    id: string;
    kind: string;
    label: string;
    detectedAt: string;
  }[];
  therapyLinks: {
    source: string;
    status: string;
    lastSyncedAt: string | null;
    lastSyncStatus: string | null;
  }[];
}

interface RawTherapyLink {
  patient_id: string;
  source: string;
  status: string;
  last_synced_at: string | null;
  last_sync_status: string | null;
}

interface RawNight extends TherapyNightInput {
  patient_id: string;
}

interface RawSmartTriggerEvent {
  id: string;
  patient_id: string;
  kind: string;
  detected_at: string;
}

interface RawPatient {
  id: string;
  pacware_id: string | null;
  legal_first_name: string;
  legal_last_name: string;
}

/**
 * Fetch + roll up the RT overview. Exported so the test can call it
 * with staged Supabase responses and so a future CSV endpoint can
 * reuse the same body.
 */
export async function buildRtOverview(days: number): Promise<{
  asOf: string;
  windowDays: number;
  summary: ReturnType<typeof summarizeOverview>;
  rows: RtOverviewRow[];
}> {
  const supabase = getSupabaseServiceRoleClient();
  const asOf = new Date().toISOString();
  const asOfDate = asOf.slice(0, 10);

  // 1. Active therapy links — these define "patients being tracked
  //    by an integration." Status `active` only; revoked / errored
  //    links are visible on the patient-detail screen but don't
  //    belong on the RT board.
  const { data: linksRaw, error: linksErr } = await supabase
    .schema("resupply")
    .from("patient_therapy_links")
    .select("patient_id, source, status, last_synced_at, last_sync_status")
    .eq("status", "active");
  if (linksErr) throw linksErr;
  const links = (linksRaw ?? []) as RawTherapyLink[];

  const linkedPatientIds = Array.from(new Set(links.map((l) => l.patient_id)));
  if (linkedPatientIds.length === 0) {
    return {
      asOf,
      windowDays: days,
      summary: { totalActive: 0, totalAlerting: 0, totalStale: 0 },
      rows: [],
    };
  }

  // 2. Patient name lookup. PostgREST `.in()` handles ~1k ids in one
  //    URL — well above any plausible single-clinic RT fleet.
  const { data: patientsRaw, error: patientsErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id, pacware_id, legal_first_name, legal_last_name")
    .in("id", linkedPatientIds);
  if (patientsErr) throw patientsErr;
  const patients = (patientsRaw ?? []) as RawPatient[];

  // 3. Therapy nights inside the window. We also pull older nights
  //    (no lower bound) so `staleDays` can reflect "last night ever",
  //    but cap the per-patient count by relying on the DB ordering;
  //    a 90-night window × 200 patients is ~18k rows — fine.
  const { data: nightsRaw, error: nightsErr } = await supabase
    .schema("resupply")
    .from("patient_therapy_nights")
    .select("patient_id, night_date, usage_minutes, ahi, leak_rate_l_min")
    .in("patient_id", linkedPatientIds)
    .order("night_date", { ascending: false });
  if (nightsErr) throw nightsErr;
  const nights = (nightsRaw ?? []) as RawNight[];

  // 4. Undismissed smart-trigger events, scoped to the same patients.
  //    PostgREST `.is("dismissed_at", null)` filters out any that
  //    were closed via the CSR dismiss action.
  const { data: triggersRaw, error: triggersErr } = await supabase
    .schema("resupply")
    .from("patient_smart_trigger_events")
    .select("id, patient_id, kind, detected_at")
    .in("patient_id", linkedPatientIds)
    .is("dismissed_at", null)
    .order("detected_at", { ascending: false });
  if (triggersErr) throw triggersErr;
  const triggers = (triggersRaw ?? []) as RawSmartTriggerEvent[];

  // Bucket child rows by patient_id once so the per-patient loop
  // below is O(patients), not O(patients × nights).
  const nightsByPatient = new Map<string, RawNight[]>();
  for (const n of nights) {
    const arr = nightsByPatient.get(n.patient_id) ?? [];
    arr.push(n);
    nightsByPatient.set(n.patient_id, arr);
  }
  const linksByPatient = new Map<string, RawTherapyLink[]>();
  for (const l of links) {
    const arr = linksByPatient.get(l.patient_id) ?? [];
    arr.push(l);
    linksByPatient.set(l.patient_id, arr);
  }
  const triggersByPatient = new Map<string, RawSmartTriggerEvent[]>();
  for (const t of triggers) {
    const arr = triggersByPatient.get(t.patient_id) ?? [];
    arr.push(t);
    triggersByPatient.set(t.patient_id, arr);
  }

  const rows: RtOverviewRow[] = patients.map((p) => {
    const patientNights = nightsByPatient.get(p.id) ?? [];
    const patientLinks = linksByPatient.get(p.id) ?? [];
    const patientTriggers = triggersByPatient.get(p.id) ?? [];
    const window = aggregatePatientWindow(patientNights, asOfDate, days);
    return {
      patientId: p.id,
      pacwareId: p.pacware_id,
      firstName: p.legal_first_name,
      lastName: p.legal_last_name,
      nightsInWindow: window.nightsInWindow,
      lastNightDate: window.lastNightDate,
      staleDays: window.staleDays,
      ahiAvg: window.ahiAvg,
      leakAvg: window.leakAvg,
      usageMinutesAvg: window.usageMinutesAvg,
      activeAlerts: patientTriggers.map((t) => ({
        id: t.id,
        kind: t.kind,
        label: labelForTriggerKind(t.kind),
        detectedAt: t.detected_at,
      })),
      therapyLinks: patientLinks.map((l) => ({
        source: l.source,
        status: l.status,
        lastSyncedAt: l.last_synced_at,
        lastSyncStatus: l.last_sync_status,
      })),
    };
  });

  // Sort: alerting + stale rows first (most likely to need RT
  // attention), then by usage so newly-onboarded patients land near
  // the top of the active section.
  rows.sort((a, b) => {
    const aPriority =
      a.activeAlerts.length > 0 ? 0 : a.nightsInWindow === 0 ? 1 : 2;
    const bPriority =
      b.activeAlerts.length > 0 ? 0 : b.nightsInWindow === 0 ? 1 : 2;
    if (aPriority !== bPriority) return aPriority - bPriority;
    // Same bucket: alphabetical by last name keeps lookups stable.
    return a.lastName.localeCompare(b.lastName);
  });

  const summary = summarizeOverview(
    rows.map((r) => ({
      nightsInWindow: r.nightsInWindow,
      staleDays: r.staleDays,
      activeAlerts: r.activeAlerts.map((a) => a.kind),
      hasTherapyLink: r.therapyLinks.length > 0,
    })),
  );

  return { asOf, windowDays: days, summary, rows };
}

router.get(
  "/admin/rt-overview",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const days = parsed.data.days;
    const overview = await buildRtOverview(days);

    // Counts-only audit. The patient list is intentionally NOT logged.
    await logAudit({
      action: "admin.rt_overview.read",
      adminEmail: req.adminEmail ?? null,
      metadata: {
        patients: overview.rows.length,
        window_days: days,
        ...overview.summary,
      },
    }).catch((err) => {
      logger.warn({ err }, "rt-overview: audit log failed (continuing)");
    });

    res.json(overview);
  },
);

router.get(
  "/admin/rt-overview.csv",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const days = parsed.data.days;
    const overview = await buildRtOverview(days);

    await logAudit({
      action: "admin.rt_overview.export_csv",
      adminEmail: req.adminEmail ?? null,
      metadata: {
        patients: overview.rows.length,
        window_days: days,
        ...overview.summary,
      },
    }).catch((err) => {
      logger.warn({ err }, "rt-overview.csv: audit log failed (continuing)");
    });

    const headers = [
      "pacware_id",
      "last_name",
      "first_name",
      "nights_in_window",
      "last_night_date",
      "stale_days",
      "ahi_avg",
      "leak_avg",
      "usage_minutes_avg",
      "active_alerts",
      "therapy_link_sources",
    ];
    const lines: string[] = [headers.join(",")];
    for (const r of overview.rows) {
      const alerts = r.activeAlerts.map((a) => a.label).join("; ");
      const sources = r.therapyLinks.map((l) => l.source).join("; ");
      const row = [
        csvCell(r.pacwareId ?? ""),
        csvCell(r.lastName),
        csvCell(r.firstName),
        String(r.nightsInWindow),
        r.lastNightDate ?? "",
        r.staleDays === null ? "" : String(r.staleDays),
        r.ahiAvg === null ? "" : String(r.ahiAvg),
        r.leakAvg === null ? "" : String(r.leakAvg),
        r.usageMinutesAvg === null ? "" : String(r.usageMinutesAvg),
        csvCell(alerts),
        csvCell(sources),
      ];
      lines.push(row.join(","));
    }

    const filename = `rt-overview-${overview.asOf.slice(0, 10)}-${days}d.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(lines.join("\n") + "\n");
  },
);

function csvCell(s: string): string {
  // Neutralize formula injection: prefix cells that start with
  // formula trigger characters with a single quote.
  if (s.length > 0 && /^[=+\-@]/.test(s)) {
    s = `'${s}`;
  }
  // Wrap in quotes only when the cell contains a character that
  // would otherwise change the CSV's field structure. Double-up
  // embedded quotes per RFC 4180.
  if (/[,"\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export default router;
