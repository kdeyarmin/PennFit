/**
 * Persistent consecutive-failure tracker for integration crons.
 *
 * Reads/writes resupply.integration_run_health (migration 0261).
 * Each integration registers a key (e.g. "therapy.nightly-sync",
 * "office-ally.inbound-poll").  On success the counter resets; on
 * failure it increments.  When the count first crosses the alert
 * threshold the job sends a single email to RESUPPLY_ADMIN_EMAILS
 * via the shared SendGrid client, then again every REPEAT_EVERY
 * failures so sustained silence doesn't look like recovery.
 *
 * All writes are non-fatal: a DB hiccup in the health tracker must
 * never crash the cron it's monitoring.
 */

import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger.js";
import { parseRecipientList } from "../jobs/metric-alerts-notify.js";

const ALERT_THRESHOLD = 3;
const REPEAT_EVERY = 5;

export async function recordIntegrationSuccess(key: string): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  await supabase
    .schema("resupply")
    .from("integration_run_health")
    .upsert(
      {
        key,
        consecutive_failures: 0,
        last_success_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    )
    .then(
      () => undefined,
      (err) =>
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), key },
          "integration-health: recordSuccess write failed (non-fatal)",
        ),
    );
}

export async function recordIntegrationFailure(
  key: string,
  detail: string,
): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  const nowIso = new Date().toISOString();
  const truncatedDetail = detail.slice(0, 2000);

  // Read current count so we can increment correctly — PostgREST upsert
  // doesn't support col + 1 expressions.
  const { data: existing } = await supabase
    .schema("resupply")
    .from("integration_run_health")
    .select("consecutive_failures")
    .eq("key", key)
    .maybeSingle();

  const prevCount = existing?.consecutive_failures ?? 0;
  const newCount = prevCount + 1;

  const { error: writeErr } = await supabase
    .schema("resupply")
    .from("integration_run_health")
    .upsert(
      {
        key,
        consecutive_failures: newCount,
        last_failure_at: nowIso,
        last_failure_detail: truncatedDetail,
        updated_at: nowIso,
      },
      { onConflict: "key" },
    );

  if (writeErr) {
    logger.warn(
      { err: writeErr.message, key },
      "integration-health: failure write failed (non-fatal)",
    );
  }

  const shouldAlert =
    newCount >= ALERT_THRESHOLD &&
    (newCount - ALERT_THRESHOLD) % REPEAT_EVERY === 0;
  if (shouldAlert) {
    await sendIntegrationAlert(key, newCount, detail);
  }
}

async function sendIntegrationAlert(
  key: string,
  consecutiveFailures: number,
  detail: string,
): Promise<void> {
  const recipients = parseRecipientList(process.env.RESUPPLY_ADMIN_EMAILS);
  if (recipients.length === 0) {
    logger.warn(
      { key, consecutiveFailures },
      "integration-health: alert suppressed — RESUPPLY_ADMIN_EMAILS empty",
    );
    return;
  }

  let sendgrid;
  try {
    sendgrid = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      logger.warn(
        { key, consecutiveFailures },
        "integration-health: alert suppressed — email not configured",
      );
      return;
    }
    throw err;
  }

  const subject = `[PennFit] Integration alert: ${key} has failed ${consecutiveFailures} consecutive time(s)`;
  const html = `
    <p>The <strong>${escHtml(key)}</strong> integration cron has failed
    <strong>${consecutiveFailures}</strong> consecutive run(s).</p>
    <p><strong>Last error:</strong> ${escHtml(detail.slice(0, 500))}</p>
    <p>Check the worker logs and the integration configuration in
    <em>/admin/system/configuration</em>.</p>
  `.trim();

  for (const to of recipients) {
    await sendgrid
      .sendEmail({ to, subject, html, text: `${key} has failed ${consecutiveFailures} consecutive time(s). Last error: ${detail.slice(0, 500)}` })
      .catch((sendErr: unknown) => {
        logger.warn(
          {
            err:
              sendErr instanceof Error ? sendErr.message : String(sendErr),
            to,
            key,
          },
          "integration-health: alert email send failed (non-fatal)",
        );
      });
  }

  logger.error(
    { key, consecutiveFailures, recipients: recipients.length },
    "integration-health: sustained failure alert sent",
  );
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
