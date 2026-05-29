// GET /admin/patients/:id/resupply-summary
//
// Per-patient therapy aggregate. Pulls from three sources the
// resupply / clinical team scans every morning:
//
//   * patient_therapy_nights        — usage / AHI / leak / pressure
//                                     for the last 60 nights
//   * patient_smart_trigger_events  — leak_rising / usage_dropping /
//                                     cushion_wear / humidifier_drop
//                                     events not yet dismissed
//   * csr_compliance_alerts         — low_usage / no_response /
//                                     send_failure / manual alerts
//                                     still in 'open' or 'snoozed'
//
// Plus rolling 30-day Medicare-style stats: % nights ≥ 4hr usage
// (the CMS adherence yardstick), median nightly hours, median AHI.
//
// PHI posture: nightly numeric stats only (no images, no payer
// fields, no member IDs). Patient name + DOB stay on the existing
// patient detail header — this surface just returns the therapy
// math.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.string().uuid();

const NIGHTS_WINDOW = 60;
const SMART_TRIGGER_WINDOW_DAYS = 30;
const COMPLIANCE_ALERT_WINDOW_DAYS = 90;
const ADHERENCE_WINDOW_DAYS = 30;
const ADHERENCE_MIN_NIGHTS = 21; // 21/30 = 70% of nights
const ADHERENCE_MIN_USAGE_MIN = 4 * 60; // 4-hour Medicare yardstick

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/** PostgREST serialises Postgres `numeric` columns as strings to
 *  preserve precision. The downstream UI math (median, comparisons,
 *  toFixed) wants numbers, so coerce — but treat unparseable values
 *  as null rather than NaN so the formatter falls back cleanly. */
function asNumber(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

router.get(
  "/admin/patients/:id/resupply-summary",
  // Same read gate as the existing per-patient therapy-nights
  // endpoint — `patients.read` is held by every current role.
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const patientId = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    const now = Date.now();
    const triggerCutoff = new Date(
      now - SMART_TRIGGER_WINDOW_DAYS * 24 * 3600 * 1000,
    ).toISOString();
    const alertCutoff = new Date(
      now - COMPLIANCE_ALERT_WINDOW_DAYS * 24 * 3600 * 1000,
    ).toISOString();
    const adherenceCutoffDate = new Date(
      now - ADHERENCE_WINDOW_DAYS * 24 * 3600 * 1000,
    )
      .toISOString()
      .slice(0, 10);

    const [
      { data: nights, error: nightsErr },
      { data: triggers, error: triggersErr },
      { data: alerts, error: alertsErr },
    ] = await Promise.all([
      supabase
        .schema("resupply")
        .from("patient_therapy_nights")
        .select(
          "id, night_date, source, usage_minutes, ahi, leak_rate_l_min, pressure_p95_cmh2o",
        )
        .eq("patient_id", patientId)
        .order("night_date", { ascending: false })
        .limit(NIGHTS_WINDOW),
      supabase
        .schema("resupply")
        .from("patient_smart_trigger_events")
        .select(
          "id, kind, detected_at, window_start_date, window_end_date, sent_at, dismissed_at",
        )
        .eq("patient_id", patientId)
        .is("dismissed_at", null)
        .gte("detected_at", triggerCutoff)
        .order("detected_at", { ascending: false })
        .limit(50),
      supabase
        .schema("resupply")
        .from("csr_compliance_alerts")
        .select(
          "id, alert_type, severity, summary, status, snoozed_until, created_at",
        )
        .eq("patient_id", patientId)
        .in("status", ["open", "snoozed"])
        .gte("created_at", alertCutoff)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);
    if (nightsErr) throw nightsErr;
    if (triggersErr) throw triggersErr;
    if (alertsErr) throw alertsErr;

    // Normalise the raw rows once so we work in plain numbers
    // downstream. PostgREST hands `numeric(...)` columns back as
    // strings ("3.10") so asNumber coerces; usage_minutes is a
    // proper integer column.
    const normalisedNights = (nights ?? []).map((n) => ({
      id: n.id,
      nightDate: n.night_date,
      source: n.source,
      usageMinutes: asNumber(n.usage_minutes),
      ahi: asNumber(n.ahi),
      leakRateLMin: asNumber(n.leak_rate_l_min),
      pressureP95Cmh2o: asNumber(n.pressure_p95_cmh2o),
    }));

    // Adherence math over the most recent 30-day window. Medicare
    // counts a "compliant night" as ≥ 4 hours of usage; the bar
    // for ongoing payment is ≥ 70% of nights in any 30-day window
    // within months 2-3 of therapy. We report the raw numbers and
    // let the UI compose the verdict copy.
    const adherenceNights = normalisedNights.filter(
      (n) => n.nightDate != null && n.nightDate >= adherenceCutoffDate,
    );
    const nightsCompliant = adherenceNights.filter(
      (n) => (n.usageMinutes ?? 0) >= ADHERENCE_MIN_USAGE_MIN,
    ).length;
    const usageMinutesValues = adherenceNights
      .map((n) => n.usageMinutes)
      .filter((v): v is number => v != null);
    const ahiValues = adherenceNights
      .map((n) => n.ahi)
      .filter((v): v is number => v != null);
    const leakValues = adherenceNights
      .map((n) => n.leakRateLMin)
      .filter((v): v is number => v != null);
    const medianUsageMinutes = median(usageMinutesValues);
    const medianAhi = median(ahiValues);
    const medianLeak = median(leakValues);

    const adherenceFraction =
      adherenceNights.length > 0
        ? nightsCompliant / adherenceNights.length
        : null;
    const meetsMedicareBar =
      adherenceNights.length >= ADHERENCE_MIN_NIGHTS &&
      nightsCompliant >= ADHERENCE_MIN_NIGHTS;

    res.json({
      adherence: {
        windowDays: ADHERENCE_WINDOW_DAYS,
        windowNightsAvailable: adherenceNights.length,
        nightsCompliant,
        minCompliantNightsForMedicare: ADHERENCE_MIN_NIGHTS,
        minUsageMinutesForCompliantNight: ADHERENCE_MIN_USAGE_MIN,
        adherenceFraction,
        meetsMedicareBar,
        medianUsageMinutes,
        medianAhi,
        medianLeakRateLMin: medianLeak,
      },
      nights: normalisedNights,
      smartTriggers: (triggers ?? []).map((t) => ({
        id: t.id,
        kind: t.kind,
        detectedAt: t.detected_at,
        windowStartDate: t.window_start_date,
        windowEndDate: t.window_end_date,
        sentAt: t.sent_at,
      })),
      complianceAlerts: (alerts ?? []).map((a) => ({
        id: a.id,
        alertType: a.alert_type,
        severity: a.severity,
        summary: a.summary,
        status: a.status,
        snoozedUntil: a.snoozed_until,
        createdAt: a.created_at,
      })),
      counts: {
        nightsOnFile: nights?.length ?? 0,
        smartTriggersOpen: triggers?.length ?? 0,
        complianceAlertsOpen: alerts?.length ?? 0,
      },
      generatedAt: new Date().toISOString(),
    });
  },
);

export default router;
