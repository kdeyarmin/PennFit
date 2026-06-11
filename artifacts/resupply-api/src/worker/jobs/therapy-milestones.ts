// pg-boss job: daily therapy-milestone evaluator + sender.
//
// Why this exists
// ---------------
// patient_therapy_nights is rich (nightly usage, AHI, leak, hours)
// but is only used by the smart-trigger engine for REORDER signals.
// Nothing watches it for ENGAGEMENT signals — and those signals are
// the ones with the highest open + click rates in DME adherence
// coaching:
//
//   1. The 100th-night anniversary.
//   2. The 365th-night anniversary.
//   3. The first rolling 30-night window where the patient crosses
//      the Medicare adherence target (>=70% of nights >=4hr).
//
// Patients who get celebrated stay on therapy longer. The cost is
// one table + one daily worker.
//
// Idempotency model
// -----------------
// resupply.patient_therapy_milestones has a UNIQUE (patient_id,
// milestone_kind). The worker does:
//
//   1. Evaluate: for each patient with night-data activity in the
//      last 60 days, compute the three milestones from
//      patient_therapy_nights and INSERT any that aren't already
//      recorded. The unique constraint backstops races.
//   2. Send:    for any milestone row where notified_at IS NULL,
//      send the celebration email and stamp notified_at.
//
// Crashing between evaluate and send is safe: the next run picks the
// row up from the partial index. Crashing after the SendGrid call
// but before the stamp would re-send on the next run — accepted
// trade because adherence celebrations are inherently rare events
// (one per patient per milestone-kind, ever) and a second copy is
// only mildly embarrassing, not damaging.
//
// Schedule
// --------
// 04:53 UTC daily — paired with the therapy nightly sync (04:30 UTC)
// so we evaluate against fresh nightly data. Far enough from
// rx-renewal-send (04:43) to avoid SendGrid rate-limit overlap.

import type PgBoss from "pg-boss";

import {
  getSupabaseServiceRoleClient,
  type Database,
  type Json,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";
import {
  sendTherapyMilestoneEmail,
  type MilestoneKind,
} from "../../lib/order-emails/send-therapy-milestone-email";

type MilestoneInsert =
  Database["resupply"]["Tables"]["patient_therapy_milestones"]["Insert"];

const JOB_NAME = "therapy-milestones.run";
const JOB_CRON = "53 4 * * *";

/** Medicare LCD adherence threshold (4 hours = 240 minutes). */
const ADHERENCE_THRESHOLD_MINUTES = 240;
/** Medicare LCD adherence threshold (70% of the rolling window). */
const ADHERENCE_PCT_THRESHOLD = 0.7;
/** Window length for the first-adherence-month milestone. */
const ADHERENCE_WINDOW_NIGHTS = 30;

/** Only consider patients whose therapy nights changed recently. */
const ACTIVITY_LOOKBACK_DAYS = 60;

/** Every milestone kind detectMilestones can emit. A patient who already
 *  holds a row for all of these has nothing left to earn this run, so the
 *  evaluate loop can skip their night read entirely (watermark). */
const ALL_MILESTONE_KINDS: readonly MilestoneKind[] = [
  "100_nights",
  "365_nights",
  "first_adherence_month",
];

export interface MilestoneStats {
  patientsScanned: number;
  inserted: Record<MilestoneKind, number>;
  sent: number;
  sendSkipped: number;
  sendFailed: number;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

interface NightRow {
  night_date: string;
  usage_minutes: number | null;
}

/**
 * Collapse multi-source duplicates to one entry per night_date,
 * keeping the entry with the most recorded usage. patient_therapy_nights
 * is keyed PER SOURCE — a patient synced from two therapy clouds has
 * two rows per real night, so raw row counts would reach "100 nights"
 * at 50 real nights and feed duplicate dates into the rolling
 * adherence window.
 */
export function dedupeNightsByDate(nights: NightRow[]): NightRow[] {
  const byDate = new Map<string, NightRow>();
  for (const n of nights) {
    const prev = byDate.get(n.night_date);
    if (!prev || (n.usage_minutes ?? -1) > (prev.usage_minutes ?? -1)) {
      byDate.set(n.night_date, n);
    }
  }
  return [...byDate.values()];
}

/**
 * Detect any milestones the patient has just hit but doesn't yet
 * have a row for. Pure function — easy to unit test against a
 * synthetic night array. Counts DISTINCT night dates (see
 * dedupeNightsByDate).
 */
export function detectMilestones(
  nights: NightRow[],
  existingKinds: Set<MilestoneKind>,
): Array<{
  kind: MilestoneKind;
  achievedOn: string;
  metricSnapshot: Record<string, unknown>;
}> {
  if (nights.length === 0) return [];

  // Date-sort ascending so cumulative checks are O(n).
  const sorted = dedupeNightsByDate(nights).sort((a, b) =>
    a.night_date.localeCompare(b.night_date),
  );

  const out: Array<{
    kind: MilestoneKind;
    achievedOn: string;
    metricSnapshot: Record<string, unknown>;
  }> = [];

  // 1. 100 nights
  if (!existingKinds.has("100_nights") && sorted.length >= 100) {
    out.push({
      kind: "100_nights",
      achievedOn: sorted[99]!.night_date,
      metricSnapshot: { totalNights: 100 },
    });
  }

  // 2. 365 nights
  if (!existingKinds.has("365_nights") && sorted.length >= 365) {
    out.push({
      kind: "365_nights",
      achievedOn: sorted[364]!.night_date,
      metricSnapshot: { totalNights: 365 },
    });
  }

  // 3. First 30-night rolling window with >= 70% adherence
  if (
    !existingKinds.has("first_adherence_month") &&
    sorted.length >= ADHERENCE_WINDOW_NIGHTS
  ) {
    // Pre-mark each night as compliant or not, then slide the window.
    // We only count nights where usage_minutes is recorded — nights
    // missing data are excluded from both numerator and denominator.
    for (let end = ADHERENCE_WINDOW_NIGHTS - 1; end < sorted.length; end++) {
      const window = sorted.slice(end - ADHERENCE_WINDOW_NIGHTS + 1, end + 1);
      let recorded = 0;
      let compliant = 0;
      for (const n of window) {
        if (n.usage_minutes == null) continue;
        recorded += 1;
        if (n.usage_minutes >= ADHERENCE_THRESHOLD_MINUTES) compliant += 1;
      }
      // Need at least 20 recorded nights in the window so a single
      // sleepy week of data can't false-positive a milestone.
      if (recorded < 20) continue;
      const pct = compliant / recorded;
      if (pct >= ADHERENCE_PCT_THRESHOLD) {
        out.push({
          kind: "first_adherence_month",
          achievedOn: window[window.length - 1]!.night_date,
          metricSnapshot: {
            adherencePct: Math.round(pct * 100),
            recordedNights: recorded,
            compliantNights: compliant,
          },
        });
        break;
      }
    }
  }

  return out;
}

/**
 * Evaluate patient therapy night histories to create any newly reached milestones and notify patients for milestones that have not yet been sent.
 *
 * This performs two phases: (1) scans recently active patients' nightly records and inserts missing milestone rows, and (2) claims pending milestone rows, sends celebration emails (and best-effort push notifications), and updates per-milestone notification state. Errors affecting individual patients or notifications are handled per-row so the overall run continues.
 *
 * @returns MilestoneStats containing counts for the run: `patientsScanned`, per-kind `inserted` totals, `sent`, `sendSkipped`, and `sendFailed`.
 */
export async function runTherapyMilestones(): Promise<MilestoneStats> {
  const supabase = getSupabaseServiceRoleClient();
  const stats: MilestoneStats = {
    patientsScanned: 0,
    inserted: { "100_nights": 0, "365_nights": 0, first_adherence_month: 0 },
    sent: 0,
    sendSkipped: 0,
    sendFailed: 0,
  };

  // ── EVALUATE ────────────────────────────────────────────────────
  // Find patients with night-data activity in the last N days. Anyone
  // who didn't sync in 60 days couldn't have produced a new
  // milestone, so we save the scan cost. (Existing milestone rows
  // for old patients are still picked up in the SEND step below.)
  //
  // We use a raw SQL query via RPC or a separate aggregation to get
  // distinct patient_id values server-side rather than fetching rows
  // and deduplicating client-side. Since PostgREST doesn't have a
  // direct .distinct() on select, we work around by grouping in a
  // subquery. For now, we keep the client-side dedup but note that
  // a better approach would be to use a PostgreSQL function or view.
  const activitySince = isoDaysAgo(ACTIVITY_LOOKBACK_DAYS);
  // Page the roster. patient_therapy_nights has one row per patient per
  // night (per source), so an active patient owns many rows; an
  // unpaginated select hits PostgREST's ~1000-row cap after only ~16
  // distinct patients and silently skips everyone else. Page on a
  // stable order and de-dupe patient_ids across pages (mirrors the
  // keyset paging in lib/smart-triggers/evaluator.ts).
  const PAGE_SIZE = 1000;
  const patientIdSet = new Set<string>();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: page, error: actErr } = await supabase
      .schema("resupply")
      .from("patient_therapy_nights")
      .select("patient_id")
      .gte("updated_at", `${activitySince}T00:00:00.000Z`)
      .order("patient_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (actErr) throw actErr;
    if (!page || page.length === 0) break;
    for (const r of page) {
      if (r.patient_id) patientIdSet.add(r.patient_id);
    }
    if (page.length < PAGE_SIZE) break;
  }

  const uniquePatientIds = Array.from(patientIdSet);
  stats.patientsScanned = uniquePatientIds.length;

  // Batch the existing-milestone lookup instead of one query per patient.
  // The prior per-patient `.eq("patient_id", …)` read was an N+1 that grew
  // with the active roster — one serial round-trip per candidate, every
  // night. Fetch the recorded milestone kinds for the whole candidate set
  // up front, chunked at 200 patient_ids so the URL stays under PostgREST's
  // length limit and each chunk returns at most 200 × 3 kinds = 600 rows
  // (well under the ~1000-row response cap).
  const existingByPatient = new Map<string, Set<MilestoneKind>>();
  for (let i = 0; i < uniquePatientIds.length; i += 200) {
    const idChunk = uniquePatientIds.slice(i, i + 200);
    const { data: existingRows, error: existingErr } = await supabase
      .schema("resupply")
      .from("patient_therapy_milestones")
      .select("patient_id, milestone_kind")
      .in("patient_id", idChunk);
    if (existingErr) throw existingErr;
    for (const r of existingRows ?? []) {
      if (!r.patient_id) continue;
      let set = existingByPatient.get(r.patient_id);
      if (!set) {
        set = new Set<MilestoneKind>();
        existingByPatient.set(r.patient_id, set);
      }
      set.add(r.milestone_kind as MilestoneKind);
    }
  }

  for (const patientId of uniquePatientIds) {
    const existingKinds =
      existingByPatient.get(patientId) ?? new Set<MilestoneKind>();
    // Watermark: a patient who already holds all three milestone kinds
    // can't earn a new one, so skip the night read entirely. On a mature
    // roster this is the vast majority of candidates (milestones are
    // once-per-patient-ever events), which is what turns the remaining
    // per-patient night read from "every active patient" into "only
    // patients still missing a milestone".
    if (ALL_MILESTONE_KINDS.every((k) => existingKinds.has(k))) continue;

    // Pull the patient's night history from the start (sorted
    // ascending) until we hold enough DISTINCT night dates for the
    // count milestones, paging in bounded chunks. A single raw
    // `.limit(400)` read was NOT enough: patient_therapy_nights is
    // keyed per source, so a patient synced from two clouds yields two
    // rows per real night — the first 400 raw rows collapse to ~200
    // distinct dates, the watermark re-reads the same first slice
    // forever, and `365_nights` becomes unreachable (the supplemental
    // recent-window pass below deliberately masks count milestones,
    // so it can't rescue them). Offset paging on a deterministic
    // (night_date, id) order is safe here — the table is append-only
    // per (patient, source, date) during the scan.
    //
    // The first-distinct-400 view is correct for the COUNT milestones
    // (their achievedOn is the patient's literal 100th/365th night),
    // but NOT for first_adherence_month: adherence is a rolling ≥70%
    // ratio, so a patient who was sub-70% through their first 400
    // nights and later improved would never earn it from this view.
    // The supplemental latest-window read below covers that case.
    const DISTINCT_TARGET = 400;
    const NIGHT_PAGE = 400;
    // 8 pages = 3200 raw rows ≈ 8 sources × 400 nights before the
    // bound truncates — far past any realistic source fan-out.
    const MAX_NIGHT_PAGES = 8;
    const nightsByDate = new Map<string, NightRow>();
    let exhaustedHistory = false;
    let nightReadFailed = false;
    for (let page = 0; page < MAX_NIGHT_PAGES; page++) {
      const { data: rows, error: nightsErr } = await supabase
        .schema("resupply")
        .from("patient_therapy_nights")
        .select("night_date, usage_minutes")
        .eq("patient_id", patientId)
        .order("night_date", { ascending: true })
        .order("id", { ascending: true })
        .range(page * NIGHT_PAGE, page * NIGHT_PAGE + NIGHT_PAGE - 1);
      if (nightsErr) {
        logger.warn(
          { err: nightsErr.message, patientId },
          "therapy-milestones: night read failed",
        );
        nightReadFailed = true;
        break;
      }
      for (const n of rows ?? []) {
        const prev = nightsByDate.get(n.night_date);
        if (!prev || (n.usage_minutes ?? -1) > (prev.usage_minutes ?? -1)) {
          nightsByDate.set(n.night_date, n);
        }
      }
      if (!rows || rows.length < NIGHT_PAGE) {
        exhaustedHistory = true;
        break;
      }
      if (nightsByDate.size >= DISTINCT_TARGET) break;
    }
    if (nightReadFailed) continue;
    const nights = [...nightsByDate.values()];
    let detected = detectMilestones(nights, existingKinds);

    // Supplemental adherence pass over the LATEST window when the
    // from-the-start view was truncated (distinct target or page bound
    // hit before history ran out) and adherence is still unearned —
    // see the read comment above.
    if (
      !exhaustedHistory &&
      !existingKinds.has("first_adherence_month") &&
      !detected.some((m) => m.kind === "first_adherence_month")
    ) {
      const { data: recentNights, error: recentErr } = await supabase
        .schema("resupply")
        .from("patient_therapy_nights")
        .select("night_date, usage_minutes")
        .eq("patient_id", patientId)
        .order("night_date", { ascending: false })
        .limit(120);
      if (recentErr) {
        logger.warn(
          { err: recentErr.message, patientId },
          "therapy-milestones: recent-night read failed",
        );
      } else {
        const adherenceOnly = detectMilestones(
          (recentNights ?? []).reverse(),
          // Mask the count milestones: this window is the latest slice,
          // so positional 100th/365th detection would be wrong here.
          new Set<MilestoneKind>([
            ...existingKinds,
            "100_nights",
            "365_nights",
          ]),
        );
        detected = detected.concat(
          adherenceOnly.filter((m) => m.kind === "first_adherence_month"),
        );
      }
    }

    for (const m of detected) {
      const insertRow: MilestoneInsert = {
        patient_id: patientId,
        milestone_kind: m.kind,
        achieved_on: m.achievedOn,
        // Json is a recursive type; the snapshot is plain key/number
        // and round-trips losslessly. Cast keeps the row literal
        // typed without dragging Json through detectMilestones.
        metric_snapshot: m.metricSnapshot as Json,
      };
      const { error: insErr } = await supabase
        .schema("resupply")
        .from("patient_therapy_milestones")
        .insert(insertRow);
      if (insErr) {
        // Likely a race — partner cron tick or unique-violation. Either way
        // not actionable here; the existing row will get sent below.
        logger.info(
          {
            patientId,
            kind: m.kind,
            err: insErr.message,
          },
          "therapy-milestones: insert skipped (likely already exists)",
        );
        continue;
      }
      stats.inserted[m.kind] += 1;
    }
  }

  // ── SEND ────────────────────────────────────────────────────────
  // Send any milestone rows still waiting for notification, across
  // all patients (not just those active in the last 60 days — a
  // newly-inserted milestone on an inactive patient still deserves
  // the celebration).
  const { data: pending, error: pendErr } = await supabase
    .schema("resupply")
    .from("patient_therapy_milestones")
    .select("id, patient_id, milestone_kind, metric_snapshot")
    .is("notified_at", null)
    .limit(500);
  if (pendErr) throw pendErr;

  // Batch-resolve recipient email + first name for every pending
  // milestone up front (one query per 200 patients) instead of a
  // per-row lookup inside the send loop.
  const pendingRows = pending ?? [];
  const pendingPatientIds = [
    ...new Set(pendingRows.map((r) => r.patient_id).filter(Boolean)),
  ];
  const patientById = new Map<
    string,
    { email: string | null; legal_first_name: string | null }
  >();
  const PATIENT_CHUNK = 200;
  for (let i = 0; i < pendingPatientIds.length; i += PATIENT_CHUNK) {
    const chunk = pendingPatientIds.slice(i, i + PATIENT_CHUNK);
    const { data: patientRows, error: patientsErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id, email, legal_first_name")
      .in("id", chunk);
    if (patientsErr) {
      logger.error(
        { err: patientsErr.message, patientCount: chunk.length },
        "therapy-milestones: batch patient lookup failed",
      );
      continue;
    }
    for (const p of patientRows ?? []) {
      patientById.set(p.id, {
        email: p.email,
        legal_first_name: p.legal_first_name,
      });
    }
  }

  for (const row of pendingRows) {
    // Claim the row first (atomic stamp). Wins iff still null.
    const claimIso = new Date().toISOString();
    const { data: claimed, error: claimErr } = await supabase
      .schema("resupply")
      .from("patient_therapy_milestones")
      .update({
        notified_at: claimIso,
        notification_channel: "email",
      })
      .eq("id", row.id)
      .is("notified_at", null)
      .select("id, patient_id, milestone_kind, metric_snapshot")
      .limit(1)
      .maybeSingle();
    if (claimErr) {
      logger.warn(
        { err: claimErr.message, milestoneId: row.id },
        "therapy-milestones: claim failed",
      );
      stats.sendFailed += 1;
      continue;
    }
    if (!claimed) {
      // Lost the race to a parallel run.
      stats.sendSkipped += 1;
      continue;
    }

    const releaseClaim = async (): Promise<void> => {
      const { error: releaseErr } = await supabase
        .schema("resupply")
        .from("patient_therapy_milestones")
        .update({ notified_at: null, notification_channel: null })
        .eq("id", claimed.id);
      if (releaseErr) {
        logger.error(
          { err: releaseErr.message, milestoneId: claimed.id },
          "therapy-milestones: releaseClaim failed — milestone may remain claimed",
        );
      }
    };

    // Recipient email + first name, resolved from the batch lookup above.
    let patient = patientById.get(claimed.patient_id) ?? null;
    if (!patient) {
      const { data: fallbackPatient, error: patientError } = await supabase
        .schema("resupply")
        .from("patients")
        .select("email, legal_first_name")
        .eq("id", claimed.patient_id)
        .limit(1)
        .maybeSingle();
      if (patientError) {
        await releaseClaim();
        stats.sendFailed += 1;
        logger.error(
          {
            err: patientError.message,
            milestoneId: claimed.id,
            patientId: claimed.patient_id,
          },
          "therapy-milestones: patient lookup failed",
        );
        continue;
      }
      patient = fallbackPatient
        ? {
            email: fallbackPatient.email,
            legal_first_name: fallbackPatient.legal_first_name,
          }
        : null;
      if (patient) {
        patientById.set(claimed.patient_id, patient);
      }
    }
    if (!patient || !patient.email) {
      // No deliverable — leave the stamp so we don't retry every day.
      stats.sendSkipped += 1;
      continue;
    }

    const metrics =
      (claimed.metric_snapshot as Record<string, unknown> | null) ?? {};
    const totalNights =
      typeof metrics.totalNights === "number" ? metrics.totalNights : undefined;
    const adherencePct =
      typeof metrics.adherencePct === "number"
        ? metrics.adherencePct
        : undefined;

    try {
      const result = await sendTherapyMilestoneEmail({
        toEmail: patient.email,
        firstName: patient.legal_first_name,
        kind: claimed.milestone_kind as MilestoneKind,
        metrics: { totalNights, adherencePct },
      });
      if (!result.configured) {
        await releaseClaim();
        stats.sendSkipped += 1;
        continue;
      }
      if (!result.delivered) {
        await releaseClaim();
        stats.sendFailed += 1;
        logger.warn(
          {
            milestoneId: claimed.id,
            kind: claimed.milestone_kind,
            error: result.error,
          },
          "therapy-milestones: send failed (claim released)",
        );
        continue;
      }
      stats.sent += 1;

      // Best-effort push fan-out — same news, separate channel.
      // Runs AFTER the email so a push misconfig (or a customer
      // with no shop_customers row, hence no push subscriptions)
      // never rolls back the email delivery state. Logged at INFO
      // for ops visibility on push activation; counts only.
      try {
        const { sendPushToCustomerByEmail } =
          await import("../../lib/web-push");
        const title =
          claimed.milestone_kind === "100_nights"
            ? "100 nights on therapy — congrats!"
            : claimed.milestone_kind === "365_nights"
              ? "One year of CPAP therapy"
              : "Adherence target reached";
        await sendPushToCustomerByEmail(patient.email, {
          title,
          body: "Tap to see your therapy summary.",
          url: "/account#therapy",
          tag: `therapy_milestone:${claimed.id}`,
        });
      } catch (pushErr) {
        logger.info(
          {
            milestoneId: claimed.id,
            err: pushErr instanceof Error ? pushErr.message : String(pushErr),
          },
          "therapy-milestones: push fanout skipped (non-fatal)",
        );
      }
    } catch (err) {
      await releaseClaim();
      stats.sendFailed += 1;
      logger.error(
        {
          err,
          milestoneId: claimed.id,
        },
        "therapy-milestones: send threw (claim released)",
      );
    }
  }

  return stats;
}

export async function registerTherapyMilestonesJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(boss, JOB_NAME, VENDOR_SEND_QUEUE_OPTS);

  await boss.work(JOB_NAME, async () => {
    try {
      const stats = await runTherapyMilestones();
      logger.info(
        { event: "therapy-milestones.completed", ...stats },
        "therapy-milestones: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "therapy-milestones: failed",
      );
      throw err;
    }
  });

  await boss.schedule(JOB_NAME, JOB_CRON);
  logger.info({ cron: JOB_CRON }, "therapy-milestones scheduled");
}
