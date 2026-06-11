// pg-boss job: outreach-playbook dispatcher.
//
// Walks active playbook runs (resupply.outreach_playbook_runs) whose
// next_step_at is due, executes the step, and advances the run —
// the same claim-then-send pattern as the fitter supply campaign:
// the run's step pointer is advanced with an optimistic WHERE pinning
// the prior value BEFORE the vendor call, so two overlapping sweeps
// can't double-send a touch, and the per-(run, step) UNIQUE constraint
// on outreach_playbook_step_log is the second line of defense.
//
// Channels
// --------
//   sms   — sendReminderSms() with the rendered playbook body. Lands
//           in the patient's conversation thread like every other
//           outbound SMS (conversations + messages rows, audit).
//   email — sendReminderEmail() with the custom-content override
//           (subject + body + signed stop link). Same recording path.
//   call  — no vendor call. The step materializes as a
//           status='call_due' row in outreach_playbook_step_log with
//           the rendered staff script; the admin call queue
//           (/admin/outreach-playbooks/call-queue) drains it and
//           staff dial via click-to-dial (which owns the TCPA call
//           window). The run keeps advancing — an unfinished call
//           task never stalls later touches.
//
// Guardrails
// ----------
//   * Runtime feature flag `outreach_playbooks.dispatcher` — flipping
//     it off in Control Center pauses all sends without a deploy and
//     without cancelling runs.
//   * Patient communication preferences: channel opt-outs skip the
//     touch (logged, run advances); a DND window DEFERS the run by
//     two hours without consuming the step.
//   * Patients who are no longer active get their runs cancelled.
//
// PHI / log posture: rendered bodies and scripts go to the vendor and
// the DB only. Log lines carry ids, channels, and reason codes.

import type PgBoss from "pg-boss";

import {
  DEFAULT_COMMUNICATION_PREFERENCES,
  getSupabaseServiceRoleClient,
  type CommunicationPreferences,
} from "@workspace/resupply-db";
import {
  sendReminderEmail,
  sendReminderSms,
  type EmailSendConfig,
  type SendActor,
  type SmsSendConfig,
} from "@workspace/resupply-reminders";
import { DEFAULT_SENDGRID_FROM_EMAIL } from "@workspace/resupply-email";
import { hasLinkHmacKey } from "@workspace/resupply-secrets";

import {
  isInDndWindow,
  isOutsideSmsSendWindow,
  shouldSendEmail,
  shouldSendSms,
} from "../../lib/comm-prefs.js";
import { isFeatureEnabled } from "../../lib/feature-flags.js";
import { logger } from "../../lib/logger.js";
import {
  renderPlaybookBody,
  stepDueAt,
  type PlaybookChannel,
} from "../../lib/outreach-playbooks.js";
import {
  createQueueWithDlq,
  CRON_SCAN_QUEUE_OPTS,
} from "../lib/queue-options.js";

const JOB_NAME = "outreach-playbooks.dispatcher";
/** Every 5 minutes so a "day 0" first touch goes out shortly after a
 *  CSR starts the run, not up to an hour later. */
const JOB_CRON = "*/5 * * * *";
const BATCH_SIZE = 50;
/** Defer (not skip) a touch that lands inside the patient's DND
 *  window; re-check after this many hours. */
const DND_DEFER_HOURS = 2;

export interface PlaybookTickStats {
  scanned: number;
  smsSent: number;
  emailsSent: number;
  callTasksCreated: number;
  deferredDnd: number;
  skipped: number;
  completedRuns: number;
  cancelledRuns: number;
  claimLost: number;
  errors: number;
  flagDisabled: boolean;
}

interface RunRow {
  id: string;
  playbook_id: string;
  patient_id: string;
  next_step_index: number;
  started_at: string;
}

interface StepRow {
  step_index: number;
  day_offset: number;
  channel: PlaybookChannel;
  subject: string | null;
  body: string;
}

function readMessagingConfig(env: NodeJS.ProcessEnv = process.env): {
  sms: SmsSendConfig | null;
  email: EmailSendConfig | null;
  hmacKeyReady: boolean;
  practiceName: string;
} {
  const practiceName = env.RESUPPLY_PRACTICE_NAME ?? "PennPaps";
  const publicBaseUrl = (
    env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
    (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : "")
  ).replace(/\/+$/, "");

  let sms: SmsSendConfig | null = null;
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

  let email: EmailSendConfig | null = null;
  if (env.SENDGRID_API_KEY && env.SENDGRID_FROM_NAME && publicBaseUrl) {
    email = {
      sendgridApiKey: env.SENDGRID_API_KEY,
      sendgridFromEmail:
        env.SENDGRID_FROM_EMAIL?.trim() || DEFAULT_SENDGRID_FROM_EMAIL,
      sendgridFromName: env.SENDGRID_FROM_NAME,
      publicBaseUrl,
      practiceName,
    };
  }

  return { sms, email, hmacKeyReady: hasLinkHmacKey(env), practiceName };
}

function parsePrefs(raw: unknown): CommunicationPreferences {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_COMMUNICATION_PREFERENCES;
  }
  return {
    ...DEFAULT_COMMUNICATION_PREFERENCES,
    ...(raw as Partial<CommunicationPreferences>),
  };
}

/** Best-effort step-log write. The UNIQUE (run_id, step_index)
 *  constraint absorbs lost-race duplicates (23505 is expected then). */
async function recordStep(opts: {
  runId: string;
  stepIndex: number;
  channel: PlaybookChannel;
  status: "sent" | "failed" | "skipped" | "call_due";
  detail?: string | null;
  callScript?: string | null;
}): Promise<void> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("outreach_playbook_step_log")
      .insert({
        run_id: opts.runId,
        step_index: opts.stepIndex,
        channel: opts.channel,
        status: opts.status,
        detail: opts.detail ?? null,
        call_script: opts.callScript ?? null,
      });
    if (error && (error as { code?: string }).code !== "23505") {
      logger.warn(
        { err: error.message, runId: opts.runId, stepIndex: opts.stepIndex },
        "outreach-playbooks: step log insert failed",
      );
    }
  } catch (err) {
    logger.warn(
      { err, runId: opts.runId, stepIndex: opts.stepIndex },
      "outreach-playbooks: step log insert threw",
    );
  }
}

/**
 * Run one sweep. Exported for tests + manual ops invocation.
 */
export async function runOutreachPlaybookSweep(
  now: Date = new Date(),
): Promise<PlaybookTickStats> {
  const stats: PlaybookTickStats = {
    scanned: 0,
    smsSent: 0,
    emailsSent: 0,
    callTasksCreated: 0,
    deferredDnd: 0,
    skipped: 0,
    completedRuns: 0,
    cancelledRuns: 0,
    claimLost: 0,
    errors: 0,
    flagDisabled: false,
  };

  if (!(await isFeatureEnabled("outreach_playbooks.dispatcher"))) {
    stats.flagDisabled = true;
    return stats;
  }

  const supabase = getSupabaseServiceRoleClient();
  const nowIso = now.toISOString();

  const { data: runs, error: runsErr } = await supabase
    .schema("resupply")
    .from("outreach_playbook_runs")
    .select("id, playbook_id, patient_id, next_step_index, started_at")
    .eq("status", "active")
    .lte("next_step_at", nowIso)
    .order("next_step_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (runsErr) throw runsErr;
  const runRows = (runs ?? []) as RunRow[];
  if (runRows.length === 0) return stats;

  // Steps for every playbook in the batch, one query.
  const playbookIds = [...new Set(runRows.map((r) => r.playbook_id))];
  const { data: steps, error: stepsErr } = await supabase
    .schema("resupply")
    .from("outreach_playbook_steps")
    .select("playbook_id, step_index, day_offset, channel, subject, body")
    .in("playbook_id", playbookIds)
    .order("step_index", { ascending: true });
  if (stepsErr) throw stepsErr;
  const stepsByPlaybook = new Map<string, StepRow[]>();
  for (const s of (steps ?? []) as Array<StepRow & { playbook_id: string }>) {
    const list = stepsByPlaybook.get(s.playbook_id) ?? [];
    list.push(s);
    stepsByPlaybook.set(s.playbook_id, list);
  }

  const cfg = readMessagingConfig();
  const actor: SendActor = { kind: "system", jobId: null };

  for (const run of runRows) {
    stats.scanned += 1;
    const playbookSteps = stepsByPlaybook.get(run.playbook_id) ?? [];
    const step = playbookSteps.find(
      (s) => s.step_index === run.next_step_index,
    );

    // Pointer past the (possibly edited) cadence — the run is done.
    if (!step) {
      const { error } = await supabase
        .schema("resupply")
        .from("outreach_playbook_runs")
        .update({
          status: "completed",
          completed_at: nowIso,
          next_step_at: null,
          updated_at: nowIso,
        })
        .eq("id", run.id)
        .eq("status", "active")
        .eq("next_step_index", run.next_step_index);
      if (error) {
        stats.errors += 1;
        logger.warn(
          { err: error.message, runId: run.id },
          "outreach-playbooks: complete-run update failed",
        );
      } else {
        stats.completedRuns += 1;
      }
      continue;
    }

    // Patient gate: must still exist and be active.
    const { data: patient, error: patientErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select(
        "id, status, legal_first_name, communication_preferences, timezone, address",
      )
      .eq("id", run.patient_id)
      .maybeSingle();
    if (patientErr) {
      stats.errors += 1;
      logger.warn(
        { err: patientErr.message, runId: run.id },
        "outreach-playbooks: patient lookup failed",
      );
      continue;
    }
    const patientRow = patient as {
      status: string;
      legal_first_name: string | null;
      communication_preferences?: unknown;
      timezone?: string | null;
      address?: { zip?: string } | null;
    } | null;
    if (!patientRow || patientRow.status !== "active") {
      const { error } = await supabase
        .schema("resupply")
        .from("outreach_playbook_runs")
        .update({
          status: "cancelled",
          cancelled_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", run.id)
        .eq("status", "active");
      if (error) {
        stats.errors += 1;
      } else {
        stats.cancelledRuns += 1;
        await recordStep({
          runId: run.id,
          stepIndex: run.next_step_index,
          channel: step.channel,
          status: "skipped",
          detail: patientRow ? "patient_not_active" : "patient_not_found",
        });
      }
      continue;
    }

    const prefs = parsePrefs(patientRow.communication_preferences);

    // DND defer — push the touch out without consuming the step.
    // Call tasks are exempt: they're staff-initiated later, and
    // click-to-dial enforces the call window at dial time.
    //
    // SMS steps additionally defer outside the hard TCPA send window
    // (9am–8pm local; isOutsideSmsSendWindow). The dispatcher runs
    // every 5 minutes around the clock, and the patient-configured DND
    // window defaults to null — without this gate a run started at
    // 11pm fires its day-0 text at 11:05pm, and every later touch
    // lands at the same overnight hour (stepDueAt anchors to
    // started_at). Deferring (not skipping) walks the touch into the
    // next legal window without consuming the step.
    if (
      step.channel !== "call" &&
      (isInDndWindow(prefs, now) ||
        (step.channel === "sms" &&
          isOutsideSmsSendWindow(now, {
            timezone: patientRow.timezone ?? null,
            shippingZip: patientRow.address?.zip ?? null,
          })))
    ) {
      const { error } = await supabase
        .schema("resupply")
        .from("outreach_playbook_runs")
        .update({
          next_step_at: new Date(
            now.getTime() + DND_DEFER_HOURS * 60 * 60 * 1000,
          ).toISOString(),
          updated_at: nowIso,
        })
        .eq("id", run.id)
        .eq("status", "active")
        .eq("next_step_index", run.next_step_index);
      if (error) stats.errors += 1;
      else stats.deferredDnd += 1;
      continue;
    }

    // Atomic claim — advance the pointer BEFORE the send, pinning the
    // prior value. Compute the following step's due time from the
    // run's start anchor (mirrors the fitter campaign's completed_at
    // anchoring).
    const followingStep = playbookSteps.find(
      (s) => s.step_index === run.next_step_index + 1,
    );
    const startedAt = new Date(run.started_at);
    const claim: Record<string, unknown> = {
      next_step_index: run.next_step_index + 1,
      updated_at: nowIso,
    };
    if (followingStep) {
      // Never schedule in the past relative to this tick — back-dated
      // offsets (e.g. steps sharing a day) fire on the next tick.
      const dueAt = stepDueAt(startedAt, followingStep.day_offset);
      claim.next_step_at = (dueAt > now ? dueAt : now).toISOString();
    } else {
      claim.next_step_at = null;
      claim.status = "completed";
      claim.completed_at = nowIso;
    }
    const { data: claimed, error: claimErr } = await supabase
      .schema("resupply")
      .from("outreach_playbook_runs")
      .update(claim)
      .eq("id", run.id)
      .eq("status", "active")
      .eq("next_step_index", run.next_step_index)
      .select("id");
    if (claimErr) {
      stats.errors += 1;
      logger.warn(
        { err: claimErr.message, runId: run.id },
        "outreach-playbooks: claim failed",
      );
      continue;
    }
    if (!claimed || claimed.length === 0) {
      stats.claimLost += 1;
      continue;
    }
    if (!followingStep) stats.completedRuns += 1;

    const rendered = renderPlaybookBody(step.body, {
      firstName: patientRow.legal_first_name,
      practiceName: cfg.practiceName,
    });

    try {
      if (step.channel === "call") {
        await recordStep({
          runId: run.id,
          stepIndex: step.step_index,
          channel: "call",
          status: "call_due",
          callScript: rendered,
        });
        stats.callTasksCreated += 1;
        continue;
      }

      if (step.channel === "sms") {
        if (!cfg.sms) {
          stats.skipped += 1;
          await recordStep({
            runId: run.id,
            stepIndex: step.step_index,
            channel: "sms",
            status: "skipped",
            detail: "no_twilio_config",
          });
          continue;
        }
        if (!shouldSendSms(prefs, "transactional", now)) {
          stats.skipped += 1;
          await recordStep({
            runId: run.id,
            stepIndex: step.step_index,
            channel: "sms",
            status: "skipped",
            detail: "patient_prefs_sms_off",
          });
          continue;
        }
        const outcome = await sendReminderSms({
          supabase,
          cfg: cfg.sms,
          patientId: run.patient_id,
          body: rendered,
          actor,
        });
        if (outcome.status === "ok") {
          stats.smsSent += 1;
          await recordStep({
            runId: run.id,
            stepIndex: step.step_index,
            channel: "sms",
            status: "sent",
          });
        } else {
          stats.errors += 1;
          await recordStep({
            runId: run.id,
            stepIndex: step.step_index,
            channel: "sms",
            status: "failed",
            detail: outcome.status,
          });
        }
        continue;
      }

      // email
      if (!cfg.email || !cfg.hmacKeyReady) {
        stats.skipped += 1;
        await recordStep({
          runId: run.id,
          stepIndex: step.step_index,
          channel: "email",
          status: "skipped",
          detail: cfg.email ? "no_link_hmac_key" : "no_sendgrid_config",
        });
        continue;
      }
      if (!shouldSendEmail(prefs, "resupplyReminder", now)) {
        stats.skipped += 1;
        await recordStep({
          runId: run.id,
          stepIndex: step.step_index,
          channel: "email",
          status: "skipped",
          detail: "patient_prefs_email_off",
        });
        continue;
      }
      const subject = renderPlaybookBody(step.subject ?? "", {
        firstName: patientRow.legal_first_name,
        practiceName: cfg.practiceName,
      });
      const outcome = await sendReminderEmail({
        supabase,
        cfg: cfg.email,
        patientId: run.patient_id,
        content: { subject, bodyText: rendered },
        actor,
      });
      if (outcome.status === "ok") {
        stats.emailsSent += 1;
        await recordStep({
          runId: run.id,
          stepIndex: step.step_index,
          channel: "email",
          status: "sent",
        });
      } else {
        stats.errors += 1;
        await recordStep({
          runId: run.id,
          stepIndex: step.step_index,
          channel: "email",
          status: "failed",
          detail: outcome.status,
        });
      }
    } catch (err) {
      // Vendor-config errors and unexpected throws: the claim already
      // advanced, so record the failure and keep draining the batch —
      // one bad row must not wedge every other run.
      stats.errors += 1;
      logger.warn(
        {
          err,
          runId: run.id,
          stepIndex: step.step_index,
          channel: step.channel,
        },
        "outreach-playbooks: step send threw",
      );
      await recordStep({
        runId: run.id,
        stepIndex: step.step_index,
        channel: step.channel,
        status: "failed",
        detail: "send_threw",
      });
    }
  }

  return stats;
}

export async function registerOutreachPlaybookTickJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(boss, JOB_NAME, CRON_SCAN_QUEUE_OPTS);
  await boss.work(JOB_NAME, async () => {
    try {
      const stats = await runOutreachPlaybookSweep();
      if (stats.scanned > 0 || stats.errors > 0) {
        logger.info(
          { event: "outreach_playbooks.tick", ...stats },
          "outreach-playbooks: sweep completed",
        );
      }
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "outreach-playbooks: sweep failed",
      );
      throw err;
    }
  });
  await boss.schedule(JOB_NAME, JOB_CRON);
  logger.info({ cron: JOB_CRON }, "outreach-playbooks dispatcher scheduled");
}
