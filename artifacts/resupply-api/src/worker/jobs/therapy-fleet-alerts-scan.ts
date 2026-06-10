// pg-boss job: nightly therapy-fleet alerts scan.
//
// Detects per-patient threshold crossings from the same RPCs that power
// the fleet worklist + setup-adherence tracker, and maintains an
// internal alert feed in resupply.therapy_fleet_alerts — one OPEN row
// per (patient, alert_type), auto-resolved once the patient no longer
// trips the threshold. This is the "automated" layer: the team gets an
// actionable feed without opening a dashboard.
//
// Patient auto-outreach is OPT-IN and conservative. It only runs when:
//   * the `therapy_fleet.auto_outreach` flag is on (OFF by default), AND
//   * the global `sms.reminders` flag is on, AND
//   * Twilio is configured.
// And per patient it only sends when ALL hold:
//   * the alert type is patient-appropriate (adherence, not clinical —
//     compliance_risk / no_recent_data / setup_at_risk; high_ahi /
//     high_leak stay internal for staff follow-up), AND
//   * the patient has an explicit SMS opt-in (communication preferences
//     smsTransactional=true) — DME-only patients with no consent row are
//     never messaged, AND
//   * not inside the patient's DND window, AND
//   * no therapy-alert SMS in the last 14 days (frequency cap).
// Outreach sends a single gentle adherence nudge (no PHI specifics) via
// the shared sendReminderSms helper and stamps the alert's
// outreach_sent_at. Internal alerts are recorded regardless of the flag.

import type PgBoss from "pg-boss";

import {
  type CommunicationPreferences,
  DEFAULT_COMMUNICATION_PREFERENCES,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import {
  type SendActor,
  type SmsSendConfig,
  sendReminderSms,
} from "@workspace/resupply-reminders";

import {
  isInDndWindow,
  isOutsideSmsSendWindow,
  shouldSendSms,
} from "../../lib/comm-prefs.js";
import { isFeatureEnabled } from "../../lib/feature-flags.js";
import { logger } from "../../lib/logger.js";
import { claimDedupKey } from "../../lib/dedup-keys.js";
import {
  createQueueWithDlq,
  CRON_SCAN_QUEUE_OPTS,
} from "../lib/queue-options.js";

export const THERAPY_FLEET_ALERTS_JOB = "therapy-fleet.alerts-scan";

const WORKLIST_REASONS = [
  "compliance_risk",
  "high_ahi",
  "high_leak",
  "usage_decline",
  "no_recent_data",
] as const;
type WorklistReason = (typeof WORKLIST_REASONS)[number];

type AlertType = WorklistReason | "setup_at_risk";

const SEVERITY: Record<AlertType, "high" | "medium" | "low"> = {
  compliance_risk: "high",
  setup_at_risk: "high",
  high_ahi: "high",
  no_recent_data: "medium",
  high_leak: "medium",
  usage_decline: "low",
};

// Alert types appropriate to text a PATIENT (adherence nudges). Clinical
// signals (high_ahi / high_leak) are intentionally excluded — those are
// staff-follow-up, not a patient SMS.
const PATIENT_MESSAGEABLE: ReadonlySet<AlertType> = new Set<AlertType>([
  "compliance_risk",
  "no_recent_data",
  "setup_at_risk",
]);

// 14-day per-patient cap so a persistently-slipping patient isn't texted
// every night.
const OUTREACH_COOLDOWN_DAYS = 14;

export interface AlertsScanResult {
  detected: number;
  created: number;
  resolved: number;
  messaged: number;
}

export async function registerTherapyFleetAlertsJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(
    boss,
    THERAPY_FLEET_ALERTS_JOB,
    CRON_SCAN_QUEUE_OPTS,
  );
  await boss.work(THERAPY_FLEET_ALERTS_JOB, async () => {
    await runTherapyFleetAlertsScan();
  });
  // 19:15 UTC — afternoon across every US timezone, because this scan
  // can text patients (the old 05:15 UTC slot was ~midnight ET, and a
  // daily cron outside the 9am–8pm send window pairs badly with the
  // per-patient quiet-hours gate: the same patients would be skipped at
  // the same local hour forever). Still hours after the 05:00 daily
  // snapshot and 04:30 nightly sync, so it scans today's fresh data.
  await boss.schedule(THERAPY_FLEET_ALERTS_JOB, "15 19 * * *");
  logger.info(
    { queue: THERAPY_FLEET_ALERTS_JOB },
    "therapy fleet alerts-scan worker registered",
  );
}

interface DetectedAlert {
  patientId: string;
  alertType: AlertType;
  detail: Record<string, number | null>;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

// Read a shop_customers.communication_preferences JSON blob into a full
// prefs object, falling back to the opt-out defaults for missing keys.
function readPrefs(raw: unknown): CommunicationPreferences {
  if (!raw || typeof raw !== "object") {
    return DEFAULT_COMMUNICATION_PREFERENCES;
  }
  return {
    ...DEFAULT_COMMUNICATION_PREFERENCES,
    ...(raw as Partial<CommunicationPreferences>),
  };
}

function readSmsConfig(
  env: NodeJS.ProcessEnv = process.env,
): SmsSendConfig | null {
  const publicBaseUrl = (
    env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
    (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : "")
  ).replace(/\/+$/, "");
  if (
    !env.TWILIO_ACCOUNT_SID ||
    !env.TWILIO_AUTH_TOKEN ||
    !(env.TWILIO_PHONE_NUMBER || env.TWILIO_MESSAGING_SERVICE_SID) ||
    !publicBaseUrl
  ) {
    return null;
  }
  return {
    twilioAccountSid: env.TWILIO_ACCOUNT_SID,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN,
    twilioPhoneNumber: env.TWILIO_PHONE_NUMBER,
    twilioMessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
    publicBaseUrl,
    practiceName: env.RESUPPLY_PRACTICE_NAME ?? "PennPaps",
  };
}

export async function runTherapyFleetAlertsScan(): Promise<AlertsScanResult> {
  const supabase = getSupabaseServiceRoleClient();
  const result: AlertsScanResult = {
    detected: 0,
    created: 0,
    resolved: 0,
    messaged: 0,
  };

  // ── 1. detect ──────────────────────────────────────────────────
  const worklist = await supabase
    .schema("resupply")
    .rpc("therapy_fleet_worklist", { p_window_days: 30, p_limit: 1000 });
  if (worklist.error) throw worklist.error;
  const setups = await supabase
    .schema("resupply")
    .rpc("therapy_setup_adherence_list", { p_limit: 1000 });
  if (setups.error) throw setups.error;

  const detected: DetectedAlert[] = [];
  for (const r of (worklist.data ?? []) as Array<{
    patient_id: string;
    reasons: string[] | null;
    best_30day_count?: unknown;
    nights_over_4h?: unknown;
    avg_ahi?: unknown;
    avg_leak_l_min?: unknown;
    days_since_last_night?: unknown;
  }>) {
    for (const reason of r.reasons ?? []) {
      if (!(WORKLIST_REASONS as readonly string[]).includes(reason)) continue;
      detected.push({
        patientId: r.patient_id,
        alertType: reason as AlertType,
        detail: {
          nights_over_4h: num(r.nights_over_4h),
          avg_ahi: num(r.avg_ahi),
          avg_leak_l_min: num(r.avg_leak_l_min),
          days_since_last_night: num(r.days_since_last_night),
        },
      });
    }
  }
  for (const r of (setups.data ?? []) as Array<{
    patient_id: string;
    status: string;
    best_30day_count?: unknown;
    days_remaining?: unknown;
    nights_needed?: unknown;
  }>) {
    if (r.status !== "at_risk") continue;
    detected.push({
      patientId: r.patient_id,
      alertType: "setup_at_risk",
      detail: {
        best_30day_count: num(r.best_30day_count),
        days_remaining: num(r.days_remaining),
        nights_needed: num(r.nights_needed),
      },
    });
  }
  result.detected = detected.length;

  const detectedKeys = new Set(
    detected.map((d) => `${d.patientId}|${d.alertType}`),
  );

  // ── 2. reconcile against currently-open alerts ─────────────────
  const open = await supabase
    .schema("resupply")
    .from("therapy_fleet_alerts")
    .select("id, patient_id, alert_type")
    .eq("status", "open");
  if (open.error) throw open.error;
  const openKeys = new Set(
    (open.data ?? []).map(
      (r: { patient_id: string; alert_type: string }) =>
        `${r.patient_id}|${r.alert_type}`,
    ),
  );

  // Insert alerts that are newly detected (no open row yet).
  const nowIso = new Date().toISOString();
  const toInsert = detected.filter(
    (d) => !openKeys.has(`${d.patientId}|${d.alertType}`),
  );
  // De-dupe within this run (a patient could appear once per reason only,
  // but guard anyway).
  const insertedKeys = new Set<string>();
  const newAlerts: DetectedAlert[] = [];
  for (const d of toInsert) {
    const k = `${d.patientId}|${d.alertType}`;
    if (insertedKeys.has(k)) continue;
    insertedKeys.add(k);
    newAlerts.push(d);
  }
  if (newAlerts.length > 0) {
    const rows = newAlerts.map((d) => ({
      patient_id: d.patientId,
      alert_type: d.alertType,
      severity: SEVERITY[d.alertType],
      status: "open",
      detail: d.detail,
      updated_at: nowIso,
    }));
    const ins = await supabase
      .schema("resupply")
      .from("therapy_fleet_alerts")
      .insert(rows);
    if (ins.error) throw ins.error;
    result.created = rows.length;
  }

  // Auto-resolve open alerts the patient no longer trips.
  const staleIds = (open.data ?? [])
    .filter(
      (r: { patient_id: string; alert_type: string }) =>
        !detectedKeys.has(`${r.patient_id}|${r.alert_type}`),
    )
    .map((r: { id: string }) => r.id);
  if (staleIds.length > 0) {
    const upd = await supabase
      .schema("resupply")
      .from("therapy_fleet_alerts")
      .update({
        status: "resolved",
        resolved_at: nowIso,
        resolved_by_email: "system:worker:fleet-alerts",
        updated_at: nowIso,
      })
      .in("id", staleIds);
    if (upd.error) throw upd.error;
    result.resolved = staleIds.length;
  }

  // ── 3. opt-in patient auto-outreach (flag-gated) ───────────────
  const outreachOn =
    (await isFeatureEnabled("therapy_fleet.auto_outreach")) &&
    (await isFeatureEnabled("sms.reminders"));
  const cfg = outreachOn ? readSmsConfig() : null;
  if (outreachOn && cfg) {
    // Only newly-created, patient-appropriate alerts trigger a send.
    const candidates = newAlerts.filter((d) =>
      PATIENT_MESSAGEABLE.has(d.alertType),
    );
    // One send per patient per run even if multiple alert types fired.
    const seenPatients = new Set<string>();
    for (const d of candidates) {
      if (seenPatients.has(d.patientId)) continue;
      seenPatients.add(d.patientId);
      const sent = await maybeSendAdherenceSms(supabase, cfg, d.patientId);
      if (sent) {
        result.messaged += 1;
        const { error: outreachStampErr } = await supabase
          .schema("resupply")
          .from("therapy_fleet_alerts")
          .update({ outreach_sent_at: new Date().toISOString() })
          .eq("patient_id", d.patientId)
          .eq("alert_type", d.alertType)
          .eq("status", "open");
        if (outreachStampErr) {
          logger.warn(
            {
              err: outreachStampErr.message,
              patientId: d.patientId,
              alertType: d.alertType,
            },
            "therapy-fleet-alerts: outreach_sent_at stamp failed (non-fatal)",
          );
        }
      }
    }
  }

  logger.info(
    { queue: THERAPY_FLEET_ALERTS_JOB, ...result },
    "therapy fleet alerts scan complete",
  );
  return result;
}

// Returns true iff a message was actually dispatched. Enforces explicit
// SMS opt-in and DND BEFORE claiming the frequency-cap key.
//
// Ordering matters: the 14-day cap key must be claimed only once the
// patient is eligible AND about to be messaged. Claiming it up front (the
// old behavior) permanently suppressed any patient who was merely in their
// quiet-hours window or not-yet-opted-in at the instant this fixed-time
// nightly scan ran — e.g. a West-Coast patient whose DND window covers the
// 05:15 UTC scan tripped the DND gate every night while the cap key was
// re-claimed and held for 14 days, so they never received the nudge. The
// key is also released when the send doesn't actually go out, so a
// transient/no-op send doesn't burn the cooldown (mirrors
// reminders.ts:releaseReminderDedupKey).
async function maybeSendAdherenceSms(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  cfg: SmsSendConfig,
  patientId: string,
): Promise<boolean> {
  // Consent: look up the patient's communication preferences via their
  // shop_customers row (matched on lowercased email). No row / no opt-in
  // / inside the DND window → do not message (and do not claim the cap
  // key, so the next run re-evaluates).
  const patientRes = await supabase
    .schema("resupply")
    .from("patients")
    .select("email, timezone, address")
    .eq("id", patientId)
    .maybeSingle();
  const patientRow = patientRes.data as {
    email?: string | null;
    timezone?: string | null;
    address?: { zip?: string } | null;
  } | null;
  const email = patientRow?.email;
  if (!email) return false;
  const prefsRes = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select("communication_preferences")
    .eq("email_lower", email.toLowerCase())
    .maybeSingle();
  const prefs = readPrefs(
    (prefsRes.data as { communication_preferences?: unknown } | null)
      ?.communication_preferences,
  );
  const now = new Date();
  if (!shouldSendSms(prefs, "transactional", now)) return false;
  if (isInDndWindow(prefs, now)) return false;
  // Hard 9am–8pm patient-local TCPA window — the DND check above only
  // protects patients who configured a window (default null/null).
  // Evaluated BEFORE the cap claim, so a quiet-hours skip never burns
  // the 14-day cooldown.
  if (
    isOutsideSmsSendWindow(now, {
      timezone: patientRow?.timezone ?? null,
      shippingZip: patientRow?.address?.zip ?? null,
    })
  ) {
    return false;
  }

  // Frequency cap: claim a 14-day dedup key now that the patient is
  // eligible. "Held" means an UNEXPIRED row exists — we messaged this
  // patient within the window — skip. claimDedupKey clears an expired
  // row first; the old plain INSERT conflicted on the stale row too,
  // which made the 14-day cap permanent (P1-2).
  const capKey = `therapy-alert-sms:${patientId}`;
  const expiresAt = new Date(
    Date.now() + OUTREACH_COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const claim = await claimDedupKey(supabase, capKey, expiresAt);
  if (claim.outcome !== "claimed") {
    if (claim.outcome === "error") {
      logger.warn(
        {
          event: "therapy_fleet_adherence_cap_claim_failed",
          err: claim.error,
          queue: THERAPY_FLEET_ALERTS_JOB,
          dedup_key: capKey,
        },
        "therapy fleet: failed to claim adherence cap key",
      );
    }
    return false;
  }

  const body =
    `It's ${cfg.practiceName}. We noticed your CPAP use has dipped recently — ` +
    `steady nightly use keeps your therapy working and your insurance ` +
    `coverage on track. We're here if you need help. Reply STOP to opt out.`;

  const actor: SendActor = { kind: "system", jobId: THERAPY_FLEET_ALERTS_JOB };
  try {
    const outcome = await sendReminderSms({
      supabase,
      cfg,
      patientId,
      body,
      actor,
    });
    if (outcome.status === "ok") return true;
    // Didn't actually dispatch (e.g. no routable phone) — release the cap
    // key so a later run can retry instead of suppressing for 14 days.
    await releaseAdherenceCapKey(supabase, capKey);
    return false;
  } catch (err) {
    logger.warn(
      { err, queue: THERAPY_FLEET_ALERTS_JOB },
      "therapy fleet adherence SMS send failed",
    );
    await releaseAdherenceCapKey(supabase, capKey);
    return false;
  }
}

// Release a previously-claimed adherence frequency-cap key when the send
// didn't actually go out, so the patient isn't suppressed for the full
// cooldown over a transient or no-op send.
async function releaseAdherenceCapKey(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  key: string,
): Promise<void> {
  const { error } = await supabase
    .schema("resupply")
    .from("worker_dedup_keys")
    .delete()
    .eq("key", key);
  if (error) {
    logger.warn(
      {
        event: "therapy_fleet_adherence_cap_release_failed",
        err: { code: error.code, message: error.message },
        queue: THERAPY_FLEET_ALERTS_JOB,
        dedup_key: key,
      },
      "therapy fleet: failed to release adherence cap key after non-send",
    );
  }
}
