// pg-boss job: daily CPAP setup-deadline outreach.
//
// The setup-adherence RPC already computes, for every patient inside
// their initial 90-day Medicare window, days_remaining + nights_needed +
// status (qualified / on_track / at_risk). That tracker was pull-only:
// nothing turned the countdown into proactive, deadline-aware contact.
// This job does — it reaches the patient whose qualifying window is
// closing with an escalating, specific nudge ("about N more 4h+ nights
// in the next D days to keep your coverage"), tiered by days_remaining.
//
// Coordination with therapy-fleet.alerts-scan
// -------------------------------------------
// alerts-scan also messages setup_at_risk patients (a generic nudge).
// To avoid double-texting, this job:
//   * runs FIRST (05:05, before alerts-scan at 05:15), and
//   * claims the SAME shared per-patient frequency-cap key
//     (`therapy-alert-sms:<patientId>`, 14-day) alerts-scan uses.
// So a setup-window patient gets the deadline-specific message
// preferentially, and alerts-scan skips anyone already messaged.
//
// Gating mirrors alerts-scan exactly: the `therapy_fleet.auto_outreach`
// flag (off by default) + `sms.reminders` + Twilio configured, and per
// patient an explicit smsTransactional opt-in, no DND, and the 14-day
// frequency cap. Internal tracking is untouched — this only sends SMS.

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
import { claimDedupKey } from "../../lib/dedup-keys.js";
import { isFeatureEnabled } from "../../lib/feature-flags.js";
import { logger } from "../../lib/logger.js";
import {
  createQueueWithDlq,
  CRON_SCAN_QUEUE_OPTS,
} from "../lib/queue-options.js";

export const SETUP_DEADLINE_OUTREACH_JOB = "therapy-setup.deadline-outreach";

// Only act once the deadline is genuinely approaching, so we don't nag a
// patient on day 5 of 90. on_track patients enter the outreach set at
// <= 45 days remaining; at_risk patients are always eligible (they need
// intervention now). qualified patients are never messaged.
const ONTRACK_OUTREACH_WINDOW_DAYS = 45;

// Shared with therapy-fleet.alerts-scan so the two never double-text the
// same patient inside the window.
const OUTREACH_COOLDOWN_DAYS = 14;

export interface SetupDeadlineOutreachResult {
  inWindow: number;
  eligible: number;
  messaged: number;
}

export async function registerSetupDeadlineOutreachJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(
    boss,
    SETUP_DEADLINE_OUTREACH_JOB,
    CRON_SCAN_QUEUE_OPTS,
  );
  await boss.work(SETUP_DEADLINE_OUTREACH_JOB, async () => {
    await runSetupDeadlineOutreach();
  });
  // 19:05 UTC — afternoon across every US timezone, because this job
  // texts patients (the old 05:05 UTC slot was ~midnight ET; a daily
  // cron outside the 9am–8pm send window pairs badly with the
  // per-patient quiet-hours gate — the same patients would be skipped
  // at the same local hour forever). Still hours after the 04:30
  // nightly therapy sync, and still BEFORE the 19:15 alerts-scan so
  // the deadline message wins the shared cap key.
  await boss.schedule(SETUP_DEADLINE_OUTREACH_JOB, "5 19 * * *");
  logger.info(
    { queue: SETUP_DEADLINE_OUTREACH_JOB },
    "therapy setup-deadline-outreach worker registered",
  );
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

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

interface SetupRow {
  patient_id: string;
  status: string;
  days_remaining: number;
  nights_needed: number;
}

// Decide whether a setup-adherence row is due for a deadline nudge, and
// which message tier. Returns null to skip.
export function planDeadlineOutreach(
  row: SetupRow,
  practiceName: string,
): string | null {
  const { status, days_remaining: dr, nights_needed: nn } = row;
  if (status === "qualified") return null;

  if (status === "at_risk") {
    // Mathematically can't reach the threshold before day 90 — don't
    // promise "N more nights". Offer help (re-fit / comfort / a call).
    return (
      `${practiceName}: Let's get your CPAP therapy back on track so your ` +
      `insurance keeps covering it. We can help with mask fit or comfort — ` +
      `reply and a team member will reach out. Reply STOP to opt out.`
    );
  }

  // on_track: reachable, but only nudge once the deadline is approaching.
  if (status !== "on_track") return null;
  if (nn <= 0) return null;
  if (dr > ONTRACK_OUTREACH_WINDOW_DAYS) return null;

  if (dr <= 7) {
    return (
      `${practiceName}: You're almost qualified for CPAP coverage — about ` +
      `${nn} more night(s) of 4+ hours in the next ${dr} day(s) locks it in. ` +
      `You've got this! Reply if we can help. Reply STOP to opt out.`
    );
  }
  if (dr <= 14) {
    return (
      `${practiceName}: ~2 weeks left to secure your CPAP insurance coverage ` +
      `— about ${nn} more night(s) of 4+ hours will do it. Keep it up! ` +
      `Reply if we can help. Reply STOP to opt out.`
    );
  }
  return (
    `${practiceName}: Quick check-in — steady 4+ hour nightly CPAP use keeps ` +
    `your insurance coverage on track (about ${nn} more qualifying night(s) ` +
    `to go). We're here to help. Reply STOP to opt out.`
  );
}

export async function runSetupDeadlineOutreach(): Promise<SetupDeadlineOutreachResult> {
  const supabase = getSupabaseServiceRoleClient();
  const result: SetupDeadlineOutreachResult = {
    inWindow: 0,
    eligible: 0,
    messaged: 0,
  };

  const outreachOn =
    (await isFeatureEnabled("therapy_fleet.auto_outreach")) &&
    (await isFeatureEnabled("sms.reminders"));
  const cfg = outreachOn ? readSmsConfig() : null;

  const setups = await supabase
    .schema("resupply")
    .rpc("therapy_setup_adherence_list", { p_limit: 1000 });
  if (setups.error) throw setups.error;

  const rows = (setups.data ?? []) as Array<{
    patient_id: string;
    status?: unknown;
    days_remaining?: unknown;
    nights_needed?: unknown;
  }>;
  result.inWindow = rows.length;

  // Compute the message plan for each patient (pure). This also lets the
  // job report `eligible` even when outreach is off (visibility for the
  // operator deciding whether to enable the flag).
  const planned: Array<{ patientId: string; body: string }> = [];
  for (const r of rows) {
    const body = planDeadlineOutreach(
      {
        patient_id: r.patient_id,
        status: String(r.status ?? ""),
        days_remaining: num(r.days_remaining) ?? Number.POSITIVE_INFINITY,
        nights_needed: num(r.nights_needed) ?? 0,
      },
      cfg?.practiceName ?? "PennPaps",
    );
    if (body) planned.push({ patientId: r.patient_id, body });
  }
  result.eligible = planned.length;

  if (outreachOn && cfg) {
    const seen = new Set<string>();
    for (const p of planned) {
      if (seen.has(p.patientId)) continue;
      seen.add(p.patientId);
      const sent = await maybeSendDeadlineSms(
        supabase,
        cfg,
        p.patientId,
        p.body,
      );
      if (sent) result.messaged += 1;
    }
  }

  logger.info(
    { queue: SETUP_DEADLINE_OUTREACH_JOB, ...result, outreachOn },
    "therapy setup-deadline outreach complete",
  );
  return result;
}

// Returns true iff a message was actually dispatched. Mirrors
// alerts-scan's consent → DND → claim-cap ordering exactly, and shares
// the SAME cap key namespace so the two jobs can't double-text a patient.
async function maybeSendDeadlineSms(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  cfg: SmsSendConfig,
  patientId: string,
  body: string,
): Promise<boolean> {
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

  // Shared 14-day cap key — identical to therapy-fleet.alerts-scan, so a
  // patient never receives both a deadline nudge and a generic adherence
  // nudge inside the window. claimDedupKey clears an expired row first;
  // the old plain INSERT conflicted on the stale row too, which made the
  // 14-day cap permanent (P1-2).
  const capKey = `therapy-alert-sms:${patientId}`;
  const expiresAt = new Date(
    Date.now() + OUTREACH_COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const claim = await claimDedupKey(supabase, capKey, expiresAt);
  if (claim.outcome !== "claimed") {
    if (claim.outcome === "error") {
      logger.warn(
        {
          event: "setup_deadline_cap_claim_failed",
          err: claim.error,
          queue: SETUP_DEADLINE_OUTREACH_JOB,
          dedup_key: capKey,
        },
        "setup-deadline: failed to claim cap key",
      );
    }
    return false;
  }

  const actor: SendActor = {
    kind: "system",
    jobId: SETUP_DEADLINE_OUTREACH_JOB,
  };
  try {
    const outcome = await sendReminderSms({
      supabase,
      cfg,
      patientId,
      body,
      actor,
    });
    if (outcome.status === "ok") return true;
    await releaseCapKey(supabase, capKey);
    return false;
  } catch (err) {
    logger.warn(
      { err, queue: SETUP_DEADLINE_OUTREACH_JOB },
      "setup-deadline SMS send failed",
    );
    await releaseCapKey(supabase, capKey);
    return false;
  }
}

async function releaseCapKey(
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
        event: "setup_deadline_cap_release_failed",
        err: { code: error.code, message: error.message },
        queue: SETUP_DEADLINE_OUTREACH_JOB,
      },
      "setup-deadline: failed to release cap key after non-send",
    );
  }
}
