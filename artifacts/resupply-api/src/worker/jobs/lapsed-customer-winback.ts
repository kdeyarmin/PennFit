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
//   * has shipped or queued insurance resupply (fulfillment activity) OR
//     at least one historical paid shop order in the past 730 days
//     (legacy cash-pay rows — we never email a stale registration that
//     never received anything),
//   * has NOT had shipment/resupply activity in the past 180 days,
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
//
// Feature flag
// ------------
// Off by default. Set `RESUPPLY_LAPSED_CUSTOMER_WINBACK_CRON_ENABLED=1`
// to turn it on. Cash-pay storefront accounts are historical; a
// credentialed staging deploy must not auto-email lapsed shoppers.

import type PgBoss from "pg-boss";

import {
  DEFAULT_COMMUNICATION_PREFERENCES,
  type CommunicationPreferences,
  type Json,
  getOrgScopedClient,
} from "@workspace/resupply-db";
import {
  CUSTOMER_LAPSED_DAYS as LAPSED_DAYS,
  WINBACK_COOLDOWN_DAYS,
  CUSTOMER_ACTIVE_LOOKBACK_DAYS as STALE_REGISTRATION_DAYS,
} from "@workspace/resupply-domain";

import { sendWinbackEmail } from "../../lib/order-emails/send-winback-email";
import { shouldSendEmail } from "../../lib/comm-prefs";
import { logger } from "../../lib/logger";
import { resolvePatientIdForCustomer } from "../../lib/shop-customer/resolve-patient";
import { forEachActiveOrg } from "../lib/for-each-active-org.js";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";

const JOB_NAME = "shop-customers.winback";
const JOB_CRON = "17 13 * * 1"; // Mondays at 13:17 UTC.

// Recency windows (LAPSED_DAYS / WINBACK_COOLDOWN_DAYS /
// STALE_REGISTRATION_DAYS) are shared with the deductible-reset push via
// @workspace/resupply-domain so the 730-day "active" lookback can't drift
// between the two jobs.
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

type FulfillmentActivityRow = {
  shipped_at: string | null;
  delivered_at: string | null;
  created_at: string;
};

type ShopOrderActivityRow = {
  paid_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  created_at: string;
};

function activityIsoFromFulfillment(row: FulfillmentActivityRow): string {
  return row.delivered_at ?? row.shipped_at ?? row.created_at;
}

function activityIsoFromShopOrder(row: ShopOrderActivityRow): string {
  return row.delivered_at ?? row.shipped_at ?? row.paid_at ?? row.created_at;
}

/**
 * Most recent resupply/shipment activity for a signed-in shop customer.
 * Insurance patients resolve through fulfillments; legacy cash-pay rows
 * still contribute via shop_orders. Returns null when the customer never
 * received anything we can measure.
 */
export async function resolveLastCustomerShipmentActivityIso(
  supabase: ReturnType<typeof getOrgScopedClient>,
  customerId: string,
): Promise<string | null> {
  const patientId = await resolvePatientIdForCustomer(supabase, customerId);
  const activities: string[] = [];

  if (patientId) {
    const { data, error } = await supabase
      .from("fulfillments")
      .select("shipped_at, delivered_at, created_at")
      .eq("patient_id", patientId)
      .not("status", "in", "(cancelled,canceled)")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data) {
      activities.push(
        activityIsoFromFulfillment(data as FulfillmentActivityRow),
      );
    }
  }

  const { data: lastShopOrder, error: shopErr } = await supabase
    .from("shop_orders")
    .select("paid_at, shipped_at, delivered_at, created_at")
    .eq("customer_id", customerId)
    .eq("status", "paid")
    .order("paid_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (shopErr) throw shopErr;
  if (lastShopOrder) {
    activities.push(
      activityIsoFromShopOrder(lastShopOrder as ShopOrderActivityRow),
    );
  }

  if (activities.length === 0) return null;
  return activities.reduce((max, iso) => (iso > max ? iso : max));
}

/**
 * Rollback helper: clear the winback_sent_at stamp for a customer.
 * Throws on Supabase failure so the error propagates to the caller.
 */
async function rollbackWinbackStamp(
  orgId: string,
  customerId: string,
  winbackSentAt: string | null,
): Promise<void> {
  const supabase = getOrgScopedClient(orgId);
  const { error } = await supabase
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
 * Exported for testability. Fans out across every ACTIVE tenant —
 * `shop_customers` / `shop_orders` are org-scoped, so each tenant is
 * swept on its own org-scoped client and a win-back email only ever
 * reaches a shopper in that customer's own org. Per-tenant failure
 * isolation keeps one tenant's error from aborting the rest; the stats
 * are summed across tenants. Single-tenant: `listActiveOrgIds()` returns
 * just the seed org, so this is exactly the prior one-tenant sweep.
 */
export async function runLapsedCustomerWinback(): Promise<WinbackStats> {
  const stats: WinbackStats = {
    candidates: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
  };
  await forEachActiveOrg(
    async (orgId) => {
      await winbackSweepForOrg(orgId, stats);
    },
    { jobName: JOB_NAME },
  );
  return stats;
}

/**
 * Run the win-back sweep for a SINGLE tenant, accumulating into the shared
 * `stats`. The PER_RUN_MAX send cap and MAX_SCANNED_PER_RUN scan cap are
 * tracked per tenant (local counters) so a busy tenant can't starve the
 * others out of their weekly send budget.
 */
async function winbackSweepForOrg(
  orgId: string,
  stats: WinbackStats,
): Promise<void> {
  const supabase = getOrgScopedClient(orgId);

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
  // Per-tenant send counter — the PER_RUN_MAX budget is each tenant's, not
  // shared, so one tenant's backlog never starves another's win-backs.
  let sentThisOrg = 0;
  pages: while (sentThisOrg < PER_RUN_MAX && scanned < MAX_SCANNED_PER_RUN) {
    let query = supabase
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
    const rows: WinbackCandidate[] = (
      candidates as Array<
        Omit<WinbackCandidate, "email_lower"> & { email_lower: string | null }
      >
    ).filter((r): r is WinbackCandidate => typeof r.email_lower === "string");

    for (const row of rows) {
      if (sentThisOrg >= PER_RUN_MAX) break pages;
      stats.candidates += 1;

      const prefs = readPrefs(row.communication_preferences);
      if (!shouldSendEmail(prefs, "marketing")) {
        stats.skipped += 1;
        continue;
      }

      // 2. Per-customer shipment-activity gate. Prefer insurance
      //    fulfillments when the email resolves to a patient chart;
      //    fall back to historical shop_orders for legacy cash-pay.
      const last = await resolveLastCustomerShipmentActivityIso(
        supabase,
        row.customer_id,
      );
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
          orgId,
        });
        if (!result.configured) {
          await rollbackWinbackStamp(
            orgId,
            row.customer_id,
            row.winback_sent_at,
          );
          stats.skipped += 1;
          continue;
        }
        if (!result.delivered) {
          await rollbackWinbackStamp(
            orgId,
            row.customer_id,
            row.winback_sent_at,
          );
          stats.failed += 1;
          logger.warn(
            { customerId: row.customer_id, err: result.error },
            "shop-customers.winback: send failed",
          );
          continue;
        }
        stats.sent += 1;
        sentThisOrg += 1;
      } catch (err) {
        try {
          await rollbackWinbackStamp(
            orgId,
            row.customer_id,
            row.winback_sent_at,
          );
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
            err,
            customerId: row.customer_id,
          },
          "shop-customers.winback: send threw",
        );
      }
    }
    // Short page → no more candidates.
    if (candidates.length < PAGE) break;
  }
}

export async function registerLapsedCustomerWinbackJob(
  boss: PgBoss,
): Promise<void> {
  if (process.env.RESUPPLY_LAPSED_CUSTOMER_WINBACK_CRON_ENABLED !== "1") {
    logger.info(
      { event: "shop-customers.winback.disabled" },
      "shop-customers.winback: not registered (RESUPPLY_LAPSED_CUSTOMER_WINBACK_CRON_ENABLED!=1)",
    );
    if (typeof boss.unschedule === "function") {
      await boss.unschedule(JOB_NAME).catch(() => undefined);
    }
    return;
  }
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
