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
// the previous scan or from an operator's manual send). The threshold
// is hard-coded; patient-controlled DND lives in a separate ADR.
//
// Channel selection (v1)
// ----------------------
// Prefer SMS when the patient has a phone on file; fall back to email
// when the phone column is null. We send ONE channel per scan to avoid
// double-pinging — the AI fallback in inbound.ts can suggest a
// channel switch later if the patient doesn't respond. ADR 013
// documents this and the deferred "patient channel preference" work.
//
// Episode resolution
// ------------------
// The eligibility query selects the OVERDUE PRESCRIPTION; the send
// helper resolves the episode internally (most-recent for the
// patient). For patients with multiple overdue scripts the scan
// enqueues one send per script, deduped by patient_id within the
// scan window — operators get one ping per patient per cycle, not one
// per SKU.

import { and, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type PgBoss from "pg-boss";

import {
  conversations,
  decrypt,
  episodes,
  fulfillments,
  getDbPool,
  patients,
  prescriptions,
} from "@workspace/resupply-db";
import {
  sendReminderEmail,
  sendReminderSms,
  type SendActor,
} from "@workspace/resupply-reminders";

import { logger } from "../logger.js";

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
  channel: "sms" | "email";
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
  const practiceName = env.RESUPPLY_PRACTICE_NAME ?? "Penn Sleep Center";
  const publicBaseUrl = stripTrailingSlash(
    env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
      (env.REPLIT_DEV_DOMAIN ? `https://${env.REPLIT_DEV_DOMAIN}` : ""),
  );
  const hmacKeysReady = Boolean(
    env.RESUPPLY_PHONE_HMAC_KEY && env.RESUPPLY_LINK_HMAC_KEY,
  );

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
 * computed in TypeScript after we decrypt phone/email (we cannot
 * filter on encrypted columns in SQL).
 */
export async function scanForDueReminders(
  asOf: Date = new Date(),
): Promise<ScanRow[]> {
  const pool = getDbPool();
  const db = drizzle(pool);
  const quietCutoff = new Date(asOf.getTime() - QUIET_PERIOD_MS);

  // Step 1: candidate (patient, prescription, episode) tuples that
  // are eligible by date math. We join episodes onto prescriptions to
  // surface the one episode the send helper will operate on; we pull
  // the most recent episode per (patient, prescription).
  //
  // The "due" predicate has two halves:
  //   - prescription has at least one fulfilled episode and the most
  //     recent fulfillment is older than cadence_days
  //   - OR prescription has no fulfillments and was created more
  //     than cadence_days ago.
  //
  // We compute "most recent fulfillment per (patient, item_sku)"
  // inline as a correlated subquery — clearer than a CTE for this
  // small table.
  const cutoff = sql`now() - (${prescriptions.cadenceDays} || ' days')::interval`;
  const lastFulfilledAt = sql<Date | null>`(
    SELECT MAX(${fulfillments.shippedAt})
    FROM ${fulfillments}
    WHERE ${fulfillments.patientId} = ${patients.id}
      AND ${fulfillments.itemSku} = ${prescriptions.itemSku}
  )`;

  const dueRows = await db
    .select({
      patientId: patients.id,
      episodeId: episodes.id,
      phone: decrypt(patients.phoneE164),
      email: decrypt(patients.email),
    })
    .from(patients)
    .innerJoin(prescriptions, eq(prescriptions.patientId, patients.id))
    .innerJoin(episodes, eq(episodes.prescriptionId, prescriptions.id))
    .where(
      and(
        eq(patients.status, "active"),
        eq(prescriptions.status, "active"),
        or(
          // Has a prior fulfillment older than cadence_days
          and(
            sql`${lastFulfilledAt} IS NOT NULL`,
            sql`${lastFulfilledAt} < ${cutoff}`,
          ),
          // Has never been fulfilled and the prescription is older
          // than cadence_days
          and(
            sql`${lastFulfilledAt} IS NULL`,
            lt(prescriptions.createdAt, cutoff as unknown as Date),
          ),
        ),
        // Quiet-period: no conversation opened in the last 48h for
        // this episode. Implemented as a NOT EXISTS so the row is
        // dropped at the SQL layer.
        sql`NOT EXISTS (
          SELECT 1 FROM ${conversations}
          WHERE ${conversations.episodeId} = ${episodes.id}
            AND ${conversations.lastMessageAt} >= ${quietCutoff}
        )`,
      ),
    )
    .orderBy(desc(episodes.dueAt));

  // Step 2: dedupe to one (patient, episode) per scan and pick the
  // channel from decrypted contact info. SMS preferred when phone
  // present; else email; else dropped (and logged).
  const seenPatient = new Set<string>();
  const out: ScanRow[] = [];
  for (const row of dueRows) {
    if (seenPatient.has(row.patientId)) continue;
    let channel: "sms" | "email" | null = null;
    if (row.phone) channel = "sms";
    else if (row.email) channel = "email";
    if (!channel) {
      logger.warn(
        { patient_id: row.patientId, episode_id: row.episodeId },
        "reminders.scan: patient has no phone or email — skipping",
      );
      continue;
    }
    seenPatient.add(row.patientId);
    out.push({
      patientId: row.patientId,
      episodeId: row.episodeId,
      channel,
    });
  }

  // Suppress unused import — `gte` and `isNull` are exported for
  // possible future predicate work but not used in the current query.
  void gte;
  void isNull;
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
  });

  await boss.work<SendJobData>(SEND_SMS_JOB, async (jobs) => {
    const j = jobs[0];
    if (!j) return;
    const cfg = readWorkerMessagingConfig();
    if (!cfg.sms || !cfg.hmacKeysReady) {
      logger.warn(
        { job_id: j.id },
        "reminders.send-sms: SMS not configured (missing TWILIO_* / RESUPPLY_PHONE_HMAC_KEY) — skipping",
      );
      return;
    }
    const actor: SendActor = { kind: "system", jobId: j.id };
    const outcome = await sendReminderSms({
      pool: getDbPool(),
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
    }
  });

  await boss.work<SendJobData>(SEND_EMAIL_JOB, async (jobs) => {
    const j = jobs[0];
    if (!j) return;
    const cfg = readWorkerMessagingConfig();
    if (!cfg.email || !cfg.hmacKeysReady) {
      logger.warn(
        { job_id: j.id },
        "reminders.send-email: email not configured (missing SENDGRID_* / RESUPPLY_LINK_HMAC_KEY) — skipping",
      );
      return;
    }
    const actor: SendActor = { kind: "system", jobId: j.id };
    const outcome = await sendReminderEmail({
      pool: getDbPool(),
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
    }
  });

  // Hourly cron. Runs at minute 7 to avoid stacking with other
  // top-of-hour scheduled work. pg-boss `schedule` is upsert-style.
  // We omit the data param entirely; the handler treats absent data
  // as "scan with asOf = now", which is what we want for the cron.
  await boss.schedule(SCAN_JOB, "7 * * * *");
  logger.info("reminders.scan scheduled (cron: 7 * * * *)");
}
