// pg-boss job: annual deductible-reset push.
//
// Why this exists
// ---------------
// US insurance deductibles reset Jan 1. Patients who've hit their
// out-of-pocket max this year pay $0 for in-network DME through
// year-end and drop back to full coinsurance the moment the
// calendar flips. A "stock up before Jan 1" reminder is standard
// across DME suppliers and a meaningful Q4 revenue lever.
//
// Schedule
// --------
// Daily at 14:53 UTC, but the worker itself short-circuits unless
// the current month is November. Running daily within the window
// (vs. once on Nov 1) makes the cron self-healing — a deploy that
// misses Nov 1 picks up the next morning, and customers added
// to the table mid-month still get caught.
//
// Eligibility predicate
// ---------------------
// A shop_customers row is sent the year-N email iff:
//
//   * communication_preferences.emailMarketing is true (default).
//   * email_lower is non-null.
//   * Has shipped a paid order in the past 730 days (so this isn't
//     a stale registration we'd otherwise be win-backing).
//   * shop_customers.deductible_reset_year != current year (so a
//     re-run doesn't double-send).
//
// Idempotency
// -----------
// The atomic update sets deductible_reset_year = currentYear BEFORE
// the send. A SendGrid failure releases the year stamp so the next
// daily run retries. Once stamped successfully, subsequent runs in
// the same November skip the row.

import type PgBoss from "pg-boss";

import {
  DEFAULT_COMMUNICATION_PREFERENCES,
  type CommunicationPreferences,
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { sendDeductibleResetEmail } from "../../lib/order-emails/send-deductible-reset-email";
import { shouldSendEmail } from "../../lib/comm-prefs";
import { logger } from "../../lib/logger";
import { buildQueueConfig, VENDOR_SEND_QUEUE_OPTS } from "../lib/queue-options";

const JOB_NAME = "shop-customers.deductible-reset";
const JOB_CRON = "53 14 * * *"; // Daily 14:53 UTC.

/** Month-of-year (1-12) we run during. November = 11. */
const SEND_MONTH = 11;
/** Look-back window for "is this still an active customer?". */
const ACTIVE_LOOKBACK_DAYS = 730;
/** Soft per-run cap so a fresh November doesn't burst the email vendor. */
const PER_RUN_MAX = 500;

export interface DeductibleResetStats {
  candidates: number;
  sent: number;
  skipped: number;
  failed: number;
  outOfWindow: boolean;
}

interface CustomerCandidate {
  customer_id: string;
  email_lower: string;
  display_name: string | null;
  communication_preferences: Json | null;
  deductible_reset_year: number | null;
}

function isoDaysAgo(now: Date, days: number): string {
  const d = new Date(now);
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

export async function runDeductibleResetPush(
  now: Date = new Date(),
): Promise<DeductibleResetStats> {
  const stats: DeductibleResetStats = {
    candidates: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    outOfWindow: false,
  };

  if (now.getUTCMonth() + 1 !== SEND_MONTH) {
    stats.outOfWindow = true;
    return stats;
  }

  const currentYear = now.getUTCFullYear();
  const supabase = getSupabaseServiceRoleClient();
  const activitySince = isoDaysAgo(now, ACTIVE_LOOKBACK_DAYS);

  const { data: candidates, error } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select(
      "customer_id, email_lower, display_name, communication_preferences, deductible_reset_year",
    )
    .or(
      `deductible_reset_year.is.null,deductible_reset_year.neq.${currentYear}`,
    )
    .not("email_lower", "is", null)
    .limit(PER_RUN_MAX * 2);
  if (error) throw error;

  const rows: CustomerCandidate[] = (candidates ?? []).filter(
    (r): r is CustomerCandidate => typeof r.email_lower === "string",
  );

  for (const row of rows) {
    if (stats.sent >= PER_RUN_MAX) break;
    stats.candidates += 1;

    const prefs = readPrefs(row.communication_preferences);
    if (!shouldSendEmail(prefs, "marketing")) {
      stats.skipped += 1;
      continue;
    }

    // Active-customer gate: a paid order in the last 730 days.
    const { data: recent } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .select("paid_at")
      .eq("customer_id", row.customer_id)
      .eq("status", "paid")
      .gt("paid_at", activitySince)
      .limit(1);
    if (!recent || recent.length === 0) {
      stats.skipped += 1;
      continue;
    }

    // Atomic claim — stamp the year BEFORE the send. We only update
    // when the stored value is still null or last year's, so a race
    // against another worker resolves cleanly.
    const { data: claimed, error: claimErr } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .update({ deductible_reset_year: currentYear })
      .eq("customer_id", row.customer_id)
      .or(
        `deductible_reset_year.is.null,deductible_reset_year.neq.${currentYear}`,
      )
      .select("customer_id");
    if (claimErr) {
      logger.warn(
        { err: claimErr.message, customerId: row.customer_id },
        "shop-customers.deductible-reset: claim failed",
      );
      stats.failed += 1;
      continue;
    }
    if (!claimed || claimed.length === 0) {
      stats.skipped += 1;
      continue;
    }

    const firstName = (row.display_name ?? "").split(" ")[0]?.trim() || null;
    const releaseClaim = async (): Promise<void> => {
      const { error: releaseErr } = await supabase
        .schema("resupply")
        .from("shop_customers")
        .update({ deductible_reset_year: row.deductible_reset_year })
        .eq("customer_id", row.customer_id);
      if (releaseErr) {
        throw new Error(
          `Failed to release deductible_reset_year claim for customer ${row.customer_id}: ${releaseErr.message}`
        );
      }
    };

    try {
      const result = await sendDeductibleResetEmail({
        toEmail: row.email_lower,
        firstName,
      });
      if (!result.configured) {
        await releaseClaim();
        stats.skipped += 1;
        continue;
      }
      if (!result.delivered) {
        await releaseClaim();
        stats.failed += 1;
        logger.warn(
          { customerId: row.customer_id, err: result.error },
          "shop-customers.deductible-reset: send failed",
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
          customerId: row.customer_id,
        },
        "shop-customers.deductible-reset: send threw",
      );
    }
  }

  return stats;
}

export async function registerDeductibleResetPushJob(
  boss: PgBoss,
): Promise<void> {
  await boss.createQueue(JOB_NAME, buildQueueConfig(JOB_NAME, VENDOR_SEND_QUEUE_OPTS));

  await boss.work(JOB_NAME, async () => {
    try {
      const stats = await runDeductibleResetPush();
      logger.info(
        { event: "shop-customers.deductible-reset.completed", ...stats },
        stats.outOfWindow
          ? "shop-customers.deductible-reset: skipped (out of November window)"
          : "shop-customers.deductible-reset: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "shop-customers.deductible-reset: failed",
      );
      throw err;
    }
  });

  await boss.schedule(JOB_NAME, JOB_CRON);
  logger.info(
    { cron: JOB_CRON },
    "shop-customers.deductible-reset scheduled (active in November only)",
  );
}
