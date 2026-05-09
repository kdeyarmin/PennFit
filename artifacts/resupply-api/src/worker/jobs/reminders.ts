// pg-boss jobs: scheduled reminder scan + per-patient send.
//
// Schedule
// --------
// `reminders.scan` runs hourly (cron). The handler walks every active
// patient that has at least one prescription overdue per its
// `cadenceDays` setting and enqueues either `reminders.send-sms` or
// `reminders.send-email` (one channel per patient per scan — see
// channel selection below).
//
// Quiet-period suppression
// ------------------------
// We skip a patient/episode pair if a `conversations` row was opened
// in the last 48 hours for it. This prevents the hourly scan from
// double-pinging a patient who just received a reminder (whether from
// the previous scan or from an admin's manual send). The threshold
// is hard-coded; patient-controlled DND lives in a separate ADR.
//
// Channel + cadence selection (v2)
// --------------------------------
// Both the cadence (when does this patient become due?) and the
// outbound channel (sms / email / voice) come from
// `resolveOutreachPlan` in @workspace/resupply-domain. The resolution
// order is:
//   1. Per-patient override (`patients.cadence_override_days` /
//      `patients.channel_preference`).
//   2. First active rule from `frequency_rules` (by priority asc,
//      created_at asc) whose SKU prefix / payer / tenure window all
//      match.
//   3. Fall back to `prescriptions.cadence_days` and the legacy
//      SMS-then-email channel selection.
//
// Voice handling: the worker has no fire-and-forget voice channel
// (Twilio outbound voice in this app is initiated interactively from
// the admin console, not from a cron). If a rule or override
// resolves channel to "voice", the worker downgrades to SMS (if the
// patient has a phone) or email — and warns. Admins who want
// voice-only outreach should keep the `channel_preference` set to
// `voice` so the dashboard surfaces the patient for a manual call;
// the cron just won't auto-ping them.
//
// SQL pre-filter loosening:
// -------------------------
// The previous implementation filtered "due" in SQL using
// `prescriptions.cadence_days`. With overrides + rules a patient may
// be due SOONER than the prescription-level cadence, so the SQL filter
// would silently miss them. We now pre-filter only on the cheap
// predicates (active patient, active prescription, no recent
// conversation) and apply the cadence math in TypeScript after
// resolving each patient's effective plan. The expected candidate
// set per scan is small (low thousands of patients, far fewer
// active rows), so the extra TS work is dwarfed by the round-trip
// cost.
//
// Episode resolution
// ------------------
// The eligibility query selects the OVERDUE PRESCRIPTION; the send
// helper resolves the episode internally (most-recent for the
// patient). For patients with multiple overdue scripts the scan
// enqueues one send per script, deduped by patient_id within the
// scan window — admins get one ping per patient per cycle, not one
// per SKU.

import type PgBoss from "pg-boss";

import {
  resolveOutreachPlan,
  type OutreachChannel,
  type OutreachPatient,
  type OutreachPrescription,
  type OutreachRule,
} from "@workspace/resupply-domain";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  sendReminderEmail,
  sendReminderSms,
  type SendActor,
} from "@workspace/resupply-reminders";
import { hasLinkHmacKey } from "@workspace/resupply-secrets";

import { logger } from "../../lib/logger.js";

export const SCAN_JOB = "reminders.scan";
export const SEND_SMS_JOB = "reminders.send-sms";
export const SEND_EMAIL_JOB = "reminders.send-email";

/**
 * Quiet-period: do not enqueue a reminder for a patient/episode that
 * already had a conversation opened within the last N ms.
 */
const QUIET_PERIOD_MS = 48 * 60 * 60 * 1000;

export interface ScanJobData {
  /** Optional ISO timestamp the scan should treat as "now" — used by
   * tests to make the eligibility query deterministic. Production runs
   * leave this absent and the handler uses Date.now(). */
  asOfIso?: string;
}

export interface SendJobData {
  patientId: string;
  episodeId: string;
}

interface ScanRow {
  patientId: string;
  episodeId: string;
  /** The channel the worker will actually use. The eligibility plan
   *  may resolve to "voice", but the worker downgrades that to sms or
   *  email — only those two are valid at the queue boundary. */
  channel: "sms" | "email";
}

/**
 * Whole-day age between two instants. Mirrors the math
 * `resolveOutreachPlan` uses for tenure so the eligibility decision
 * here lines up with what the dashboard previews.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
function daysBetween(earlier: Date, later: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / DAY_MS);
}

/**
 * Read the messaging config off env at call time. The worker does not
 * import the API's messaging-config module (that lib lives inside
 * artifacts/resupply-api/), so we duplicate the env-presence check
 * here. Keep this in sync with `lib/messaging/messaging-config.ts`.
 */
function readWorkerMessagingConfig(env: NodeJS.ProcessEnv = process.env): {
  sms: {
    twilioAccountSid: string;
    twilioAuthToken: string;
    twilioPhoneNumber?: string;
    twilioMessagingServiceSid?: string;
    publicBaseUrl: string;
    practiceName: string;
  } | null;
  email: {
    sendgridApiKey: string;
    sendgridFromEmail: string;
    sendgridFromName: string;
    publicBaseUrl: string;
    practiceName: string;
  } | null;
  hmacKeysReady: boolean;
} {
  const practiceName = env.RESUPPLY_PRACTICE_NAME ?? "PennPaps";
  const publicBaseUrl = stripTrailingSlash(
    env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
      (env.REPLIT_DEV_DOMAIN ? `https://${env.REPLIT_DEV_DOMAIN}` : ""),
  );
  // RESUPPLY_LINK_HMAC_KEY is needed for signed email-action links
  // (confirm/edit/stop). It's the only HMAC key the program still
  // uses; the phone-number HMAC was deleted along with the
  // pgcrypto encryption layer (PHI is now stored as plaintext).
  // Pass the (potentially test-supplied) `env` through so the
  // worker's hermetic preflight tests stay independent of the
  // process's real env.
  const hmacKeysReady = hasLinkHmacKey(env);

  let sms: ReturnType<typeof readWorkerMessagingConfig>["sms"] = null;
  if (
    env.TWILIO_ACCOUNT_SID &&
    env.TWILIO_AUTH_TOKEN &&
    (env.TWILIO_PHONE_NUMBER || env.TWILIO_MESSAGING_SERVICE_SID) &&
    publicBaseUrl
  ) {
    sms = {
      twilioAccountSid: env.TWILIO_ACCOUNT_SID,
      twilioAuthToken: env.TWILIO_AUTH_TOKEN,
      twilioPhoneNumber: env.TWILIO_PHONE_NUMBER,
      twilioMessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
      publicBaseUrl,
      practiceName,
    };
  }

  let email: ReturnType<typeof readWorkerMessagingConfig>["email"] = null;
  if (
    env.SENDGRID_API_KEY &&
    env.SENDGRID_FROM_EMAIL &&
    env.SENDGRID_FROM_NAME &&
    publicBaseUrl
  ) {
    email = {
      sendgridApiKey: env.SENDGRID_API_KEY,
      sendgridFromEmail: env.SENDGRID_FROM_EMAIL,
      sendgridFromName: env.SENDGRID_FROM_NAME,
      publicBaseUrl,
      practiceName,
    };
  }

  return { sms, email, hmacKeysReady };
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Test seam — exposes the pure env-presence preflight to the unit
 * test suite without forcing it through pg-boss. The function is
 * only ever called from `registerReminderJobs` at runtime, so the
 * extra surface area here is test-only.
 */
export const __testing = {
  readWorkerMessagingConfigForTest: readWorkerMessagingConfig,
};

/**
 * SQL: select patient/prescription pairs that are due for a reminder.
 *
 * "Due" = the most recent fulfillment for the (patient, item_sku)
 * pair is older than `cadenceDays`, OR there is no fulfillment yet
 * and the prescription is at least `cadenceDays` old.
 *
 * Skips: paused/closed patients; expired/revoked prescriptions; pairs
 * with a conversation opened in the last QUIET_PERIOD_MS for the
 * candidate episode.
 *
 * Returns one row per (patient, episode, channel) — channel is
 * computed in TypeScript after we read phone/email so the cadence
 * resolution can layer per-patient overrides on top of the SKU-level
 * SQL filter.
 */
export async function scanForDueReminders(
  asOf: Date = new Date(),
): Promise<ScanRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  const quietCutoff = new Date(asOf.getTime() - QUIET_PERIOD_MS);
  const quietCutoffIso = quietCutoff.toISOString();

  // Step 1: load every active rule once. Rules are tiny (admin-
  // managed; expected count is in the tens) so we keep the whole list
  // in memory for the duration of the scan and let `resolveOutreachPlan`
  // pick the right one per patient.
  const { data: ruleRows, error: rulesErr } = await supabase
    .schema("resupply")
    .from("frequency_rules")
    .select(
      "id, priority, created_at, active, match_item_sku_prefix, match_insurance_payer, min_tenure_days, max_tenure_days, cadence_days, default_channel",
    )
    .eq("active", true)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });
  if (rulesErr) throw rulesErr;
  const rules: OutreachRule[] = (ruleRows ?? []).map((r) => ({
    id: r.id,
    priority: r.priority,
    createdAt: new Date(r.created_at),
    active: r.active,
    matchItemSkuPrefix: r.match_item_sku_prefix,
    matchInsurancePayer: r.match_insurance_payer,
    minTenureDays: r.min_tenure_days,
    maxTenureDays: r.max_tenure_days,
    cadenceDays: r.cadence_days,
    defaultChannel: r.default_channel as OutreachChannel | null,
  }));

  // Step 2: PostgREST has no JOIN, so we fetch the three core tables
  // in parallel and stitch them in JS. Cadence resolution happens
  // after the join so per-patient overrides and rules can SHORTEN the
  // cadence below `prescriptions.cadence_days`.
  //
  // The original SQL capped the JOIN result at 1000 ordered by
  // `episodes.due_at DESC`. We replicate that ordering by sorting
  // the joined rows in JS before truncating to 1000.
  const [activePrescRes, episodesRes] = await Promise.all([
    supabase
      .schema("resupply")
      .from("prescriptions")
      .select("id, patient_id, item_sku, cadence_days, created_at")
      .eq("status", "active"),
    // Fetch every episode's (id, prescription_id, due_at) — we filter
    // to only those whose prescription is active in JS. Episodes per
    // active patient are small; the table is naturally bounded.
    supabase
      .schema("resupply")
      .from("episodes")
      .select("id, prescription_id, due_at"),
  ]);
  if (activePrescRes.error) throw activePrescRes.error;
  if (episodesRes.error) throw episodesRes.error;

  const prescriptionsList = activePrescRes.data ?? [];
  if (prescriptionsList.length === 0) return [];

  const prescriptionById = new Map(prescriptionsList.map((p) => [p.id, p]));
  const patientIdsSet = new Set(prescriptionsList.map((p) => p.patient_id));
  const itemSkuByPrescriptionId = new Map(
    prescriptionsList.map((p) => [p.id, p.item_sku]),
  );

  // Filter episodes to only those tied to active prescriptions.
  const allEpisodes = (episodesRes.data ?? []).filter((e) =>
    prescriptionById.has(e.prescription_id),
  );

  // Step 3: load patients (active only) for the set of patient_ids we
  // saw on active prescriptions. Chunk the .in() query — PostgREST
  // limits URL length; the encoded list of UUIDs is ~36 bytes each, so
  // we batch 200 at a time.
  const patientIds = Array.from(patientIdsSet);
  const patientById = new Map<
    string,
    {
      id: string;
      created_at: string;
      insurance_payer: string | null;
      cadence_override_days: number | null;
      channel_preference: string | null;
      phone_e164: string | null;
      email: string | null;
    }
  >();
  for (let i = 0; i < patientIds.length; i += 200) {
    const batch = patientIds.slice(i, i + 200);
    const { data, error } = await supabase
      .schema("resupply")
      .from("patients")
      .select(
        "id, created_at, insurance_payer, cadence_override_days, channel_preference, phone_e164, email",
      )
      .eq("status", "active")
      .in("id", batch);
    if (error) throw error;
    for (const row of data ?? []) patientById.set(row.id, row);
  }

  // Step 4: lastFulfilledAt is MAX(shipped_at) per (patient, item_sku).
  // PostgREST has no GROUP BY, so we fetch all fulfillment shipped
  // rows for the patients of interest and reduce in JS.
  const lastFulfilledByKey = new Map<string, string>();
  const activePatientIds = Array.from(patientById.keys());
  for (let i = 0; i < activePatientIds.length; i += 200) {
    const batch = activePatientIds.slice(i, i + 200);
    const { data, error } = await supabase
      .schema("resupply")
      .from("fulfillments")
      .select("patient_id, item_sku, shipped_at")
      .in("patient_id", batch)
      .not("shipped_at", "is", null);
    if (error) throw error;
    for (const row of data ?? []) {
      if (!row.shipped_at) continue;
      const key = `${row.patient_id}\x00${row.item_sku}`;
      const prev = lastFulfilledByKey.get(key);
      if (!prev || row.shipped_at > prev) {
        lastFulfilledByKey.set(key, row.shipped_at);
      }
    }
  }

  // Step 5: quiet-period — episodes that had a conversation with
  // last_message_at >= quietCutoff. Pull those conversation rows and
  // build an episode_id set to subtract.
  const recentConvRes = await supabase
    .schema("resupply")
    .from("conversations")
    .select("episode_id")
    .gte("last_message_at", quietCutoffIso)
    .not("episode_id", "is", null);
  if (recentConvRes.error) throw recentConvRes.error;
  const quietEpisodeIds = new Set<string>();
  for (const row of recentConvRes.data ?? []) {
    if (row.episode_id) quietEpisodeIds.add(row.episode_id);
  }

  // Step 6: stitch the candidate (patient, prescription, episode)
  // tuples in JS, drop quiet-period hits, sort by episode.due_at desc,
  // and cap at 1000 — same shape the original SQL produced.
  interface Candidate {
    patientId: string;
    patientCreatedAt: string;
    insurancePayer: string | null;
    cadenceOverrideDays: number | null;
    channelPreference: string | null;
    phone: string | null;
    email: string | null;
    prescriptionItemSku: string;
    prescriptionCadenceDays: number;
    prescriptionCreatedAt: string;
    episodeId: string;
    episodeDueAt: string;
    lastFulfilledAt: string | null;
  }
  const candidates: Candidate[] = [];
  for (const ep of allEpisodes) {
    if (quietEpisodeIds.has(ep.id)) continue;
    const presc = prescriptionById.get(ep.prescription_id);
    if (!presc) continue;
    const patient = patientById.get(presc.patient_id);
    if (!patient) continue;
    const itemSku = itemSkuByPrescriptionId.get(presc.id)!;
    candidates.push({
      patientId: patient.id,
      patientCreatedAt: patient.created_at,
      insurancePayer: patient.insurance_payer,
      cadenceOverrideDays: patient.cadence_override_days,
      channelPreference: patient.channel_preference,
      phone: patient.phone_e164,
      email: patient.email,
      prescriptionItemSku: presc.item_sku,
      prescriptionCadenceDays: presc.cadence_days,
      prescriptionCreatedAt: presc.created_at,
      episodeId: ep.id,
      episodeDueAt: ep.due_at,
      lastFulfilledAt:
        lastFulfilledByKey.get(`${patient.id}\x00${itemSku}`) ?? null,
    });
  }
  // due_at desc — same as the SQL order.
  candidates.sort((a, b) => (a.episodeDueAt < b.episodeDueAt ? 1 : -1));
  const candidateRows = candidates.slice(0, 1000);

  // Step 7: per-row eligibility + channel resolution.
  const seenPatient = new Set<string>();
  const out: ScanRow[] = [];
  for (const row of candidateRows) {
    if (seenPatient.has(row.patientId)) continue;

    const patient: OutreachPatient = {
      id: row.patientId,
      createdAt: new Date(row.patientCreatedAt),
      insurancePayer: row.insurancePayer,
      cadenceOverrideDays: row.cadenceOverrideDays,
      channelPreference: row.channelPreference as OutreachChannel | null,
      hasPhone: row.phone != null && row.phone.length > 0,
    };
    const prescription: OutreachPrescription = {
      itemSku: row.prescriptionItemSku,
      cadenceDays: row.prescriptionCadenceDays,
    };
    const plan = resolveOutreachPlan({
      patient,
      prescription,
      rules,
      now: asOf,
    });

    // Eligibility: due iff (lastFulfilledAt ?? prescription.createdAt)
    // is at least `plan.cadenceDays` old.
    const baselineRaw = row.lastFulfilledAt ?? row.prescriptionCreatedAt;
    if (!baselineRaw) {
      logger.warn(
        { patient_id: row.patientId, episode_id: row.episodeId },
        "reminders.scan: missing baseline date — skipping",
      );
      continue;
    }
    const baseline = new Date(baselineRaw);
    if (isNaN(baseline.getTime())) {
      logger.warn(
        {
          patient_id: row.patientId,
          episode_id: row.episodeId,
          baseline_raw: String(baselineRaw),
        },
        "reminders.scan: unparseable baseline date — skipping",
      );
      continue;
    }
    if (daysBetween(baseline, asOf) < plan.cadenceDays) {
      // Not due yet — skip silently. Common case for the bulk of
      // active patients on every scan.
      continue;
    }

    // Channel resolution: the plan may resolve to "voice", which the
    // worker can't initiate. Downgrade to sms (if phone present) or
    // email; warn so admins can see the gap in scheduled outreach.
    let channel: "sms" | "email";
    if (plan.channel === "voice") {
      if (patient.hasPhone) {
        channel = "sms";
        logger.warn(
          {
            patient_id: row.patientId,
            episode_id: row.episodeId,
            requested_channel: plan.channel,
            channel_source: plan.channelSource,
          },
          "reminders.scan: voice channel requested — downgrading to sms (worker cannot place outbound voice calls)",
        );
      } else if (row.email) {
        channel = "email";
        logger.warn(
          {
            patient_id: row.patientId,
            episode_id: row.episodeId,
            requested_channel: plan.channel,
            channel_source: plan.channelSource,
          },
          "reminders.scan: voice channel requested — downgrading to email (worker cannot place outbound voice calls)",
        );
      } else {
        logger.warn(
          { patient_id: row.patientId, episode_id: row.episodeId },
          "reminders.scan: patient has no phone or email — skipping",
        );
        continue;
      }
    } else if (plan.channel === "sms") {
      if (!patient.hasPhone) {
        // Admin-set sms preference but no phone on file: fall back
        // to email rather than silently drop.
        if (!row.email) {
          logger.warn(
            { patient_id: row.patientId, episode_id: row.episodeId },
            "reminders.scan: patient has no phone or email — skipping",
          );
          continue;
        }
        channel = "email";
        logger.warn(
          {
            patient_id: row.patientId,
            episode_id: row.episodeId,
            channel_source: plan.channelSource,
          },
          "reminders.scan: sms requested but patient has no phone — falling back to email",
        );
      } else {
        channel = "sms";
      }
    } else {
      // plan.channel === "email"
      if (!row.email) {
        // Email preferred but no email on file: fall back to sms.
        if (!patient.hasPhone) {
          logger.warn(
            { patient_id: row.patientId, episode_id: row.episodeId },
            "reminders.scan: patient has no phone or email — skipping",
          );
          continue;
        }
        channel = "sms";
        logger.warn(
          {
            patient_id: row.patientId,
            episode_id: row.episodeId,
            channel_source: plan.channelSource,
          },
          "reminders.scan: email requested but patient has no email — falling back to sms",
        );
      } else {
        channel = "email";
      }
    }

    seenPatient.add(row.patientId);
    out.push({
      patientId: row.patientId,
      episodeId: row.episodeId,
      channel,
    });
  }

  return out;
}

/**
 * Register all reminder jobs + the hourly scan schedule on the given
 * pg-boss instance. Idempotent — pg-boss `schedule()` is upsert-style.
 *
 * We register the job handlers regardless of whether messaging is
 * configured; if it isn't, the handler logs a warn line and exits 0
 * rather than failing the job. That way a half-configured deploy
 * doesn't fill the pg-boss retry queue with permanent failures.
 */
export async function registerReminderJobs(boss: PgBoss): Promise<void> {
  // pg-boss v10 requires explicit queue creation before `schedule()` —
  // the `schedule` table has a foreign key into the `queue` table and
  // an unscheduled queue throws `schedule_name_fkey`. `createQueue` is
  // idempotent (it's an upsert), so calling it on every boot is safe.
  // We create all three queues up front so the order of `work()` /
  // `schedule()` calls below doesn't matter.
  await boss.createQueue(SCAN_JOB);
  await boss.createQueue(SEND_SMS_JOB);
  await boss.createQueue(SEND_EMAIL_JOB);

  await boss.work<ScanJobData>(SCAN_JOB, async (jobs) => {
    try {
      const data = jobs[0]?.data ?? {};
      const asOf = data.asOfIso ? new Date(data.asOfIso) : new Date();
      const rows = await scanForDueReminders(asOf);
      logger.info(
        { count: rows.length },
        "reminders.scan: enqueueing per-patient send jobs",
      );
      for (const row of rows) {
        const send: SendJobData = {
          patientId: row.patientId,
          episodeId: row.episodeId,
        };
        if (row.channel === "sms") {
          await boss.send(SEND_SMS_JOB, send);
        } else {
          await boss.send(SEND_EMAIL_JOB, send);
        }
      }
    } catch (err) {
      logger.error({ err }, "reminders.scan: job failed");
      throw err;
    }
  });

  await boss.work<SendJobData>(SEND_SMS_JOB, async (jobs) => {
    const j = jobs[0];
    if (!j) return;
    const cfg = readWorkerMessagingConfig();
    if (!cfg.sms || !cfg.hmacKeysReady) {
      logger.warn(
        { job_id: j.id },
        "reminders.send-sms: SMS not configured (missing TWILIO_* / link HMAC key) — skipping",
      );
      return;
    }
    const actor: SendActor = { kind: "system", jobId: j.id };
    const outcome = await sendReminderSms({
      supabase: getSupabaseServiceRoleClient(),
      cfg: cfg.sms,
      patientId: j.data.patientId,
      episodeId: j.data.episodeId,
      actor,
    });
    if (outcome.status !== "ok") {
      logger.warn(
        {
          job_id: j.id,
          patient_id: j.data.patientId,
          episode_id: j.data.episodeId,
          outcome: outcome.status,
        },
        "reminders.send-sms: non-ok outcome",
      );
      // Transient failures should be retried by pg-boss. Non-retryable
      // outcomes (patient inactive, missing phone, etc.) are warnings only.
      if (
        outcome.status === "vendor_api_error" ||
        outcome.status === "conversation_create_failed"
      ) {
        throw new Error(`reminders.send-sms: retryable failure: ${outcome.status}`);
      }
    }
  });

  await boss.work<SendJobData>(SEND_EMAIL_JOB, async (jobs) => {
    const j = jobs[0];
    if (!j) return;
    const cfg = readWorkerMessagingConfig();
    if (!cfg.email || !cfg.hmacKeysReady) {
      logger.warn(
        { job_id: j.id },
        "reminders.send-email: email not configured (missing SENDGRID_* / link HMAC key) — skipping",
      );
      return;
    }
    const actor: SendActor = { kind: "system", jobId: j.id };
    const outcome = await sendReminderEmail({
      supabase: getSupabaseServiceRoleClient(),
      cfg: cfg.email,
      patientId: j.data.patientId,
      episodeId: j.data.episodeId,
      actor,
    });
    if (outcome.status !== "ok") {
      logger.warn(
        {
          job_id: j.id,
          patient_id: j.data.patientId,
          episode_id: j.data.episodeId,
          outcome: outcome.status,
        },
        "reminders.send-email: non-ok outcome",
      );
      // Transient failures should be retried by pg-boss.
      if (
        outcome.status === "vendor_api_error" ||
        outcome.status === "conversation_create_failed"
      ) {
        throw new Error(`reminders.send-email: retryable failure: ${outcome.status}`);
      }
    }
  });

  // Hourly cron. Runs at minute 7 to avoid stacking with other
  // top-of-hour scheduled work. pg-boss `schedule` is upsert-style.
  // We omit the data param entirely; the handler treats absent data
  // as "scan with asOf = now", which is what we want for the cron.
  await boss.schedule(SCAN_JOB, "7 * * * *");
  logger.info("reminders.scan scheduled (cron: 7 * * * *)");
}
