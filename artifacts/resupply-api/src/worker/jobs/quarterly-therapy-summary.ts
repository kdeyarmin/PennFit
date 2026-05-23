// pg-boss job: proactive quarterly therapy-summary email.
//
// Why this exists
// ---------------
// /shop/me/quarterly-summary already builds the 90-day rollup the
// patient can forward to their physician — but the surface is
// pull-only. Patients have to navigate to /account and click into
// it, and almost nobody does proactively. This worker pushes the
// same rollup to the patient's inbox every ~90 days so it lands
// at the cadence payers and primary-care physicians ask for it.
//
// What this job does
// ------------------
// Daily 06:17 UTC (off-peak, between the Rx-renewal dispatcher at
// 04:43 and the maintenance-nudge weekly Sunday slot at 11:13).
//
//   1. SELECT patients with email and either:
//        * quarterly_summary_last_sent_at IS NULL, OR
//        * quarterly_summary_last_sent_at < now() - 90 days.
//   2. For each, pull the last 90 days of patient_therapy_nights.
//   3. Skip patients with fewer than MIN_NIGHTS_FOR_SUMMARY recorded
//      nights (a 5-night summary is meaningless; we wait until
//      there's a meaningful adherence picture).
//   4. Walk to shop_customers (by lowercased email) to consult
//      communication_preferences.emailMarketing. Default = honor
//      the schema-level "marketing OFF by default" posture, so
//      patients without a shop_customers row are NOT auto-emailed.
//      The mid-funnel pre-account patient is a real cohort; the
//      summary is for engaged customers.
//   5. Atomic-claim the timestamp BEFORE the send. SendGrid failure
//      releases the claim so the next daily run retries.
//
// Soft cap of 300 sends per run so a backlog of newly-90d-eligible
// patients can't burst the SendGrid quota.

import type PgBoss from "pg-boss";

import {
  DEFAULT_COMMUNICATION_PREFERENCES,
  type CommunicationPreferences,
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { buildQuarterlySummary } from "../../lib/therapy-summary/build-quarterly-html";
import { sendQuarterlySummaryEmail } from "../../lib/order-emails/send-quarterly-summary-email";
import { shouldSendEmail } from "../../lib/comm-prefs";
import { logger } from "../../lib/logger";

const JOB_NAME = "patients.quarterly-summary";
const JOB_CRON = "17 6 * * *"; // Daily 06:17 UTC.

/** 90 days between sends per patient. */
const RESEND_COOLDOWN_DAYS = 90;
/** Window length the summary covers. */
const WINDOW_DAYS = 90;
/** Don't email a one-week-of-data summary; it's meaningless. */
const MIN_NIGHTS_FOR_SUMMARY = 14;
/** Soft per-run cap to avoid bursting SendGrid. */
const PER_RUN_MAX = 300;

export interface QuarterlySummaryStats {
  candidates: number;
  sent: number;
  skippedNoData: number;
  skippedOptedOut: number;
  skippedNoShopCustomer: number;
  failed: number;
}

interface PatientRow {
  id: string;
  email: string;
  legal_first_name: string;
  legal_last_name: string;
  // date_of_birth is non-null in the resupply.patients schema today
  // (it's a column populated at intake and required for Medicare
  // claims). Type as `string` so the predicate satisfies the row
  // shape without an extra optional-property allowance downstream.
  date_of_birth: string;
  quarterly_summary_last_sent_at: string | null;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function readPrefs(raw: Json | null): CommunicationPreferences {
  if (!raw || typeof raw !== "object") {
    return DEFAULT_COMMUNICATION_PREFERENCES;
  }
  return {
    ...DEFAULT_COMMUNICATION_PREFERENCES,
    ...(raw as Partial<CommunicationPreferences>),
  };
}

export async function runQuarterlyTherapySummary(): Promise<QuarterlySummaryStats> {
  const supabase = getSupabaseServiceRoleClient();
  const stats: QuarterlySummaryStats = {
    candidates: 0,
    sent: 0,
    skippedNoData: 0,
    skippedOptedOut: 0,
    skippedNoShopCustomer: 0,
    failed: 0,
  };

  const cooldownThreshold = isoDaysAgo(RESEND_COOLDOWN_DAYS);

  const { data: candidates, error } = await supabase
    .schema("resupply")
    .from("patients")
    .select(
      "id, email, legal_first_name, legal_last_name, date_of_birth, quarterly_summary_last_sent_at",
    )
    .not("email", "is", null)
    .or(
      `quarterly_summary_last_sent_at.is.null,quarterly_summary_last_sent_at.lt.${cooldownThreshold}`,
    )
    .limit(PER_RUN_MAX * 2);
  if (error) throw error;

  const rows: PatientRow[] = (candidates ?? []).filter(
    (r): r is PatientRow => typeof r.email === "string" && r.email.length > 0,
  );

  const practiceName = process.env.RESUPPLY_PRACTICE_NAME?.trim() || "PennPaps";

  for (const patient of rows) {
    if (stats.sent >= PER_RUN_MAX) break;
    stats.candidates += 1;

    // Honor comm-prefs by joining via lowercased email. A patient
    // who never created a shop_customer row implicitly inherits the
    // "marketing OFF by default" stance — we skip them. Engaged
    // customers (the target cohort for this email) all have a row
    // via /account.
    // .eq is exact; .ilike would let `_` / `%` in the patient's
    // email cross-match other rows and resolve opt-in against the
    // wrong customer.
    const { data: cust } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .select("communication_preferences")
      .eq("email_lower", patient.email.toLowerCase())
      .limit(1)
      .maybeSingle();
    if (!cust) {
      stats.skippedNoShopCustomer += 1;
      continue;
    }
    const prefs = readPrefs(cust.communication_preferences ?? null);
    if (!shouldSendEmail(prefs, "marketing")) {
      stats.skippedOptedOut += 1;
      continue;
    }

    // Pull the patient's nights. Cap at WINDOW_DAYS * 4 to bound
    // the read; a patient with multiple sync sources may have
    // duplicate dates which buildQuarterlySummary dedups.
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd);
    windowStart.setUTCDate(windowStart.getUTCDate() - WINDOW_DAYS);
    const startIso = windowStart.toISOString().slice(0, 10);
    const endIso = windowEnd.toISOString().slice(0, 10);

    const { data: nights, error: nightsErr } = await supabase
      .schema("resupply")
      .from("patient_therapy_nights")
      .select("night_date, usage_minutes, ahi, leak_rate_l_min")
      .eq("patient_id", patient.id)
      .gte("night_date", startIso)
      .order("night_date", { ascending: true })
      .limit(WINDOW_DAYS * 4);
    if (nightsErr) {
      logger.warn(
        { err: nightsErr.message, patientId: patient.id },
        "quarterly-summary: night read failed",
      );
      stats.failed += 1;
      continue;
    }

    const summary = buildQuarterlySummary({
      patient: {
        legalFirstName: patient.legal_first_name,
        legalLastName: patient.legal_last_name,
        dateOfBirth: patient.date_of_birth,
      },
      windowStart: startIso,
      windowEnd: endIso,
      practiceName,
      nights: (nights ?? []).map((n) => ({
        nightDate: n.night_date,
        usageMinutes: n.usage_minutes,
        ahi: n.ahi == null ? null : Number(n.ahi),
        leakLMin: n.leak_rate_l_min == null ? null : Number(n.leak_rate_l_min),
      })),
    });

    if (summary.fields.nightsRecorded < MIN_NIGHTS_FOR_SUMMARY) {
      stats.skippedNoData += 1;
      continue;
    }

    // Atomic claim — stamp before the send.
    const claimIso = new Date().toISOString();
    const { data: claimed, error: claimErr } = await supabase
      .schema("resupply")
      .from("patients")
      .update({ quarterly_summary_last_sent_at: claimIso })
      .eq("id", patient.id)
      .or(
        `quarterly_summary_last_sent_at.is.null,quarterly_summary_last_sent_at.lt.${cooldownThreshold}`,
      )
      .select("id");
    if (claimErr) {
      logger.warn(
        { err: claimErr.message, patientId: patient.id },
        "quarterly-summary: claim failed",
      );
      stats.failed += 1;
      continue;
    }
    if (!claimed || claimed.length === 0) {
      // Lost the race or already stamped after our read.
      continue;
    }

    const releaseClaim = async (): Promise<void> => {
      await supabase
        .schema("resupply")
        .from("patients")
        .update({
          quarterly_summary_last_sent_at:
            patient.quarterly_summary_last_sent_at,
        })
        .eq("id", patient.id);
    };

    try {
      const result = await sendQuarterlySummaryEmail({
        toEmail: patient.email,
        firstName: patient.legal_first_name,
        windowStart: startIso,
        windowEnd: endIso,
        fields: summary.fields,
      });
      if (!result.configured) {
        await releaseClaim();
        continue;
      }
      if (!result.delivered) {
        await releaseClaim();
        stats.failed += 1;
        logger.warn(
          { patientId: patient.id, err: result.error },
          "quarterly-summary: send failed",
        );
        continue;
      }
      stats.sent += 1;
    } catch (err) {
      await releaseClaim();
      stats.failed += 1;
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          patientId: patient.id,
        },
        "quarterly-summary: send threw",
      );
    }
  }

  return stats;
}

export async function registerQuarterlyTherapySummaryJob(
  boss: PgBoss,
): Promise<void> {
  await boss.createQueue(JOB_NAME);

  await boss.work(JOB_NAME, async () => {
    try {
      const stats = await runQuarterlyTherapySummary();
      logger.info(
        { event: "patients.quarterly-summary.completed", ...stats },
        "patients.quarterly-summary: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "patients.quarterly-summary: failed",
      );
      throw err;
    }
  });

  await boss.schedule(JOB_NAME, JOB_CRON);
  logger.info({ cron: JOB_CRON }, "patients.quarterly-summary scheduled");
}
