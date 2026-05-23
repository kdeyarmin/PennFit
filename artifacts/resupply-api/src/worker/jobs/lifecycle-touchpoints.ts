// pg-boss job: daily birthday + sleep-therapy anniversary touchpoint
// dispatcher.
//
// Why this exists
// ---------------
// Patient_therapy_milestones (0120) fires on therapy COUNTS — 100
// nights, 365 nights, first adherence month. Those are clinical
// signals tied to actual usage. Calendar signals are different
// (and complementary): the birthday and the calendar anniversary
// of first therapy land regardless of recent activity, and the
// open + click rates on those touchpoints are uncommonly high in
// DME adherence literature.
//
// Schedule
// --------
// Daily at 13:33 UTC — mid-afternoon hits US inboxes during waking
// hours and stays clear of every other resupply cron.
//
// Eligibility (per patient, per kind)
// -----------------------------------
//   BIRTHDAY
//     * patients.date_of_birth's MM-DD matches today's MM-DD, and
//     * patients.birthday_email_year_sent != current year, and
//     * patients.email IS NOT NULL, and
//     * matching shop_customer's emailMarketing preference is true.
//
//   SLEEP_ANNIVERSARY
//     * Patient has a recorded first-therapy night, and
//     * That night's MM-DD matches today's MM-DD, and
//     * sleep_anniversary_year_sent != current year, and
//     * (same email + emailMarketing gates).
//
// Idempotency stamps the current YEAR (not a timestamp) so a re-run
// in the same day is a no-op. The same pattern is used by the
// deductible-reset push.

import type PgBoss from "pg-boss";

import {
  DEFAULT_COMMUNICATION_PREFERENCES,
  type CommunicationPreferences,
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { sendLifecycleTouchpointEmail } from "../../lib/order-emails/send-lifecycle-touchpoint-email";
import { shouldSendEmail } from "../../lib/comm-prefs";
import { logger } from "../../lib/logger";

const JOB_NAME = "patients.lifecycle-touchpoints";
const JOB_CRON = "33 13 * * *";

/** Cap per run so a "calendar collision" day (many patients sharing
 *  a popular birth date) doesn't burst the SendGrid quota. */
const PER_KIND_MAX = 500;

export interface TouchpointStats {
  birthdayCandidates: number;
  birthdaySent: number;
  birthdayFailed: number;
  anniversaryCandidates: number;
  anniversarySent: number;
  anniversaryFailed: number;
  skippedOptedOut: number;
  skippedNoShopCustomer: number;
}

interface PatientRow {
  id: string;
  email: string;
  legal_first_name: string;
  date_of_birth: string;
  birthday_email_year_sent: number | null;
  sleep_anniversary_year_sent: number | null;
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

function todayMmDd(now: Date = new Date()): string {
  return now.toISOString().slice(5, 10); // "MM-DD"
}

/**
 * Build the list of MM-DD patterns the birthday-email pass should
 * match for `today`. Always includes today's MM-DD. In a non-leap
 * year, ALSO includes "02-29" when today is "02-28" so Feb-29
 * patients see a birthday email each year (we celebrate them on
 * Feb 28; Mar 1 is also a defensible choice but Feb 28 keeps the
 * birthday in February).
 */
function birthdayPatternsForToday(now: Date = new Date()): string[] {
  const today = todayMmDd(now);
  const patterns = [today];
  if (today === "02-28") {
    const year = now.getUTCFullYear();
    const isLeapYear =
      (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    if (!isLeapYear) {
      patterns.push("02-29");
    }
  }
  return patterns;
}

async function isOptedIn(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  email: string,
): Promise<{ optedIn: boolean; hadShopCustomer: boolean }> {
  // .eq is exact; .ilike would let an email containing `_` or `%`
  // cross-match other patients' shop_customers rows and resolve
  // the opt-in gate against the wrong row.
  const { data: cust } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select("communication_preferences")
    .eq("email_lower", email.toLowerCase())
    .limit(1)
    .maybeSingle();
  if (!cust) return { optedIn: false, hadShopCustomer: false };
  const prefs = readPrefs(cust.communication_preferences ?? null);
  return {
    optedIn: shouldSendEmail(prefs, "marketing"),
    hadShopCustomer: true,
  };
}

export async function runLifecycleTouchpoints(
  now: Date = new Date(),
): Promise<TouchpointStats> {
  const supabase = getSupabaseServiceRoleClient();
  const stats: TouchpointStats = {
    birthdayCandidates: 0,
    birthdaySent: 0,
    birthdayFailed: 0,
    anniversaryCandidates: 0,
    anniversarySent: 0,
    anniversaryFailed: 0,
    skippedOptedOut: 0,
    skippedNoShopCustomer: 0,
  };
  const mmdd = todayMmDd(now);
  const currentYear = now.getUTCFullYear();

  // ── BIRTHDAY pass ───────────────────────────────────────────────
  // Filter SQL-side on the MM-DD of date_of_birth using to_char.
  // PostgREST doesn't expose to_char directly; emulate with substring.
  // patients.date_of_birth is a `date`; substring(...) gives 'YYYY-MM-DD'.
  // Match today's MM-DD AND, on Feb 28 in a non-leap year, ALSO
  // match Feb 29 patients so their birthday email lands once a year
  // instead of skipping three years out of four.
  const bdayPatterns = birthdayPatternsForToday(now);
  const bdayPatternExpr = bdayPatterns
    .map((p) => `date_of_birth.ilike.*-${p}`)
    .join(",");
  const { data: bdayRows, error: bdayErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select(
      "id, email, legal_first_name, date_of_birth, birthday_email_year_sent, sleep_anniversary_year_sent",
    )
    .not("email", "is", null)
    .or(bdayPatternExpr)
    .or(
      `birthday_email_year_sent.is.null,birthday_email_year_sent.neq.${currentYear}`,
    )
    .limit(PER_KIND_MAX * 2);
  if (bdayErr) throw bdayErr;
  for (const row of (bdayRows ?? []) as PatientRow[]) {
    if (stats.birthdaySent >= PER_KIND_MAX) break;
    stats.birthdayCandidates += 1;
    const gate = await isOptedIn(supabase, row.email);
    if (!gate.hadShopCustomer) {
      stats.skippedNoShopCustomer += 1;
      continue;
    }
    if (!gate.optedIn) {
      stats.skippedOptedOut += 1;
      continue;
    }
    const { data: claimed, error: claimErr } = await supabase
      .schema("resupply")
      .from("patients")
      .update({ birthday_email_year_sent: currentYear })
      .eq("id", row.id)
      .or(
        `birthday_email_year_sent.is.null,birthday_email_year_sent.neq.${currentYear}`,
      )
      .select("id");
    if (claimErr) {
      logger.warn(
        { err: claimErr.message, patientId: row.id },
        "lifecycle-touchpoints: birthday claim failed",
      );
      stats.birthdayFailed += 1;
      continue;
    }
    if (!claimed || claimed.length === 0) continue;
    try {
      const r = await sendLifecycleTouchpointEmail({
        toEmail: row.email,
        firstName: row.legal_first_name,
        kind: "birthday",
      });
      if (!r.delivered) {
        await supabase
          .schema("resupply")
          .from("patients")
          .update({ birthday_email_year_sent: row.birthday_email_year_sent })
          .eq("id", row.id);
        stats.birthdayFailed += 1;
        continue;
      }
      stats.birthdaySent += 1;
    } catch (err) {
      await supabase
        .schema("resupply")
        .from("patients")
        .update({ birthday_email_year_sent: row.birthday_email_year_sent })
        .eq("id", row.id);
      stats.birthdayFailed += 1;
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          patientId: row.id,
        },
        "lifecycle-touchpoints: birthday send threw",
      );
    }
  }

  // ── ANNIVERSARY pass ────────────────────────────────────────────
  // The patient's "first therapy night" lives in patient_therapy_nights.
  // We MIN(night_date) per patient — PostgREST doesn't expose
  // aggregates, so we do this row-by-row inside the loop, narrowed
  // to patients with at least one night.
  //
  // For efficiency: first scan candidates (patients with non-null
  // email + not stamped this year). Then per-patient query the
  // earliest night. That's an O(N) scan over patients but each
  // per-row lookup hits the patient_therapy_nights index on
  // patient_id.
  const { data: anniversaryRows, error: annErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select(
      "id, email, legal_first_name, date_of_birth, birthday_email_year_sent, sleep_anniversary_year_sent",
    )
    .not("email", "is", null)
    .or(
      `sleep_anniversary_year_sent.is.null,sleep_anniversary_year_sent.neq.${currentYear}`,
    )
    .limit(PER_KIND_MAX * 4);
  if (annErr) throw annErr;
  for (const row of (anniversaryRows ?? []) as PatientRow[]) {
    if (stats.anniversarySent >= PER_KIND_MAX) break;
    const { data: firstNight } = await supabase
      .schema("resupply")
      .from("patient_therapy_nights")
      .select("night_date")
      .eq("patient_id", row.id)
      .order("night_date", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!firstNight?.night_date) continue;
    if (firstNight.night_date.slice(5, 10) !== mmdd) continue;
    const firstYear = Number(firstNight.night_date.slice(0, 4));
    if (!Number.isFinite(firstYear) || firstYear >= currentYear) continue;

    stats.anniversaryCandidates += 1;
    const gate = await isOptedIn(supabase, row.email);
    if (!gate.hadShopCustomer) {
      stats.skippedNoShopCustomer += 1;
      continue;
    }
    if (!gate.optedIn) {
      stats.skippedOptedOut += 1;
      continue;
    }
    const { data: claimed, error: claimErr } = await supabase
      .schema("resupply")
      .from("patients")
      .update({ sleep_anniversary_year_sent: currentYear })
      .eq("id", row.id)
      .or(
        `sleep_anniversary_year_sent.is.null,sleep_anniversary_year_sent.neq.${currentYear}`,
      )
      .select("id");
    if (claimErr) {
      logger.warn(
        { err: claimErr.message, patientId: row.id },
        "lifecycle-touchpoints: anniversary claim failed",
      );
      stats.anniversaryFailed += 1;
      continue;
    }
    if (!claimed || claimed.length === 0) continue;
    try {
      const r = await sendLifecycleTouchpointEmail({
        toEmail: row.email,
        firstName: row.legal_first_name,
        kind: "sleep_anniversary",
        yearsOnTherapy: currentYear - firstYear,
      });
      if (!r.delivered) {
        await supabase
          .schema("resupply")
          .from("patients")
          .update({
            sleep_anniversary_year_sent: row.sleep_anniversary_year_sent,
          })
          .eq("id", row.id);
        stats.anniversaryFailed += 1;
        continue;
      }
      stats.anniversarySent += 1;
    } catch (err) {
      await supabase
        .schema("resupply")
        .from("patients")
        .update({
          sleep_anniversary_year_sent: row.sleep_anniversary_year_sent,
        })
        .eq("id", row.id);
      stats.anniversaryFailed += 1;
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          patientId: row.id,
        },
        "lifecycle-touchpoints: anniversary send threw",
      );
    }
  }

  return stats;
}

export async function registerLifecycleTouchpointsJob(
  boss: PgBoss,
): Promise<void> {
  await boss.createQueue(JOB_NAME);
  await boss.work(JOB_NAME, async () => {
    try {
      const stats = await runLifecycleTouchpoints();
      logger.info(
        { event: "patients.lifecycle-touchpoints.completed", ...stats },
        "patients.lifecycle-touchpoints: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "patients.lifecycle-touchpoints: failed",
      );
      throw err;
    }
  });
  await boss.schedule(JOB_NAME, JOB_CRON);
  logger.info({ cron: JOB_CRON }, "patients.lifecycle-touchpoints scheduled");
}
