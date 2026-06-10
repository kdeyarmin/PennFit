// pg-boss job: lapsed-customer win-back dispatcher.
//
// Why this exists
// ---------------
// Customers who haven't ordered in 6+ months are the lowest-cost
// re-activation target available — they already know the brand,
// have an account, and often have a saved card. A tasteful "we miss
// you" with a low-friction reorder path recovers a double-digit
// percentage of lapsed customers in DME industry benchmarks. We
// were sending zero of these before this worker.
//
// Eligibility predicate
// ---------------------
// A shop_customers row is eligible when ALL of:
//
//   * communication_preferences.emailMarketing is true (or null,
//     which falls back to the default — we deliberately only send
//     when the customer has actively opted in; the dispatcher
//     looks at DEFAULT_COMMUNICATION_PREFERENCES.emailMarketing
//     to decide the default).
//   * email_lower is non-null (we need an address to send to).
//   * has shipped at least one paid order in the past 730 days
//     (so we don't email a stale registration that never paid),
//   * has NOT shipped any paid order in the past 180 days,
//   * winback_sent_at is NULL or older than 365 days (max one
//     win-back per customer per 12 months).
//
// Schedule
// --------
// Mondays at 13:17 UTC — sequenced after the maintenance-nudges
// weekly cron (Sun 11:13) and well clear of every daily cron. We
// limit the per-run batch to a soft cap so a backlog of newly-
// eligible customers doesn't single-day-burst the SendGrid quota
// in regions with rate caps.

import type PgBoss from "pg-boss";

import {
  DEFAULT_COMMUNICATION_PREFERENCES,
  type CommunicationPreferences,
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { sendWinbackEmail } from "../../lib/order-emails/send-winback-email";
import { shouldSendEmail } from "../../lib/comm-prefs";
import { logger } from "../../lib/logger";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";

const JOB_NAME = "shop-customers.winback";
const JOB_CRON = "17 13 * * 1"; // Mondays at 13:17 UTC.

/** No-order window that makes a customer "lapsed." */
const LAPSED_DAYS = 180;
/** Don't re-win-back the same customer within 12 months. */
const WINBACK_COOLDOWN_DAYS = 365;
/** Ignore customers whose last paid order is older than this — they
 *  are stale registrations the win-back wouldn't help recover. */
const STALE_REGISTRATION_DAYS = 730;
/** Soft per-run cap so a backlog doesn't burst the email quota. */
const PER_RUN_MAX = 200;

export interface WinbackStats {
  candidates: number;
  sent: number;
  skipped: number;
  failed: number;
}

interface WinbackCandidate {
  customer_id: string;
  email_lower: string;
  display_name: string | null;
  communication_preferences: Json | null;
  winback_sent_at: string | null;
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

/**
 * Rollback helper: clear the winback_sent_at stamp for a customer.
 * Throws on Supabase failure so the error propagates to the caller.
 */
async function rollbackWinbackStamp(
  customerId: string,
  winbackSentAt: string | null,
): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  const { error } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .update({ winback_sent_at: winbackSentAt })
    .eq("customer_id", customerId);
  if (error) {
    throw new Error(
      `Failed to rollback winback_sent_at for customer ${customerId}: ${error.message}`,
    );
  }
}

/**
 * Exported for testability. Pure DB + send work.
 */
export async function runLapsedCustomerWinback(): Promise<WinbackStats> {
  const supabase = getSupabaseServiceRoleClient();
  const stats: WinbackStats = {
    candidates: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
  };

  const lapsedThreshold = isoDaysAgo(LAPSED_DAYS);
  const cooldownThreshold = isoDaysAgo(WINBACK_COOLDOWN_DAYS);
  const stalenessThreshold = isoDaysAgo(STALE_REGISTRATION_DAYS);

  // 1. Walk the candidate set in deterministic keyset pages. Skipped
  //    rows (never-paid registrations, stale registrations, opt-outs)
  //    are never stamped, so they match the cooldown filter again on
  //    every run — with a single unordered LIMIT slate, more than one
  //    page of such rows at the front of the physical order starved
  //    every genuinely lapsed customer behind them forever. Keeping
  //    the SELECT lean — no JSON, no order joins — keeps the DB hit
  //    cheap; the per-customer gates (order history, comm-prefs)
  //    short-circuit inside the loop. MAX_SCANNED_PER_RUN bounds a
  //    pathological dead cohort so the weekly job can't run unbounded.
  const PAGE = PER_RUN_MAX * 2;
  const MAX_SCANNED_PER_RUN = PER_RUN_MAX * 50;
  let lastCustomerId: string | null = null;
  let scanned = 0;
  pages: while (stats.sent < PER_RUN_MAX && scanned < MAX_SCANNED_PER_RUN) {
    let query = supabase
      .schema("resupply")
      .from("shop_customers")
      .select(
        "customer_id, email_lower, display_name, communication_preferences, winback_sent_at",
      )
      .or(`winback_sent_at.is.null,winback_sent_at.lt.${cooldownThreshold}`)
      .not("email_lower", "is", null)
      .order("customer_id", { ascending: true })
      .limit(PAGE);
    if (lastCustomerId !== null) {
      query = query.gt("customer_id", lastCustomerId);
    }
    const { data: candidates, error } = await query;
    if (error) throw error;
    if (!candidates || candidates.length === 0) break;
    scanned += candidates.length;
    lastCustomerId = candidates[candidates.length - 1]!.customer_id;
    const rows: WinbackCandidate[] = candidates.filter(
      (r): r is WinbackCandidate => typeof r.email_lower === "string",
    );

    for (const row of rows) {
      if (stats.sent >= PER_RUN_MAX) break pages;
      stats.candidates += 1;

      const prefs = readPrefs(row.communication_preferences);
      if (!shouldSendEmail(prefs, "marketing")) {
        stats.skipped += 1;
        continue;
      }

      // 2. Per-customer order-history gate. Two queries; could be one
      //    with a CASE expression but PostgREST doesn't support raw
      //    CASE in select(). Both reads hit the existing
      //    shop_orders(customer_id, paid_at) index.
      const { data: lastOrder } = await supabase
        .schema("resupply")
        .from("shop_orders")
        .select("paid_at")
        .eq("customer_id", row.customer_id)
        .eq("status", "paid")
        .not("paid_at", "is", null)
        .order("paid_at", { ascending: false })
        .limit(1);

      const last = lastOrder?.[0]?.paid_at ?? null;
      // Never ordered → skip (these are stale registrations).
      if (!last) {
        stats.skipped += 1;
        continue;
      }
      // Last order more than STALE_REGISTRATION_DAYS ago → skip.
      if (last < stalenessThreshold) {
        stats.skipped += 1;
        continue;
      }
      // Last order more recent than LAPSED_DAYS → still active.
      if (last > lapsedThreshold) {
        stats.skipped += 1;
        continue;
      }

      // 3. Compute "approximately N months since last order" for the
      //    email body. Floor to whole months so we don't say "5.7 months."
      const monthsSince = Math.max(
        6,
        Math.floor(
          (Date.now() - new Date(last).getTime()) / (1000 * 60 * 60 * 24 * 30),
        ),
      );

      // 4. Atomic claim — stamp winback_sent_at BEFORE the send so a
      //    crash mid-send doesn't double-email. If the SendGrid call
      //    then fails, we release the claim so the next weekly run
      //    can retry.
      const claimIso = new Date().toISOString();
      const { data: claimed, error: claimErr } = await supabase
        .schema("resupply")
        .from("shop_customers")
        .update({ winback_sent_at: claimIso })
        .eq("customer_id", row.customer_id)
        .or(`winback_sent_at.is.null,winback_sent_at.lt.${cooldownThreshold}`)
        .select("customer_id");
      if (claimErr) {
        logger.warn(
          { err: claimErr.message, customerId: row.customer_id },
          "shop-customers.winback: claim failed",
        );
        stats.failed += 1;
        continue;
      }
      if (!claimed || claimed.length === 0) {
        // Lost race or already stamped after we read.
        stats.skipped += 1;
        continue;
      }

      const firstName = (row.display_name ?? "").split(" ")[0]?.trim() || null;
      try {
        const result = await sendWinbackEmail({
          toEmail: row.email_lower,
          firstName,
          monthsSinceLastOrder: monthsSince,
        });
        if (!result.configured) {
          await rollbackWinbackStamp(row.customer_id, row.winback_sent_at);
          stats.skipped += 1;
          continue;
        }
        if (!result.delivered) {
          await rollbackWinbackStamp(row.customer_id, row.winback_sent_at);
          stats.failed += 1;
          logger.warn(
            { customerId: row.customer_id, err: result.error },
            "shop-customers.winback: send failed",
          );
          continue;
        }
        stats.sent += 1;
      } catch (err) {
        try {
          await rollbackWinbackStamp(row.customer_id, row.winback_sent_at);
        } catch (rollbackErr) {
          logger.error(
            {
              err:
                rollbackErr instanceof Error
                  ? rollbackErr.message
                  : String(rollbackErr),
              customerId: row.customer_id,
            },
            "shop-customers.winback: rollback failed — winback_sent_at may remain claimed",
          );
        }
        stats.failed += 1;
        logger.error(
          {
            err: err instanceof Error ? err.message : String(err),
            customerId: row.customer_id,
          },
          "shop-customers.winback: send threw",
        );
      }
    }
    // Short page → no more candidates.
    if (candidates.length < PAGE) break;
  }

  return stats;
}

export async function registerLapsedCustomerWinbackJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(boss, JOB_NAME, VENDOR_SEND_QUEUE_OPTS);

  await boss.work(JOB_NAME, async () => {
    try {
      const stats = await runLapsedCustomerWinback();
      logger.info(
        { event: "shop-customers.winback.completed", ...stats },
        "shop-customers.winback: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "shop-customers.winback: failed",
      );
      throw err;
    }
  });

  await boss.schedule(JOB_NAME, JOB_CRON);
  logger.info({ cron: JOB_CRON }, "shop-customers.winback scheduled");
}
