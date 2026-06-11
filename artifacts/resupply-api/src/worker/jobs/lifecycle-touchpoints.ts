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
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";

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
    const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    if (!isLeapYear) {
      patterns.push("02-29");
    }
  }
  return patterns;
}

type OptInStatus = { optedIn: boolean; hadShopCustomer: boolean };

/**
 * Batch the per-email opt-in gate into one query per 200 emails, keyed
 * by lower-cased email. Use when every candidate in a pass needs its
 * opt-in status anyway — replaces an N+1 of single-row shop_customers
 * lookups inside the send loop. Exact-match (`.eq`/`.in` on email_lower)
 * semantics — a `_`/`%` in an email can't cross-match another row.
 */
async function loadOptInStatuses(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  emails: readonly string[],
): Promise<Map<string, OptInStatus>> {
  const lowered = [...new Set(emails.map((e) => e.toLowerCase()))];
  const byEmail = new Map<string, OptInStatus>();
  const CHUNK = 200;
  for (let i = 0; i < lowered.length; i += CHUNK) {
    const chunk = lowered.slice(i, i + CHUNK);
    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .select("email_lower, communication_preferences")
      .in("email_lower", chunk);
    if (error) {
      logger.warn(
        { err: error, chunkSize: chunk.length },
        "lifecycle-touchpoints: opt-in batch lookup failed (treating as no shop_customer)",
      );
      continue;
    }
    const rowCounts = new Map<string, number>();
    const prefsByEmail = new Map<string, CommunicationPreferences>();
    for (const r of rows ?? []) {
      if (!r.email_lower) continue;
      rowCounts.set(r.email_lower, (rowCounts.get(r.email_lower) ?? 0) + 1);
      if (!prefsByEmail.has(r.email_lower)) {
        prefsByEmail.set(
          r.email_lower,
          readPrefs(r.communication_preferences ?? null),
        );
      }
    }
    for (const [email, count] of rowCounts) {
      if (count !== 1) continue;
      const prefs = prefsByEmail.get(email);
      if (!prefs) continue;
      byEmail.set(email, {
        optedIn: shouldSendEmail(prefs, "marketing"),
        hadShopCustomer: true,
      });
    }
  }
  return byEmail;
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
  // ORDER BY id so popular birthdates (e.g. Jan 1, Jul 4) that
  // exceed `PER_KIND_MAX * 2` candidates still rotate through cohorts
  // across cron ticks. Without an explicit order the planner picks
  // an arbitrary set; rows past the limit never get a chance.
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
    .order("id", { ascending: true })
    .limit(PER_KIND_MAX * 2);
  if (bdayErr) throw bdayErr;
  // Every birthday candidate hits the opt-in gate immediately, so resolve
  // them all in one batched read instead of a query per candidate.
  const bdayOptIn = await loadOptInStatuses(
    supabase,
    ((bdayRows ?? []) as PatientRow[]).map((r) => r.email),
  );
  for (const row of (bdayRows ?? []) as PatientRow[]) {
    if (stats.birthdaySent >= PER_KIND_MAX) break;
    stats.birthdayCandidates += 1;
    const gate = bdayOptIn.get(row.email.toLowerCase()) ?? {
      optedIn: false,
      hadShopCustomer: false,
    };
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
        // Roll back the stamp so next tick can retry. Check the
        // rollback errored — if Supabase blips here, the stamp
        // sticks and the patient silently won't see a birthday
        // email until next year.
        const { error: rollbackErr } = await supabase
          .schema("resupply")
          .from("patients")
          .update({ birthday_email_year_sent: row.birthday_email_year_sent })
          .eq("id", row.id);
        if (rollbackErr) {
          logger.error(
            {
              err: rollbackErr.message,
              patientId: row.id,
              event: "lifecycle_touchpoints_birthday_stamp_rollback_failed",
            },
            "lifecycle-touchpoints: birthday stamp rollback failed — patient may be permanently skipped this year",
          );
        }
        stats.birthdayFailed += 1;
        continue;
      }
      stats.birthdaySent += 1;
    } catch (err) {
      const { error: rollbackErr } = await supabase
        .schema("resupply")
        .from("patients")
        .update({ birthday_email_year_sent: row.birthday_email_year_sent })
        .eq("id", row.id);
      if (rollbackErr) {
        logger.error(
          {
            err: rollbackErr.message,
            patientId: row.id,
            event: "lifecycle_touchpoints_birthday_stamp_rollback_failed",
          },
          "lifecycle-touchpoints: birthday stamp rollback failed — patient may be permanently skipped this year",
        );
      }
      stats.birthdayFailed += 1;
      logger.error(
        {
          err,
          patientId: row.id,
        },
        "lifecycle-touchpoints: birthday send threw",
      );
    }
  }

  // ── ANNIVERSARY pass ────────────────────────────────────────────
  // The patient's "first therapy night" is MIN(night_date). PostgREST
  // can't express that aggregate, so the prior pass scanned up to
  // PER_KIND_MAX * 4 candidate patients and ran a per-candidate
  // earliest-night read (an N+1) just to discard the ~all whose
  // anniversary isn't today, then a per-candidate opt-in read on top.
  // The patients_with_therapy_anniversary RPC (mig 0232) pushes the MIN
  // plus the MM-DD / prior-year / not-yet-sent filters into Postgres and
  // returns only the (few) true matches — ordered by id for the same
  // deterministic-cohort reason, capped so a popular date can't burst
  // the SendGrid quota. Because the cap now bounds MATCHES rather than
  // candidates, a real anniversary can no longer be starved by
  // non-matching rows ahead of it. The opt-in gate for the match set is
  // then resolved in one batched read, same as the birthday pass.
  const { data: annData, error: annErr } = await supabase
    .schema("resupply")
    .rpc("patients_with_therapy_anniversary", {
      p_mmdd: mmdd,
      p_current_year: currentYear,
      p_limit: PER_KIND_MAX * 4,
    });
  if (annErr) throw annErr;
  const annRows = (annData ?? []) as Array<{
    patient_id: string;
    email: string;
    legal_first_name: string | null;
    first_night_date: string;
    sleep_anniversary_year_sent: number | null;
  }>;
  const annOptIn = await loadOptInStatuses(
    supabase,
    annRows.map((r) => r.email),
  );
  for (const row of annRows) {
    if (stats.anniversarySent >= PER_KIND_MAX) break;
    // The RPC already guarantees first_night MM-DD == today and year <
    // currentYear; recompute firstYear for the "years on therapy" copy
    // and keep the finite-year guard as defense-in-depth.
    const firstYear = Number(row.first_night_date.slice(0, 4));
    if (!Number.isFinite(firstYear) || firstYear >= currentYear) continue;

    stats.anniversaryCandidates += 1;
    const gate = annOptIn.get(row.email.toLowerCase()) ?? {
      optedIn: false,
      hadShopCustomer: false,
    };
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
      .eq("id", row.patient_id)
      .or(
        `sleep_anniversary_year_sent.is.null,sleep_anniversary_year_sent.neq.${currentYear}`,
      )
      .select("id");
    if (claimErr) {
      logger.warn(
        { err: claimErr.message, patientId: row.patient_id },
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
        const { error: rollbackErr } = await supabase
          .schema("resupply")
          .from("patients")
          .update({
            sleep_anniversary_year_sent: row.sleep_anniversary_year_sent,
          })
          .eq("id", row.patient_id);
        if (rollbackErr) {
          logger.error(
            {
              err: rollbackErr.message,
              patientId: row.patient_id,
              event: "lifecycle_touchpoints_anniversary_stamp_rollback_failed",
            },
            "lifecycle-touchpoints: anniversary stamp rollback failed — patient may be permanently skipped this year",
          );
        }
        stats.anniversaryFailed += 1;
        continue;
      }
      stats.anniversarySent += 1;
    } catch (err) {
      const { error: rollbackErr } = await supabase
        .schema("resupply")
        .from("patients")
        .update({
          sleep_anniversary_year_sent: row.sleep_anniversary_year_sent,
        })
        .eq("id", row.patient_id);
      if (rollbackErr) {
        logger.error(
          {
            err: rollbackErr.message,
            patientId: row.patient_id,
            event: "lifecycle_touchpoints_anniversary_stamp_rollback_failed",
          },
          "lifecycle-touchpoints: anniversary stamp rollback failed — patient may be permanently skipped this year",
        );
      }
      stats.anniversaryFailed += 1;
      logger.error(
        {
          err,
          patientId: row.patient_id,
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
  await createQueueWithDlq(boss, JOB_NAME, VENDOR_SEND_QUEUE_OPTS);
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
