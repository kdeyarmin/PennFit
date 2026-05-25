// pg-boss job: daily failed-email order digest (A7).
//
// Why this exists
// ---------------
// When a storefront fitter order's confirmation email fails to send
// (SendGrid 5xx, transient auth issue, etc.), the order route writes
// `email_status="failed"` on `public.orders` and moves on — the
// patient still sees a success page because the order itself
// persisted. Before this job, those failed rows sat in the table
// forever unless an ops engineer thought to query for them. By the
// time someone noticed, the customer had usually called in asking
// "did you get my order?".
//
// What this job does
// ------------------
// Once a day, scan `public.orders` for rows that:
//   * have `email_status = 'failed'`
//   * were created in the last 24 hours
// Send a single summary email to RESUPPLY_ADMIN_ALERTS_EMAIL with the
// count + first N order references. No PHI leaves the database —
// only `order_reference` (PENN-XXXXXX format) + `created_at` go in
// the email body. The email_error column is NOT included because
// SendGrid response bodies occasionally echo the patient's email
// address back, and the digest must stay PHI-clean even to a
// trusted ops mailbox (CLAUDE.md hard rule).
//
// Feature flag + recipient
// ------------------------
// Two env vars gate this job:
//   * RESUPPLY_FAILED_EMAIL_DIGEST_ENABLED=1   — turns the cron on
//   * RESUPPLY_ADMIN_ALERTS_EMAIL=<address>    — recipient
// If either is missing we log and exit cleanly. This is deliberately
// permissive: a dev environment without an alerts mailbox shouldn't
// fail health checks.
//
// PHI policy
// ----------
// CLAUDE.md "No order request bodies in the application logger"
// extends in spirit here. Even though the recipient is a trusted
// admin mailbox, we still:
//   * exclude patient_first_name/last_name/email/phone/dob from the
//     digest body and subject
//   * exclude shipping address fields
//   * exclude the `payload` jsonb (the request body the SPA sent)
//   * exclude `email_error` (may contain echoed patient email)
// What we DO include: order_reference (a PENN-XXXXXX code that's
// safe to share) + created_at (no PHI).

import type PgBoss from "pg-boss";

import { escapeHtml } from "@workspace/resupply-messaging";
import {
  getSupabaseServiceRoleClient,
  type Database,
} from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";

import { logger } from "../../lib/logger";
import { buildQueueConfig, VENDOR_SEND_QUEUE_OPTS } from "../lib/queue-options";

type OrderRow = Database["public"]["Tables"]["orders"]["Row"];

export const FAILED_EMAIL_DIGEST_JOB = "failed-order-emails.digest";

/**
 * Daily at 13:00 UTC (≈ 9:00 AM US Eastern). Lands during business
 * hours for the ops team while the failures are still fresh enough
 * that the customer hasn't called yet.
 */
export const FAILED_EMAIL_DIGEST_CRON = "0 13 * * *";

/** Lookback window for "what failed recently". */
export const DIGEST_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Cap the number of references in the body so the email stays readable. */
export const DIGEST_MAX_REFERENCES_LISTED = 20;

export interface FailedEmailDigestResult {
  /** Number of public.orders rows the scan matched. */
  failedCount: number;
  /**
   * `true` when we composed and sent a digest. `false` when there
   * was nothing to send OR when SendGrid was not configured (we
   * log and exit instead of erroring out).
   */
  sent: boolean;
  /** When `sent: false`, this carries the reason for ops triage. */
  skippedReason?:
    | "no_failures"
    | "no_recipient"
    | "sendgrid_not_configured";
}

interface FailedRow {
  orderReference: string;
  createdAt: string;
}

function composeDigestEmail(opts: {
  recipient: string;
  rows: FailedRow[];
  totalCount: number;
  windowHours: number;
}): {
  to: string;
  subject: string;
  html: string;
  text: string;
} {
  const { recipient, rows, totalCount, windowHours } = opts;
  const subject = `PennPaps: ${totalCount} order ${
    totalCount === 1 ? "confirmation failed" : "confirmations failed"
  } in the last ${windowHours}h`;

  const introText =
    `${totalCount} fitter order ${totalCount === 1 ? "had its" : "had their"} ` +
    `confirmation email marked email_status="failed" in the last ${windowHours} ` +
    `hours. The order rows persisted; the patient saw a success page. Action ` +
    `for ops: open each in /admin/orders, confirm the customer reached out, and ` +
    `re-send manually if needed.`;

  const listText = rows
    .map((r) => `  - ${r.orderReference}   (created ${r.createdAt})`)
    .join("\n");
  const overflowText =
    totalCount > rows.length
      ? `\n  ...and ${totalCount - rows.length} more. ` +
        `Run the /admin/orders failed-status filter for the complete list.`
      : "";
  const text = `${introText}\n\n${listText}${overflowText}\n`;

  const listHtml = rows
    .map(
      (r) =>
        `        <li><code>${escapeHtml(r.orderReference)}</code> &mdash; created ${escapeHtml(r.createdAt)}</li>`,
    )
    .join("\n");
  const overflowHtml =
    totalCount > rows.length
      ? `      <p>&hellip;and ${totalCount - rows.length} more. Run the ` +
        `<code>/admin/orders</code> failed-status filter for the complete list.</p>`
      : "";
  const html = `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 640px; margin: 0 auto;">
    <h2 style="color: #001f3f;">${totalCount} order ${
      totalCount === 1 ? "confirmation" : "confirmations"
    } failed in the last ${windowHours}h</h2>
    <p style="color: #444;">${escapeHtml(introText)}</p>
    <ul style="font-family: monospace; line-height: 1.7;">
${listHtml}
    </ul>
${overflowHtml}
  </body>
</html>`;

  return { to: recipient, subject, html, text };
}

/**
 * Runs one digest scan + (optional) send. Pure-ish: the only side
 * effects are the Supabase read and the SendGrid send. The result
 * envelope tells the caller what happened for ops logging.
 *
 * `now` is injectable for tests; production callers omit it.
 */
export async function runFailedEmailDigest(opts: {
  now?: Date;
} = {}): Promise<FailedEmailDigestResult> {
  const recipient = process.env.RESUPPLY_ADMIN_ALERTS_EMAIL?.trim();
  if (!recipient) {
    return { failedCount: 0, sent: false, skippedReason: "no_recipient" };
  }

  const now = opts.now ?? new Date();
  const cutoffIso = new Date(now.getTime() - DIGEST_LOOKBACK_MS).toISOString();

  const supabase = getSupabaseServiceRoleClient();
  // We deliberately select only the two PHI-safe columns. The
  // patient_* columns and the `payload` jsonb stay in the database.
  const { count, error: countError } = await supabase
    .schema("public")
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("email_status", "failed")
    .gte("created_at", cutoffIso);
  if (countError) throw countError;
  const failedCount = count ?? 0;

  if (failedCount === 0) {
    return { failedCount: 0, sent: false, skippedReason: "no_failures" };
  }

  const { data: rows, error } = await supabase
    .schema("public")
    .from("orders")
    .select("order_reference, created_at")
    .eq("email_status", "failed")
    .gte("created_at", cutoffIso)
    .order("created_at", { ascending: false })
    .limit(DIGEST_MAX_REFERENCES_LISTED);
  if (error) throw error;

  const matched: FailedRow[] = (rows ?? []).map(
    (r: Pick<OrderRow, "order_reference" | "created_at">) => ({
      orderReference: r.order_reference,
      createdAt: r.created_at,
    }),
  );

  let sendgrid;
  try {
    sendgrid = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      return {
        failedCount,
        sent: false,
        skippedReason: "sendgrid_not_configured",
      };
    }
    throw err;
  }

  const message = composeDigestEmail({
    recipient,
    rows: matched,
    totalCount: failedCount,
    windowHours: DIGEST_LOOKBACK_MS / (60 * 60 * 1000),
  });

  await sendgrid.sendEmail({
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
    customArgs: { kind: "ops_failed_order_emails_digest_v1" },
  });

  return { failedCount, sent: true };
}

export async function registerFailedEmailDigestJob(
  boss: PgBoss,
): Promise<void> {
  if (process.env.RESUPPLY_FAILED_EMAIL_DIGEST_ENABLED !== "1") {
    logger.info(
      { event: "failed-order-emails.digest.disabled" },
      "failed-order-emails.digest: not registered (RESUPPLY_FAILED_EMAIL_DIGEST_ENABLED!=1)",
    );
    return;
  }
  if (!process.env.RESUPPLY_ADMIN_ALERTS_EMAIL?.trim()) {
    logger.warn(
      { event: "failed-order-emails.digest.no_recipient" },
      "failed-order-emails.digest: enabled but RESUPPLY_ADMIN_ALERTS_EMAIL is empty; not registered",
    );
    return;
  }
  await boss.createQueue(FAILED_EMAIL_DIGEST_JOB, buildQueueConfig(FAILED_EMAIL_DIGEST_JOB, VENDOR_SEND_QUEUE_OPTS));
  await boss.work(FAILED_EMAIL_DIGEST_JOB, async () => {
    try {
      const result = await runFailedEmailDigest();
      logger.info(
        {
          event: "failed-order-emails.digest.completed",
          ...result,
        },
        "failed-order-emails.digest: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "failed-order-emails.digest: failed",
      );
      throw err;
    }
  });
  await boss.schedule(FAILED_EMAIL_DIGEST_JOB, FAILED_EMAIL_DIGEST_CRON);
  logger.info(
    { cron: FAILED_EMAIL_DIGEST_CRON },
    "failed-order-emails.digest scheduled",
  );
}
